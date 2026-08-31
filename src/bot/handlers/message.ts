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
import { TeraBoxGatewayVerificationSessionError } from '../../providers/errors';

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

    const isAdmin = adminService.isAdmin(user.telegramId);

    // ADMIN BYPASS: Admins have ZERO restrictions!
    if (!isAdmin) {
      // 1. Force Subscribe Check for Normal Users
      const { forceSubService } = require('../../services/ForceSubService');
      const isForceSubEnabled = await forceSubService.getForceSubStatus();
      if (isForceSubEnabled) {
        const checkResult = await forceSubService.checkUserMembership(ctx.telegram, user.telegramId);
        if (!checkResult.isMember) {
          const rawMsg = await forceSubService.getCustomMessage();
          const userName = ctx.from?.first_name || 'User';
          const formattedMsg = rawMsg.replace(/\{user_name\}/g, userName);

          const inlineKeyboard: any[] = [];
          checkResult.missingChannels.forEach((ch: any, idx: number) => {
            inlineKeyboard.push([
              Markup.button.url(`📢 Join ${ch.name || `Channel ${idx + 1}`}`, ch.inviteUrl)
            ]);
          });
          inlineKeyboard.push([
            Markup.button.callback('🔄 Check Again', 'check_force_sub')
          ]);

          await ctx.reply(formattedMsg, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard }
          });
          return;
        }
      }

      // 2. Active Job Check (1 active job limit for normal users)
      const activeJob = await jobService.getActiveJob(user.id);
      if (activeJob) {
        await ctx.reply('⏳ *You already have a download in progress. Please wait until it is completed.*', { parse_mode: 'Markdown' });
        return;
      }
    }

    // 1. Detect provider (fast sync operation)
    const adapterInfo = detectAdapter(text);
    if (!adapterInfo) {
      logger.info(`Link unsupported, sending rejection message to ${user.telegramId}`);
      await ctx.reply('❌ *Unsupported TeraBox link.*', { parse_mode: 'Markdown' });
      return;
    }

    const adapter = adapterInfo.adapter;

    // Create Pending Job
    const result = await jobService.createJob(user.id, text, adapterInfo.providerName);
    const job = result.job;

    // Check for Multi-File Share
    const adapterInstance = adapter as any;
    let shareMetadata: any = null;
    if (typeof adapterInstance.getShareMetadata === 'function') {
      try {
        shareMetadata = await adapterInstance.getShareMetadata(text);
      } catch (metaErr: any) {
        const isVerif =
          metaErr instanceof TeraBoxGatewayVerificationSessionError ||
          metaErr?.code === 'TERABOX_GATEWAY_VERIFICATION_REQUIRED' ||
          metaErr?.name === 'TeraBoxGatewayVerificationSessionError' ||
          metaErr?.errno === 400210 ||
          metaErr?.errno === 400310 ||
          String(metaErr?.message || metaErr?.errmsg || '').includes('verify_v2');

        if (!isVerif) {
          const safeErrorMsg = typeof metaErr?.message === 'string'
            ? metaErr.message.replace(/[*_`[\]()]/g, '')
            : '❌ Unable to access this shared file.';
          await jobService.failJob(job.id, safeErrorMsg);
          await ctx.reply(safeErrorMsg);
          return;
        }
      }
    }

    const fileList = shareMetadata?.fileList || [];

    // If multi-file share (more than 1 file): show selection keyboard
    if (fileList.length > 1) {
      await jobService.updateJobStatus(job.id, 'SELECTING_FILE');

      let listText = `📁 *TERABOX MULTI-FILE SHARE*\n\nThis share contains ${fileList.length} files. Please select a file to process:\n\n`;
      const keyboardButtons: any[] = [];

      fileList.slice(0, 10).forEach((file: any, idx: number) => {
        const rawName = file.server_filename || file.filename || `File ${idx + 1}`;
        const fName = String(rawName).replace(/[`*_]/g, ' ');
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

    // Check Verification Status (Admins BYPASS completely)
    const isVerificationRequiredGlobally = await adminService.getVerificationStatus();
    const isVerified = (isAdmin || user.plan === 'PREMIUM' || !isVerificationRequiredGlobally) 
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
      return;
    }

    // Check Daily limits before queueing (Admins BYPASS completely)
    if (!isAdmin) {
      const usage = await usageService.getUsage(user.id);
      const dailyLimit = await usageService.getDailyLimit(user.plan);
      if (usage.dailyRequests >= dailyLimit) {
        await jobService.cancelJob(job.id);
        await ctx.reply(`🚫 *Daily limit reached.*\n\nFree users: ${config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config.PREMIUM_DAILY_LIMIT} downloads/day.`, { parse_mode: 'Markdown' });
        return;
      }
    }

    // Queue Job for processing
    try {
      const { jobQueue } = require('../../queue/jobQueue');
      
      const waitingCount = await jobQueue.getWaitingCount();
      if (waitingCount >= config.MAX_QUEUE_SIZE) {
        await jobService.cancelJob(job.id);
        await ctx.reply('⚠️ *The download queue is currently busy.*\n\nPlease try again in a few minutes.', { parse_mode: 'Markdown' });
        return;
      }

      await jobService.updateJobStatus(job.id, 'QUEUED');
      const priority = (isAdmin || user.plan === 'PREMIUM') ? 1 : 5;
      
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
