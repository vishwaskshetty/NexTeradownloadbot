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
    const { jobId, url, userId, fsId } = job.data;
    const jobRecord = await jobService.getJobWithUser(jobId);
    const user = jobRecord?.user;
    const telegramId = user?.telegramId?.toString();
    
    let tempFilePath: string | null = null;

    try {
      if (!user) {
        throw new Error(`User associated with job ${jobId} not found.`);
      }

      // Re-verify daily limit before proceeding to download
      const currentUsage = await usageService.getUsage(user.id);
      const dailyLimit = await usageService.getDailyLimit(user.plan);
      if (currentUsage.dailyRequests >= dailyLimit) {
        throw new ProviderError(`🚫 Daily limit reached (${dailyLimit} downloads/day). Limit was reached while waiting in queue.`);
      }

      // QUEUED -> PROCESSING
      await jobService.updateJobStatus(jobId, 'PROCESSING');
      
      const providerInfo = providerRegistry.detectAdapter(url);
      if (!providerInfo) {
        throw new Error('Provider not found for the given URL.');
      }
      
      const adapter = providerInfo.adapter;
      
      // Notify Telegram user about resolving
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, `🔎 _Resolving link via ${adapter.name}..._`, { parse_mode: 'Markdown' }); } catch(e){}
      }

      // Check PostgreSQL StoredFile Cache
      const cacheKeyStr = fsId ? `${url}#fs_${fsId}` : url;
      const urlHash = crypto.createHash('sha256').update(cacheKeyStr).digest('hex');
      const cachedFile = await db.storedFile.findUnique({ where: { urlHash } });

      if (cachedFile && cachedFile.expiresAt > new Date()) {
        logger.info(`⚡ Cache hit! Reusing telegramFileId: ${cachedFile.telegramFileId}`);
        if (telegramId) {
          try { await bot.telegram.sendMessage(telegramId, `⚡ _File found in cache. Sending instantly..._`, { parse_mode: 'Markdown' }); } catch(e){}
        }

        // PROCESSING -> FILE_READY -> SENDING
        await jobService.updateJobStatus(jobId, 'FILE_READY');
        await jobService.updateJobStatus(jobId, 'SENDING');

        // Deliver cached file to user
        await withRetry(async () => {
          await bot.telegram.sendDocument(telegramId!, cachedFile.telegramFileId, {
            caption: `✅ Download completed!\n🔗 Provider: ${adapter.name}\n⚡ Fast Cached Delivery`
          });
        }, 3);

        // ATOMIC & IDEMPOTENT COMPLETION: Increments usage ONLY ONCE upon successful delivery
        await jobService.completeJob(jobId, cachedFile.fileSize || 0n);
        const updatedUsage = await usageService.getUsage(user.id);
        const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

        const successMsg =
          `✅ *DOWNLOAD COMPLETE*\n\n` +
          `📁 File: \`${cachedFile.fileName}\`\n` +
          `📦 Size: ${formatBytes(cachedFile.fileSize || 0n)}\n\n` +
          `Your download has been successfully completed.\n\n` +
          `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
          `📥 Remaining: ${remaining}`;

        if (telegramId) {
          try { await bot.telegram.sendMessage(telegramId, successMsg, { parse_mode: 'Markdown' }); } catch(e){}
        }
        return; // Job is fully done
      }

      // Resolve the direct link for single or selected multi-file item
      const adapterInstance = adapter as any;
      const resolvedFile = typeof adapterInstance.resolveSelectedFile === 'function'
        ? await adapterInstance.resolveSelectedFile(url, fsId)
        : await adapter.resolve(url);
      
      // Notify about download
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, `📄 *File found*\n📦 Size: ${formatBytes(resolvedFile.fileSize)}\n⬇️ _Downloading..._`, { parse_mode: 'Markdown' }); } catch(e){}
      }

      // Download file to temp
      tempFilePath = path.join(os.tmpdir(), `nextera_${jobId}_${Date.now()}`);
      await withRetry(() => downloadFile(resolvedFile.downloadUrl, tempFilePath!), 3);

      // Status: PROCESSING -> FILE_READY
      await jobService.updateJobStatus(jobId, 'FILE_READY');

      // Notify about upload
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, `📤 _Uploading to Telegram..._`, { parse_mode: 'Markdown' }); } catch(e){}
      }

      const filename = resolvedFile.fileName || 'downloaded_file';
      let sentToUser: any = null;

      // Status: FILE_READY -> SENDING
      await jobService.updateJobStatus(jobId, 'SENDING');

      // Upload file to telegram (Storage channel cache or direct to user)
      if (config.STORAGE_CHANNEL_ID) {
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
          // Send to user using cached ID
          sentToUser = await withRetry(async () => {
             return await bot.telegram.sendDocument(telegramId!, telegramFileId, {
               caption: `✅ Download completed!\n🔗 Provider: ${adapter.name}`
             });
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
              status: 'ACTIVE'
            },
            create: {
              urlHash,
              telegramFileId,
              telegramMessageId: storedMessage.message_id,
              expiresAt,
              fileName: filename,
              fileSize: resolvedFile.fileSize,
              status: 'ACTIVE'
            }
          });
        }
      } 
      
      // If we didn't send via Cache, upload directly to user
      if (!sentToUser) {
        await withRetry(async () => {
          await bot.telegram.sendDocument(telegramId!, {
            source: tempFilePath!,
            filename
          }, {
            caption: `✅ Download completed!\n🔗 Provider: ${adapter.name}`
          });
        }, 3);
      }

      // ATOMIC & IDEMPOTENT COMPLETION: Increments usage ONLY ONCE upon successful delivery
      await jobService.completeJob(jobId, BigInt(resolvedFile.fileSize || 0));

      const updatedUsage = await usageService.getUsage(user.id);
      const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

      const successMsg =
        `✅ *DOWNLOAD COMPLETE*\n\n` +
        `📁 File: \`${filename}\`\n` +
        `📦 Size: ${formatBytes(resolvedFile.fileSize)}\n\n` +
        `Your download has been successfully completed.\n\n` +
        `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
        `📥 Remaining: ${remaining}`;

      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, successMsg, { parse_mode: 'Markdown' }); } catch(e){}
      }

    } catch (error: any) {
      let userMsg =
        `❌ *DOWNLOAD FAILED*\n\n` +
        `The file could not be delivered.\n\n` +
        `Your daily download limit was NOT used.\n\n` +
        `You can try again with another valid link.`;

      if (error instanceof ProviderAccessError) {
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
      
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, userMsg, { parse_mode: 'Markdown' }); } catch(e){}
      }
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
