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
  if (!num || num === 0) return '0 B';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Validates downloaded local file integrity:
 * Verifies file exists, actual size is at least 1 KB, content is not HTML/JSON error page,
 * and actual size matches expected provider metadata.
 */
export interface ValidationResult {
  valid: boolean;
  actualSize: number;
  reason?: string;
}

export const validateDownloadedFile = async (
  filePath: string,
  expectedSize?: number
): Promise<ValidationResult> => {
  if (!fs.existsSync(filePath)) {
    return { valid: false, actualSize: 0, reason: 'Temporary file does not exist' };
  }

  const stat = fs.statSync(filePath);
  const actualSize = stat.size;

  // 1. Minimum size guard (e.g. 117 B response is rejected)
  if (actualSize < 1024) {
    return {
      valid: false,
      actualSize,
      reason: `File size too small (${actualSize} B). Minimum required is 1024 B.`
    };
  }

  // 2. Read first 512 bytes to inspect magic header content
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(512);
  const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
  fs.closeSync(fd);

  const headerStr = buffer.toString('utf8', 0, bytesRead).trim();

  if (
    headerStr.startsWith('{"errno"') ||
    headerStr.startsWith('{"error"') ||
    headerStr.startsWith('{"status"') ||
    headerStr.startsWith('{"msg"') ||
    headerStr.toLowerCase().startsWith('<!doctype') ||
    headerStr.toLowerCase().startsWith('<html') ||
    headerStr.toLowerCase().startsWith('<body') ||
    headerStr.includes('Access Denied') ||
    headerStr.includes('Unauthorized')
  ) {
    return {
      valid: false,
      actualSize,
      reason: `Downloaded content is an HTML/JSON error page rather than a valid file (${actualSize} B).`
    };
  }

  // 3. Expected vs Actual size match (if expected size > 10 MB and actual size < 50% expected)
  if (expectedSize && expectedSize > 10 * 1024 * 1024) {
    if (actualSize < 0.5 * expectedSize) {
      return {
        valid: false,
        actualSize,
        reason: `Downloaded file size (${formatBytes(actualSize)}) is dramatically smaller than provider metadata (${formatBytes(expectedSize)}).`
      };
    }
  }

  return { valid: true, actualSize };
};

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

/**
 * Downloads direct URL to disk via stream with progress logging & custom headers.
 * Streams first to a temporary .part file, then renames to final destination file.
 */
