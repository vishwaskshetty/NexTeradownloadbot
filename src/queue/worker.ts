import { Worker, Job } from 'bullmq';
import { redis } from '../redis';
import { db } from '../db';
import { jobService } from '../services/JobService';
import { usageService } from '../services/UsageService';
import { providerRegistry } from '../providers';
import { ProviderError, ProviderAccessError } from '../providers/errors';
import { logger } from '../utils/logger';
import { bot } from '../bot';
import { config } from '../config';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let downloadWorker: Worker | null = null;

function formatBytes(bytes: number | bigint): string {
  const num = Number(bytes);
  if (!num || num === 0) return 'Unknown size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Smart media detection helper:
 * Selects the appropriate Telegram media method (sendVideo, sendAudio, sendPhoto, sendDocument)
 * based on original file extension and MIME type.
 * Automatically falls back to sendDocument if Telegram fails to process as native media.
 */
const sendMediaToTelegram = async (
  telegramId: string,
  mediaSource: string | { source: string; filename: string },
  filename: string,
  caption?: string,
  mimeType?: string
) => {
  const ext = path.extname(filename).toLowerCase();

  const videoExts = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.3gp'];
  const audioExts = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'];
  const photoExts = ['.jpg', '.jpeg', '.png', '.webp'];

  let targetType: 'video' | 'audio' | 'photo' | 'document' = 'document';
  if (videoExts.includes(ext) || (mimeType && mimeType.startsWith('video/'))) {
    targetType = 'video';
  } else if (audioExts.includes(ext) || (mimeType && mimeType.startsWith('audio/'))) {
    targetType = 'audio';
  } else if (photoExts.includes(ext) || (mimeType && mimeType.startsWith('image/'))) {
    targetType = 'photo';
  }

  const extraOptions = {
    caption,
    parse_mode: 'Markdown' as const,
  };

  if (targetType === 'video') {
    try {
      return await bot.telegram.sendVideo(telegramId, mediaSource, extraOptions);
    } catch (videoErr: any) {
      logger.warn(`sendVideo failed for ${filename}, falling back to sendDocument: ${videoErr.message}`);
      return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
    }
  }

  if (targetType === 'audio') {
    try {
      return await bot.telegram.sendAudio(telegramId, mediaSource, extraOptions);
    } catch (audioErr: any) {
      logger.warn(`sendAudio failed for ${filename}, falling back to sendDocument: ${audioErr.message}`);
      return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
    }
  }

  if (targetType === 'photo') {
    try {
      return await bot.telegram.sendPhoto(telegramId, mediaSource, extraOptions);
    } catch (photoErr: any) {
      logger.warn(`sendPhoto failed for ${filename}, falling back to sendDocument: ${photoErr.message}`);
      return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
    }
  }

  return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
};

const downloadFile = async (url: string, destPath: string): Promise<void> => {
  const writer = fs.createWriteStream(destPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 30000,
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

const withRetry = async <T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      const delayMs = attempt === 1 ? 2000 : attempt === 2 ? 5000 : 10000;
      logger.warn(`Attempt ${attempt} failed, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Unreachable');
};

export const initWorker = () => {
  if (downloadWorker) return;
  
  const processJob = async (job: Job) => {
    const { jobId, url, userId, fsId, statusMessageId } = job.data;
    const jobRecord = await jobService.getJobWithUser(jobId);
    const user = jobRecord?.user;
    const telegramId = user?.telegramId?.toString();
    
    let tempFilePath: string | null = null;

    // SINGLE STATUS MESSAGE EDITING HELPER
    const updateStatusMessage = async (text: string, keyboard?: any) => {
      if (!telegramId || !statusMessageId) return;
      try {
        await bot.telegram.editMessageText(telegramId, statusMessageId, undefined, text, {
          parse_mode: 'Markdown',
          ...(keyboard || {})
        });
      } catch (err: any) {
        if (!err.message?.includes('message is not modified') && !err.message?.includes('message to edit not found')) {
          logger.warn(`Could not edit status message ${statusMessageId}: ${err.message}`);
        }
      }
    };

    try {
      if (!user) {
        throw new Error(`User associated with job ${jobId} not found.`);
      }

      // Re-verify daily limit before proceeding to download
      const currentUsage = await usageService.getUsage(user.id);
      const dailyLimit = await usageService.getDailyLimit(user.plan);
      if (currentUsage.dailyRequests >= dailyLimit) {
        await updateStatusMessage(`🚫 *Daily limit reached.*\n\nFree users: ${config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config.PREMIUM_DAILY_LIMIT} downloads/day.\n\nNo usage was consumed.`);
        throw new ProviderError(`🚫 Daily limit reached (${dailyLimit} downloads/day).`);
      }

      // QUEUED -> PROCESSING
      await jobService.updateJobStatus(jobId, 'PROCESSING');
      
      const providerInfo = providerRegistry.detectAdapter(url);
      if (!providerInfo) {
        throw new Error('Provider not found for the given URL.');
      }
      
      const adapter = providerInfo.adapter;
      
      // Update single status message: Resolving
      await updateStatusMessage(
        `🔎 *Resolving link...*\n\n` +
        `🔗 Source: ${adapter.name}\n` +
        `⚡ Extracting file information...`
      );

      // Check PostgreSQL StoredFile Cache
      const cacheKeyStr = fsId ? `${url}#fs_${fsId}` : url;
      const urlHash = crypto.createHash('sha256').update(cacheKeyStr).digest('hex');
      const cachedFile = await db.storedFile.findUnique({ where: { urlHash } });

      if (cachedFile && cachedFile.expiresAt > new Date()) {
        logger.info(`⚡ Cache hit! Reusing telegramFileId: ${cachedFile.telegramFileId}`);
        
        await updateStatusMessage(
          `📄 *File found*\n` +
          `📁 \`${cachedFile.fileName}\`\n` +
          `📦 ${formatBytes(cachedFile.fileSize || 0n)}\n\n` +
          `⚡ _Sending cached file..._`
        );

        // PROCESSING -> FILE_READY -> SENDING
        await jobService.updateJobStatus(jobId, 'FILE_READY');
        await jobService.updateJobStatus(jobId, 'SENDING');

        // Deliver cached file to user using smart media type helper
        await withRetry(async () => {
          await sendMediaToTelegram(
            telegramId!,
            cachedFile.telegramFileId,
            cachedFile.fileName,
            `✅ Download completed!\n🔗 Provider: ${adapter.name}\n⚡ Fast Cached Delivery`,
            cachedFile.mimeType || undefined
          );
        }, 3);

        // ATOMIC & IDEMPOTENT COMPLETION: Increments usage ONLY ONCE upon successful delivery
        await jobService.completeJob(jobId, cachedFile.fileSize || 0n);
        const updatedUsage = await usageService.getUsage(user.id);
        const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

        const successMsg =
          `✅ *DOWNLOAD COMPLETE*\n\n` +
          `📁 File: \`${cachedFile.fileName}\`\n` +
          `📦 Size: ${formatBytes(cachedFile.fileSize || 0n)}\n` +
          `⚡ Provider: ${adapter.name}\n\n` +
          `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
          `📥 Remaining: ${remaining}`;

        await updateStatusMessage(successMsg);
        return; // Job is fully done
      }

      // Resolve direct link for single or selected multi-file item
      const adapterInstance = adapter as any;
      const resolvedFile = typeof adapterInstance.resolveSelectedFile === 'function'
        ? await adapterInstance.resolveSelectedFile(url, fsId)
        : await adapter.resolve(url);
      
      const filename = resolvedFile.fileName || 'downloaded_file';

      // Update single status message: File found & Downloading
      await updateStatusMessage(
        `📄 *File found*\n` +
        `📁 \`${filename}\`\n` +
        `📦 ${formatBytes(resolvedFile.fileSize)}\n\n` +
        `⬇️ *Downloading...*`
      );

      // Download file to temp directory
      tempFilePath = path.join(os.tmpdir(), `nextera_${jobId}_${Date.now()}_${filename}`);
      await withRetry(() => downloadFile(resolvedFile.downloadUrl, tempFilePath!), 3);

      // Status: PROCESSING -> FILE_READY
      await jobService.updateJobStatus(jobId, 'FILE_READY');

      // Update single status message: Uploading
      await updateStatusMessage(
        `📤 *Uploading to Telegram...*\n\n` +
        `📁 \`${filename}\`\n` +
        `📦 ${formatBytes(resolvedFile.fileSize)}`
      );

      let sentToUser: any = null;

      // Status: FILE_READY -> SENDING
      await jobService.updateJobStatus(jobId, 'SENDING');

      // Upload file to Telegram storage channel cache if configured
      if (config.STORAGE_CHANNEL_ID) {
        try {
          const storedMessage = await withRetry(async () => {
            return await bot.telegram.sendDocument(config.STORAGE_CHANNEL_ID!, {
              source: tempFilePath!,
              filename
            }, {
              caption: `Source: ${url}`
            });
          }, 3);

          const telegramFileId = storedMessage.document?.file_id;
          if (telegramFileId) {
            // Send to user using cached telegramFileId and smart media helper
            sentToUser = await withRetry(async () => {
              return await sendMediaToTelegram(
                telegramId!,
                telegramFileId,
                filename,
                `✅ Download completed!\n🔗 Provider: ${adapter.name}`,
                resolvedFile.mimeType
              );
            }, 3);

            // Save to PostgreSQL Cache
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + config.STORAGE_RETENTION_HOURS);
            
            await db.storedFile.upsert({
              where: { urlHash },
              update: {
                telegramFileId,
                telegramMessageId: storedMessage.message_id,
                expiresAt,
                fileName: filename,
                fileSize: resolvedFile.fileSize,
                mimeType: resolvedFile.mimeType,
                status: 'ACTIVE'
              },
              create: {
                urlHash,
                telegramFileId,
                telegramMessageId: storedMessage.message_id,
                expiresAt,
                fileName: filename,
                fileSize: resolvedFile.fileSize,
                mimeType: resolvedFile.mimeType,
                status: 'ACTIVE'
              }
            });
          }
        } catch (storageErr: any) {
          logger.warn(`Storage channel caching failed: ${storageErr.message}. Falling back to direct user upload.`);
        }
      } 
      
      // If direct user upload is needed
      if (!sentToUser) {
        sentToUser = await withRetry(async () => {
          return await sendMediaToTelegram(
            telegramId!,
            { source: tempFilePath!, filename },
            filename,
            `✅ Download completed!\n🔗 Provider: ${adapter.name}`,
            resolvedFile.mimeType
          );
        }, 3);
      }

      // ATOMIC COMPLETION: Increments daily usage ONLY AFTER successful file delivery to user
      await jobService.completeJob(jobId, BigInt(resolvedFile.fileSize || 0));

      const updatedUsage = await usageService.getUsage(user.id);
      const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

      // Final edit to the same single status message: Download Complete
      const finalSuccessMsg =
        `✅ *DOWNLOAD COMPLETE*\n\n` +
        `📁 File: \`${filename}\`\n` +
        `📦 Size: ${formatBytes(resolvedFile.fileSize)}\n` +
        `⚡ Provider: ${adapter.name}\n\n` +
        `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
        `📥 Remaining: ${remaining}`;

      await updateStatusMessage(finalSuccessMsg);

    } catch (error: any) {
      const isUploadError = error.message?.includes('sendVideo') || error.message?.includes('sendAudio') || error.message?.includes('sendDocument') || error.message?.includes('sendPhoto');
      
      let userMsg =
        `❌ *DOWNLOAD FAILED*\n\n` +
        `🔗 Source: ${url.substring(0, 30)}...\n\n` +
        `⚠️ ${error.message || 'Unable to download this file.'}\n\n` +
        `No usage was consumed.`;

      if (isUploadError) {
        userMsg =
          `❌ *UPLOAD FAILED*\n\n` +
          `⚠️ The file could not be delivered to Telegram.\n\n` +
          `📊 Usage was not consumed.`;
      } else if (error instanceof ProviderAccessError) {
        userMsg =
          `⚠️ *${error.providerName.toUpperCase()} ACCESS UNAVAILABLE*\n\n` +
          `This ${error.providerName} link requires an available official ${error.providerName} integration.\n\n` +
          `Your daily download limit was NOT used.`;
      }
      
      // Fail job without incrementing daily usage limit
      await jobService.failJob(jobId, error.message || 'Unknown error');
      if (user) {
        await usageService.recordFailedRequest(user.id);
      }
      logger.error(`Job ${jobId} failed: ${error.message}`);
      
      // Edit status message with failure notice
      await updateStatusMessage(userMsg);
    } finally {
      // Temporary file cleanup ALWAYS happens
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          logger.info(`🧹 Cleaned up temporary file ${tempFilePath}`);
        } catch (e: any) {
          logger.error(`Failed to delete temp file ${tempFilePath}: ${e.message}`);
        }
      }
    }
  };

  downloadWorker = new Worker('downloads', async (job: Job) => {
    const { config } = require('../config');
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Job timeout exceeded')), config.JOB_TIMEOUT_MS);
    });
    
    return Promise.race([
      processJob(job),
      timeoutPromise
    ]);
  }, { 
    connection: redis,
    concurrency: require('../config').config.WORKER_CONCURRENCY
  });

  downloadWorker.on('failed', (job, err) => {
    logger.error(`Worker failed job ${job?.id}: ${err.message}`);
  });

  logger.info('👷 BullMQ Download Worker started');
};

export const closeWorker = async () => {
  if (downloadWorker) {
    await downloadWorker.close();
  }
};
