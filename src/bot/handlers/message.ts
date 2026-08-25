import { Context, Markup } from 'telegraf';
import { detectAdapter } from '../../providers';
import { jobService } from '../../services/JobService';
import { usageService } from '../../services/UsageService';
import { verificationService } from '../../verification/verification.service';
import { adminService } from '../../services/AdminService';
import { getJobKeyboard } from '../keyboards/jobKeyboard';
import { getVerificationPromptKeyboard } from '../keyboards/mainKeyboard';
import { handleError } from '../../utils/errorHandler';
import { logger } from '../../utils/logger';
import { config } from '../../config';

function formatBytes(bytes: number | bigint): string {
  const num = Number(bytes);
  if (!num || num === 0) return 'Unknown size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export const messageHandler = async (ctx: Context) => {
  try {
    const user = ctx.state.user;
    // @ts-ignore
    const text = ctx.message?.text;
    
    logger.info(`Received text message from ${user?.telegramId || 'unknown'}: ${text ? text.substring(0, 30) : 'null'}`);

    if (!text || !user) return;

    // 1. Detect provider (fast sync operation)
    const adapterInfo = detectAdapter(text);
    if (!adapterInfo) {
      logger.info(`Link unsupported, sending rejection message to ${user.telegramId}`);
      await ctx.reply('❌ *Unsupported TeraBox link.*', { parse_mode: 'Markdown' });
      return;
    }

    const adapter = adapterInfo.adapter;

    // 2. Check Active Job Limit (1 active job per user)
    const activeJob = await jobService.getActiveJob(user.id);
    if (activeJob) {
      await ctx.reply('⏳ *You already have a download in progress. Please wait until it is completed.*', { parse_mode: 'Markdown' });
      return;
    }

    // 3. Create Pending Job
    const result = await jobService.createJob(user.id, text, adapterInfo.providerName);
    const job = result.job;

    // 4. Check for Multi-File Share
    const adapterInstance = adapter as any;
    let shareMetadata: any = null;
    if (typeof adapterInstance.getShareMetadata === 'function') {
      try {
        shareMetadata = await adapterInstance.getShareMetadata(text);
      } catch (metaErr: any) {
        await jobService.failJob(job.id, metaErr?.message || 'Metadata extraction failed');
        await ctx.reply(metaErr?.message || '❌ Unable to access this shared file.', { parse_mode: 'Markdown' });
        return;
      }
    }

    const fileList = shareMetadata?.fileList || [];

    // If multi-file share (more than 1 file): show selection keyboard
    if (fileList.length > 1) {
      await jobService.updateJobStatus(job.id, 'SELECTING_FILE');

      let listText = `📁 *TERABOX MULTI-FILE SHARE*\n\nThis share contains ${fileList.length} files. Please select a file to process:\n\n`;
      const keyboardButtons: any[] = [];

      fileList.slice(0, 10).forEach((file: any, idx: number) => {
        const fName = file.server_filename || file.filename || `File ${idx + 1}`;
        const fSize = file.size ? formatBytes(file.size) : 'Unknown size';
        listText += `${idx + 1}. 📄 \`${fName}\` (${fSize})\n`;

        keyboardButtons.push([
          Markup.button.callback(`${idx + 1}. 📄 ${fName.substring(0, 25)}`, `select_file_${job.id}_${file.fs_id}`)
        ]);
      });

      keyboardButtons.push([Markup.button.callback('❌ Cancel', `cancel_${job.id}`)]);

      await ctx.reply(listText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboardButtons }
      });
      return; // Wait for user to select a file
    }

    // 5. Single File Flow: Check Verification Status
    const isVerificationRequiredGlobally = await adminService.getVerificationStatus();
    const isVerified = (user.plan === 'PREMIUM' || !isVerificationRequiredGlobally) 
      ? true 
      : await verificationService.isUserVerified(user.id);

    // IF NOT VERIFIED: Show Verification Required Prompt
    if (!isVerified) {
      await jobService.updateJobStatus(job.id, 'VERIFYING');
      await ctx.reply(
        `🔒 *Verification Required*\n\nTo get your file, please complete verification.`,
        {
          parse_mode: 'Markdown',
          ...getVerificationPromptKeyboard(job.id)
        }
      );
      return; // Do NOT count usage, do NOT queue job
    }

    // IF VERIFIED: Check Daily limits before queueing
    const usage = await usageService.getUsage(user.id);
    const dailyLimit = await usageService.getDailyLimit(user.plan);
    if (usage.dailyRequests >= dailyLimit) {
      await jobService.cancelJob(job.id);
      await ctx.reply(`🚫 *Daily limit reached.*\n\nFree users: ${config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config.PREMIUM_DAILY_LIMIT} downloads/day.`, { parse_mode: 'Markdown' });
      return;
    }

    // 6. Queue Job for processing
    try {
      const { jobQueue } = require('../../queue/jobQueue');
      
      const waitingCount = await jobQueue.getWaitingCount();
      if (waitingCount >= config.MAX_QUEUE_SIZE) {
        await jobService.cancelJob(job.id);
        await ctx.reply('⚠️ *The download queue is currently busy.*\n\nPlease try again in a few minutes.', { parse_mode: 'Markdown' });
        return;
      }

      await jobService.updateJobStatus(job.id, 'QUEUED');
      const priority = user.plan === 'PREMIUM' ? 1 : 5;
      
      const activeCount = await jobQueue.getActiveCount();
      const statusMsg = await ctx.reply(
        `⏳ *PROCESSING YOUR LINK*\n\n🔗 Source: ${adapterInfo.providerName}\n⚡ Status: Added to queue\n\n📍 Position: #${waitingCount + 1}\n⚡ Active Jobs: ${activeCount}`,
        {
          parse_mode: 'Markdown',
          ...getJobKeyboard(job.id)
        }
      );

      // Add to BullMQ Queue asynchronously
      await jobQueue.add('processDownload', {
        jobId: job.id,
        url: text,
        userId: user.id,
        statusMessageId: statusMsg.message_id
      }, { priority });
      
    } catch (error: any) {
       await jobService.failJob(job.id, error.message);
       await ctx.reply('❌ *An error occurred during queueing.*', { parse_mode: 'Markdown' });
       logger.error(error, 'Processing error');
    }
  } catch (error: any) {
    handleError(error, ctx);
  }
};
