import { Context } from 'telegraf';
import { detectAdapter } from '../../providers';
import { jobService } from '../../services/JobService';
import { usageService } from '../../services/UsageService';
import { verificationService } from '../../verification/verification.service';
import { adminService } from '../../services/AdminService';
import { StatusMessageManager } from '../utils/StatusMessageManager';
import { getJobKeyboard } from '../keyboards/jobKeyboard';
import { handleError } from '../../utils/errorHandler';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export const messageHandler = async (ctx: Context) => {
  try {
    const user = ctx.state.user;
    // @ts-ignore
    const text = ctx.message?.text;
    
    logger.info(`Received text message from ${user?.telegramId || 'unknown'}: ${text ? text.substring(0, 20) : 'null'}`);

    if (!text || !user) return;

    // 1. Detect provider (fast sync operation)
    const adapter = detectAdapter(text);
    if (!adapter) {
      logger.info(`Link unsupported, sending rejection message to ${user.telegramId}`);
      await ctx.reply('❌ *Unsupported link.*\n\nPlease send a link from one of the supported platforms.', { parse_mode: 'Markdown' });
      return;
    }

    // 2. Check Verification Requirements (fast indexed check)
    const isVerificationRequiredGlobally = await adminService.getVerificationStatus();
    if (isVerificationRequiredGlobally && user.plan === 'FREE') {
      const isVerified = await verificationService.isUserVerified(user.id);
      if (!isVerified) {
        await ctx.reply('⚠️ *Verification Required*\n\nYou must verify to process links.\nPlease click the "🔐 Verify" button in the menu or use /start to open the menu.', { parse_mode: 'Markdown' });
        return;
      }
    }

    // 3. Check Daily limits (fast indexed check)
    const usage = await usageService.getUsage(user.id);
    const dailyLimit = await usageService.getDailyLimit(user.plan);
    if (usage.dailyRequests >= dailyLimit) {
      await ctx.reply(`🚫 *Daily limit reached.*\n\nFree users: ${config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config.PREMIUM_DAILY_LIMIT} downloads/day.`, { parse_mode: 'Markdown' });
      return;
    }

    // 4. Create Job and check active job limit
    const result = await jobService.createJob(user.id, text, adapter.providerName);
    
    if (result.isExisting) {
      await ctx.reply('⏳ *You already have a download running.*\n\nPlease wait until your current download finishes.', { parse_mode: 'Markdown' });
      return;
    }

    const job = result.job;
    await usageService.recordRequest(user.id, true);

    try {
      const { jobQueue } = require('../../queue/jobQueue');
      
      const waitingCount = await jobQueue.getWaitingCount();
      if (waitingCount >= config.MAX_QUEUE_SIZE) {
        // Rollback creation
        await jobService.cancelJob(job.id);
        await ctx.reply('⚠️ *The download queue is currently busy.*\n\nPlease try again in a few minutes.', { parse_mode: 'Markdown' });
        return;
      }

      await jobService.updateJobStatus(job.id, 'QUEUED');
      const priority = user.plan === 'PREMIUM' ? 1 : 5;
      
      // 5. Respond immediately!
      const activeCount = await jobQueue.getActiveCount();
      await ctx.reply(`⏳ *REQUEST RECEIVED*\n\nYour request has been added to the queue.\n\n⚡ Active Jobs: ${activeCount}\n⏳ Queue Position: ${waitingCount + 1}\n\nI'll notify you when processing starts.`, {
        parse_mode: 'Markdown',
        ...getJobKeyboard(job.id)
      });

      // 6. Add to BullMQ Queue asynchronously
      await jobQueue.add('processDownload', {
        jobId: job.id,
        url: text,
        userId: user.id
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
