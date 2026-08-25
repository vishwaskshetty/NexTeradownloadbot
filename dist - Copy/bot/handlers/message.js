"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageHandler = void 0;
const telegraf_1 = require("telegraf");
const providers_1 = require("../../providers");
const JobService_1 = require("../../services/JobService");
const UsageService_1 = require("../../services/UsageService");
const verification_service_1 = require("../../verification/verification.service");
const AdminService_1 = require("../../services/AdminService");
const jobKeyboard_1 = require("../keyboards/jobKeyboard");
const mainKeyboard_1 = require("../keyboards/mainKeyboard");
const errorHandler_1 = require("../../utils/errorHandler");
const logger_1 = require("../../utils/logger");
const config_1 = require("../../config");
function formatBytes(bytes) {
    const num = Number(bytes);
    if (!num || num === 0)
        return 'Unknown size';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(num) / Math.log(k));
    return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
const messageHandler = async (ctx) => {
    try {
        const user = ctx.state.user;
        // @ts-ignore
        const text = ctx.message?.text;
        logger_1.logger.info(`Received text message from ${user?.telegramId || 'unknown'}: ${text ? text.substring(0, 30) : 'null'}`);
        if (!text || !user)
            return;
        const isAdmin = AdminService_1.adminService.isAdmin(user.telegramId);
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
                    const inlineKeyboard = [];
                    checkResult.missingChannels.forEach((ch, idx) => {
                        inlineKeyboard.push([
                            telegraf_1.Markup.button.url(`📢 Join ${ch.name || `Channel ${idx + 1}`}`, ch.inviteUrl)
                        ]);
                    });
                    inlineKeyboard.push([
                        telegraf_1.Markup.button.callback('🔄 Check Again', 'check_force_sub')
                    ]);
                    await ctx.reply(formattedMsg, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                    return;
                }
            }
            // 2. Active Job Check (1 active job limit for normal users)
            const activeJob = await JobService_1.jobService.getActiveJob(user.id);
            if (activeJob) {
                await ctx.reply('⏳ *You already have a download in progress. Please wait until it is completed.*', { parse_mode: 'Markdown' });
                return;
            }
        }
        // 1. Detect provider (fast sync operation)
        const adapterInfo = (0, providers_1.detectAdapter)(text);
        if (!adapterInfo) {
            logger_1.logger.info(`Link unsupported, sending rejection message to ${user.telegramId}`);
            await ctx.reply('❌ *Unsupported TeraBox link.*', { parse_mode: 'Markdown' });
            return;
        }
        const adapter = adapterInfo.adapter;
        // Create Pending Job
        const result = await JobService_1.jobService.createJob(user.id, text, adapterInfo.providerName);
        const job = result.job;
        // Check for Multi-File Share
        const adapterInstance = adapter;
        let shareMetadata = null;
        if (typeof adapterInstance.getShareMetadata === 'function') {
            try {
                shareMetadata = await adapterInstance.getShareMetadata(text);
            }
            catch (metaErr) {
                await JobService_1.jobService.failJob(job.id, metaErr?.message || 'Metadata extraction failed');
                await ctx.reply(metaErr?.message || '❌ Unable to access this shared file.', { parse_mode: 'Markdown' });
                return;
            }
        }
        const fileList = shareMetadata?.fileList || [];
        // If multi-file share (more than 1 file): show selection keyboard
        if (fileList.length > 1) {
            await JobService_1.jobService.updateJobStatus(job.id, 'SELECTING_FILE');
            let listText = `📁 *TERABOX MULTI-FILE SHARE*\n\nThis share contains ${fileList.length} files. Please select a file to process:\n\n`;
            const keyboardButtons = [];
            fileList.slice(0, 10).forEach((file, idx) => {
                const fName = file.server_filename || file.filename || `File ${idx + 1}`;
                const fSize = file.size ? formatBytes(file.size) : 'Unknown size';
                listText += `${idx + 1}. 📄 \`${fName}\` (${fSize})\n`;
                keyboardButtons.push([
                    telegraf_1.Markup.button.callback(`${idx + 1}. 📄 ${fName.substring(0, 25)}`, `select_file_${job.id}_${file.fs_id}`)
                ]);
            });
            keyboardButtons.push([telegraf_1.Markup.button.callback('❌ Cancel', `cancel_${job.id}`)]);
            await ctx.reply(listText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboardButtons }
            });
            return; // Wait for user to select a file
        }
        // Check Verification Status (Admins BYPASS completely)
        const isVerificationRequiredGlobally = await AdminService_1.adminService.getVerificationStatus();
        const isVerified = (isAdmin || user.plan === 'PREMIUM' || !isVerificationRequiredGlobally)
            ? true
            : await verification_service_1.verificationService.isUserVerified(user.id);
        // IF NOT VERIFIED: Show Verification Required Prompt
        if (!isVerified) {
            await JobService_1.jobService.updateJobStatus(job.id, 'VERIFYING');
            await ctx.reply(`🔒 *Verification Required*\n\nTo get your file, please complete verification.`, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getVerificationPromptKeyboard)(job.id)
            });
            return;
        }
        // Check Daily limits before queueing (Admins BYPASS completely)
        if (!isAdmin) {
            const usage = await UsageService_1.usageService.getUsage(user.id);
            const dailyLimit = await UsageService_1.usageService.getDailyLimit(user.plan);
            if (usage.dailyRequests >= dailyLimit) {
                await JobService_1.jobService.cancelJob(job.id);
                await ctx.reply(`🚫 *Daily limit reached.*\n\nFree users: ${config_1.config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config_1.config.PREMIUM_DAILY_LIMIT} downloads/day.`, { parse_mode: 'Markdown' });
                return;
            }
        }
        // Queue Job for processing
        try {
            const { jobQueue } = require('../../queue/jobQueue');
            const waitingCount = await jobQueue.getWaitingCount();
            if (waitingCount >= config_1.config.MAX_QUEUE_SIZE) {
                await JobService_1.jobService.cancelJob(job.id);
                await ctx.reply('⚠️ *The download queue is currently busy.*\n\nPlease try again in a few minutes.', { parse_mode: 'Markdown' });
                return;
            }
            await JobService_1.jobService.updateJobStatus(job.id, 'QUEUED');
            const priority = (isAdmin || user.plan === 'PREMIUM') ? 1 : 5;
            const activeCount = await jobQueue.getActiveCount();
            const statusMsg = await ctx.reply(`⏳ *PROCESSING YOUR LINK*\n\n🔗 Source: ${adapterInfo.providerName}\n⚡ Status: Added to queue\n\n📍 Position: #${waitingCount + 1}\n⚡ Active Jobs: ${activeCount}`, {
                parse_mode: 'Markdown',
                ...(0, jobKeyboard_1.getJobKeyboard)(job.id)
            });
            // Add to BullMQ Queue asynchronously
            await jobQueue.add('processDownload', {
                jobId: job.id,
                url: text,
                userId: user.id,
                statusMessageId: statusMsg.message_id
            }, { priority });
        }
        catch (error) {
            await JobService_1.jobService.failJob(job.id, error.message);
            await ctx.reply('❌ *An error occurred during queueing.*', { parse_mode: 'Markdown' });
            logger_1.logger.error(error, 'Processing error');
        }
    }
    catch (error) {
        (0, errorHandler_1.handleError)(error, ctx);
    }
};
exports.messageHandler = messageHandler;
