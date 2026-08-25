import { Worker, Job } from 'bullmq';
import { redis } from '../redis';
import { db } from '../db';
import { jobService } from '../services/JobService';
import { providerRegistry } from '../providers';
import { ProviderError } from '../providers/errors';
import { logger } from '../utils/logger';
import { bot } from '../bot';
import { config } from '../config';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let downloadWorker: Worker | null = null;

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
    const { jobId, url, userId } = job.data;
    const telegramId = (await jobService.getJobWithUser(jobId))?.user?.telegramId?.toString();
    
    let tempFilePath: string | null = null;

    try {
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
      const urlHash = crypto.createHash('sha256').update(url).digest('hex');
      const cachedFile = await db.storedFile.findUnique({ where: { urlHash } });

      if (cachedFile && cachedFile.expiresAt > new Date()) {
        logger.info(`⚡ Cache hit! Reusing telegramFileId: ${cachedFile.telegramFileId}`);
        if (telegramId) {
          try { await bot.telegram.sendMessage(telegramId, `⚡ _File found in cache. Sending instantly..._`, { parse_mode: 'Markdown' }); } catch(e){}
        }

        await withRetry(async () => {
          await bot.telegram.sendDocument(telegramId!, cachedFile.telegramFileId, {
            caption: `✅ Download completed!\n🔗 Provider: ${adapter.name}\n⚡ Fast Cached Delivery`
          });
        }, 3);

        await jobService.completeJob(jobId);
        return; // Job is fully done
      }

      // Resolve the direct link
      const resolvedFile = await adapter.resolve(url);
      
      // Notify about download
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, `📄 *File found*\n📦 Size: ${resolvedFile.fileSize} bytes\n⬇️ _Downloading..._`, { parse_mode: 'Markdown' }); } catch(e){}
      }

      // Download file to temp
      tempFilePath = path.join(os.tmpdir(), `nextera_${jobId}_${Date.now()}`);
      
      await withRetry(() => downloadFile(resolvedFile.downloadUrl, tempFilePath!), 3);

      // Notify about upload
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, `📤 _Uploading to Telegram..._`, { parse_mode: 'Markdown' }); } catch(e){}
      }

      const filename = resolvedFile.fileName || 'downloaded_file';
      let sentToUser: any = null;

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

      await jobService.completeJob(jobId);

    } catch (error: any) {
      let userMsg = '❌ Unable to access this public file.\nPlease check that the link is valid and publicly accessible.';
      
      if (error instanceof ProviderError) {
        userMsg = `❌ ${error.message}`;
      } else if (error.message.includes('timeout') || error.message.includes('network')) {
         userMsg = '❌ Provider or network temporarily unavailable.';
      }
      
      await jobService.failJob(jobId, error.message || 'Unknown error');
      logger.error(`Job ${jobId} failed:`, error.message);
      
      if (telegramId) {
        try { await bot.telegram.sendMessage(telegramId, userMsg); } catch(e){}
      }
    } finally {
      // Clean up temporary file
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