const downloadFileStream = async (
  url: string,
  destPath: string,
  headers?: Record<string, string>
): Promise<number> => {
  const partPath = `${destPath}.part`;
  logger.info(`[Download] Starting stream download to ${partPath}`);

  const requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.terabox.app/',
    'Accept': '*/*',
    ...(headers || {})
  };

  if (config.TERABOX_NDUS && !requestHeaders['Cookie']) {
    requestHeaders['Cookie'] = `ndus=${config.TERABOX_NDUS}`;
  }

  const writer = fs.createWriteStream(partPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 60000,
    headers: requestHeaders,
    maxRedirects: 5,
  });

  logger.info(`[Download] HTTP status: ${response.status}`);

  let downloadedBytes = 0;
  let lastLoggedMb = 0;

  response.data.on('data', (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    const mb = Math.floor(downloadedBytes / (50 * 1024 * 1024)) * 50;
    if (mb > lastLoggedMb) {
      logger.info(`[Download] Received: ${formatBytes(downloadedBytes)}`);
      lastLoggedMb = mb;
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      logger.info(`[Download] Stream completed (${formatBytes(downloadedBytes)})`);
      try {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        fs.renameSync(partPath, destPath);
        resolve(downloadedBytes);
      } catch (renameErr) {
        reject(renameErr);
      }
    });
    writer.on('error', (err) => {
      logger.error(`[Download] Stream error: ${err.message}`);
      if (fs.existsSync(partPath)) {
        try { fs.unlinkSync(partPath); } catch (e) {}
      }
      reject(err);
    });
  });
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
        await sendMediaToTelegram(
          telegramId!,
          cachedFile.telegramFileId,
          cachedFile.fileName,
          `✅ Download completed!\n🔗 Provider: ${adapter.name}\n⚡ Fast Cached Delivery`,
          cachedFile.mimeType || undefined
        );

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

      // Retry Loop with Fresh URL Resolution & Strict File Validation
      let resolvedFile: any = null;
      let validation: ValidationResult = { valid: false, actualSize: 0 };
      const maxRetries = 3;
      const tmpDir = path.join(os.tmpdir(), 'nexterabox');
      if (!fs.existsSync(tmpDir)) {
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
      }

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        logger.info(`[Download] Attempt ${attempt}/${maxRetries} starting...`);

        // Resolve direct link for single or selected multi-file item
        const adapterInstance = adapter as any;
        resolvedFile = typeof adapterInstance.resolveSelectedFile === 'function'
          ? await adapterInstance.resolveSelectedFile(url, fsId)
          : await adapter.resolve(url);

        const filename = resolvedFile.fileName || 'downloaded_file';
        const expectedSize = resolvedFile.fileSize;

        // Update single status message: File found & Downloading
        await updateStatusMessage(
          `📄 *File found*\n` +
          `📁 \`${filename}\`\n` +
          `📦 ${formatBytes(expectedSize)}\n\n` +
          `⬇️ *Downloading...* (Attempt ${attempt}/${maxRetries})`
        );

        // Prepare safe temp file path
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }
        const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
        tempFilePath = path.join(tmpDir, `${jobId}_${attempt}_${safeName}`);

        try {
          await downloadFileStream(resolvedFile.downloadUrl, tempFilePath, resolvedFile.headers);
        } catch (dlErr: any) {
          logger.warn(`[Download] Stream attempt ${attempt} failed: ${dlErr.message}`);
        }

        // Strict File Validation Check
        validation = await validateDownloadedFile(tempFilePath, expectedSize);

        if (validation.valid) {
          logger.info(`[Validation] Expected: ${formatBytes(expectedSize)}, Actual: ${formatBytes(validation.actualSize)}, Integrity: OK`);
          break; // File is valid! Exit retry loop
        } else {
          logger.error(`[Validation] Expected: ${formatBytes(expectedSize)}, Actual: ${formatBytes(validation.actualSize)}, Integrity: FAILED (${validation.reason}). Retrying fresh URL ${attempt}/${maxRetries}...`);
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
          }
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
          }
        }
      }

      // If all 3 attempts failed validation: abort job without sending file or incrementing usage
      if (!validation.valid) {
        throw new ProviderError(`Validation failed: ${validation.reason || 'File integrity check failed.'}`);
      }

      const filename = resolvedFile.fileName || 'downloaded_file';
      const actualSize = validation.actualSize;

      // Status: PROCESSING -> FILE_READY
      await jobService.updateJobStatus(jobId, 'FILE_READY');

      // Update single status message: Uploading
      await updateStatusMessage(
        `📤 *Uploading to Telegram...*\n\n` +
        `📁 \`${filename}\`\n` +
        `📦 ${formatBytes(actualSize)}`
      );

      let sentToUser: any = null;

      // Status: FILE_READY -> SENDING
      await jobService.updateJobStatus(jobId, 'SENDING');

      // Upload file to Telegram storage channel cache if configured
      if (config.STORAGE_CHANNEL_ID) {
        try {
          logger.info(`[Telegram] Uploading actual file (${formatBytes(actualSize)}) to storage channel...`);
          const storedMessage = await bot.telegram.sendDocument(config.STORAGE_CHANNEL_ID!, {
            source: tempFilePath!,
            filename
          }, {
            caption: `Source: ${url}`
          });

          const telegramFileId = storedMessage.document?.file_id;
          if (telegramFileId) {
            logger.info(`[Telegram] Storage upload successful. File ID: ${telegramFileId.substring(0, 10)}...`);
            // Send to user using cached telegramFileId and smart media helper
            sentToUser = await sendMediaToTelegram(
              telegramId!,
              telegramFileId,
              filename,
              `✅ Download completed!\n🔗 Provider: ${adapter.name}`,
              resolvedFile.mimeType
            );

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
                fileSize: BigInt(actualSize),
                mimeType: resolvedFile.mimeType,
                status: 'ACTIVE'
              },
              create: {
                urlHash,
                telegramFileId,
                telegramMessageId: storedMessage.message_id,
                expiresAt,
                fileName: filename,
                fileSize: BigInt(actualSize),
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
        logger.info(`[Telegram] Uploading actual file (${formatBytes(actualSize)}) directly to user ${telegramId}...`);
        sentToUser = await sendMediaToTelegram(
          telegramId!,
          { source: tempFilePath!, filename },
          filename,
          `✅ Download completed!\n🔗 Provider: ${adapter.name}`,
          resolvedFile.mimeType
        );
        logger.info(`[Telegram] Direct upload successful.`);
      }

      // ATOMIC COMPLETION: Increments daily usage ONLY AFTER successful file delivery to user
      await jobService.completeJob(jobId, BigInt(actualSize));
      logger.info(`[Usage] Download completed and counted for user ${user.id}.`);

      const updatedUsage = await usageService.getUsage(user.id);
      const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

      // Final edit to the same single status message: Download Complete
      const finalSuccessMsg =
        `✅ *DOWNLOAD COMPLETE*\n\n` +
        `📁 File: \`${filename}\`\n` +
        `📦 Size: ${formatBytes(actualSize)}\n` +
        `⚡ Provider: ${adapter.name}\n\n` +
        `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
        `📥 Remaining: ${remaining}`;

      await updateStatusMessage(finalSuccessMsg);

    } catch (error: any) {
      const isUploadError = error.message?.includes('sendVideo') || error.message?.includes('sendAudio') || error.message?.includes('sendDocument') || error.message?.includes('sendPhoto');
      
      let userMsg =
        `❌ *DOWNLOAD FAILED*\n\n` +
        `🔗 Source: TeraBox\n\n` +
        `⚠️ ${error.message || 'Unable to download this file completely.'}\n\n` +
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
      if (tempFilePath) {
        const partPath = `${tempFilePath}.part`;
        if (fs.existsSync(partPath)) {
          try { fs.unlinkSync(partPath); } catch (e) {}
        }
        if (fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
            logger.info(`🧹 Cleaned up temporary file ${tempFilePath}`);
          } catch (e: any) {
            logger.error(`Failed to delete temp file ${tempFilePath}: ${e.message}`);
          }
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
