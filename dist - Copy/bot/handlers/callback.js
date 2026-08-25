"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callbackHandler = void 0;
const UserService_1 = require("../../services/UserService");
const UsageService_1 = require("../../services/UsageService");
const JobService_1 = require("../../services/JobService");
const AdminService_1 = require("../../services/AdminService");
const verification_service_1 = require("../../verification/verification.service");
const mainKeyboard_1 = require("../keyboards/mainKeyboard");
const adminKeyboard_1 = require("../keyboards/adminKeyboard");
const start_1 = require("../commands/start");
const config_1 = require("../../config");
const shortener_service_1 = require("../../verification/shortener.service");
const db_1 = require("../../db");
const redis_1 = require("../../redis");
const bot_1 = require("../../bot");
const logger_1 = require("../../utils/logger");
const telegraf_1 = require("telegraf");
/**
 * Escapes reserved Markdown characters to prevent Telegram 400 Bad Request errors.
 */
function escapeMarkdown(text) {
    return text.replace(/[_*`\[\]]/g, '\\$&');
}
const callbackHandler = async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery?.data;
    const user = ctx.state?.user;
    if (!data || !user)
        return;
    // Immediately answer callback query to keep Telegram snappy & avoid spinning loader
    try {
        if (!data.startsWith('cancel_')) {
            await ctx.answerCbQuery().catch(() => { });
        }
    }
    catch { }
    try {
        const isAdmin = AdminService_1.adminService.isAdmin(user.telegramId);
        // ----------------- NON-ADMIN ACCESS GUARD -----------------
        if (!isAdmin && data.startsWith('admin_')) {
            await ctx.answerCbQuery('⛔ ACCESS DENIED: Administrator permissions required.', { show_alert: true }).catch(() => { });
            await ctx.editMessageText(`❌ *ACCESS DENIED*\n\nYou do not have permission to access the Administrator Panel.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] }
            }).catch(() => { });
            return;
        }
        // ----------------- USER MENUS -----------------
        if (data === 'main_menu') {
            const isVerificationRequired = await AdminService_1.adminService.getVerificationStatus();
            const showVerification = isVerificationRequired && user.plan === 'FREE';
            await ctx.editMessageText((0, start_1.getMainMenuText)(), {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getMainKeyboard)(isAdmin, showVerification)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'download') {
            const text = `
📥 *DOWNLOAD FILE*

Send me a supported link to process your download.

*Supported Platforms:*
• 🔵 TeraBox (\`terabox.com\`, \`1024terabox.com\`, etc.)
• 🟢 Diskwala (\`diskwala.com\`)

⚡ Processing will start automatically after sending the URL.`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('main_menu')
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'account') {
            const checkedUser = await UserService_1.userService.checkAndUpdatePremiumStatus(user);
            const usage = await UsageService_1.usageService.getUsage(checkedUser.id);
            const dailyLimit = await UsageService_1.usageService.getDailyLimit(checkedUser.plan);
            const isVerified = await verification_service_1.verificationService.isUserVerified(checkedUser.id);
            const remaining = Math.max(0, dailyLimit - usage.dailyRequests);
            const regDate = checkedUser.createdAt ? new Date(checkedUser.createdAt).toLocaleDateString() : 'N/A';
            const displayName = escapeMarkdown(checkedUser.username ? `@${checkedUser.username}` : (checkedUser.firstName || 'User'));
            const now = new Date();
            const isPrem = checkedUser.isPremium && checkedUser.plan === 'PREMIUM' && checkedUser.premiumExpiresAt && checkedUser.premiumExpiresAt > now;
            const expStr = checkedUser.premiumExpiresAt ? new Date(checkedUser.premiumExpiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';
            const text = `
👤 *ACCOUNT INFO*

🆔 *Telegram ID:* \`${checkedUser.telegramId}\`
👤 *Username:* ${displayName}
⭐ *Plan:* ${isPrem ? '⭐ Premium User' : '🆓 Free User'}
${isPrem ? `📅 *Premium Expires:* ${expStr}` : ''}
🔐 *Verification:* ${isVerified ? '✅ Verified' : '❌ Not Verified'}
📥 *Daily Limit:* ${dailyLimit} downloads/day
📊 *Used Today:* ${usage.dailyRequests} / ${dailyLimit}
⏳ *Remaining:* ${remaining} downloads
📅 *Registered:* ${regDate}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getAccountKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'my_status') {
            const checkedUser = await UserService_1.userService.checkAndUpdatePremiumStatus(user);
            const usage = await UsageService_1.usageService.getUsage(checkedUser.id);
            const dailyLimit = await UsageService_1.usageService.getDailyLimit(checkedUser.plan);
            const isVerified = await verification_service_1.verificationService.isUserVerified(checkedUser.id);
            const remaining = Math.max(0, dailyLimit - usage.dailyRequests);
            const displayName = escapeMarkdown(checkedUser.username ? `@${checkedUser.username}` : (checkedUser.firstName || checkedUser.telegramId.toString()));
            // Check active job
            const activeJob = await db_1.db.job.findFirst({
                where: {
                    userId: checkedUser.id,
                    status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] }
                },
                orderBy: { createdAt: 'desc' }
            });
            let jobStatusStr = 'None';
            if (activeJob) {
                jobStatusStr = `Job #${activeJob.id.substring(0, 6)} (${activeJob.status})`;
            }
            const text = `
📊 *MY STATUS*

👤 *Account:* ${displayName} (\`${user.telegramId}\`)
🔐 *Verification:* ${isVerified ? '✅ Verified' : '❌ Not Verified'}
⭐ *Premium:* ${user.plan === 'PREMIUM' ? '🟢 Enabled' : '🔴 Disabled'}
📥 *Daily Usage:* ${usage.dailyRequests} / ${dailyLimit}
⏳ *Remaining Downloads:* ${remaining}
⚡ *Active Job:* ${jobStatusStr}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getMyStatusKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'referrals') {
            const { referralService } = require('../../services/ReferralService');
            const botUsername = ctx.botInfo?.username || config_1.config.BOT_USERNAME;
            const stats = await referralService.getReferralStats(user.telegramId, botUsername);
            const text = `
🎁 *REFERRAL PROGRAM*

Invite friends and earn Premium subscriptions for free!

🔗 *Your referral link:*
\`${stats.referralLink}\`

📊 *Successful referrals:* ${stats.totalReferrals}
🎯 *Next reward:* ${stats.neededForNext} more referral(s)
⭐ *Reward:* ${stats.rewardDays} Days Premium

📈 *Progress to next reward:*
\`${stats.progressBar}\``;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getReferralKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'referral_link') {
            const { referralService } = require('../../services/ReferralService');
            const botUsername = ctx.botInfo?.username || config_1.config.BOT_USERNAME;
            const stats = await referralService.getReferralStats(user.telegramId, botUsername);
            await ctx.reply(`🔗 *YOUR UNIQUE REFERRAL LINK*\n\nShare this link with your friends to earn free Premium:\n\n\`${stats.referralLink}\``, { parse_mode: 'Markdown' }).catch(() => { });
        }
        else if (data === 'referral_stats') {
            const { referralService } = require('../../services/ReferralService');
            const botUsername = ctx.botInfo?.username || config_1.config.BOT_USERNAME;
            const stats = await referralService.getReferralStats(user.telegramId, botUsername);
            const text = `
📊 *REFERRAL STATISTICS*

👥 *Total Successful Referrals:* ${stats.totalReferrals}
🏆 *Milestones Claimed:* ${stats.totalMilestonesClaimed}
⭐ *Total Premium Earned:* ${stats.totalDaysEarned} Days

🎯 *Current Milestone Progress:*
\`${stats.progressBar}\`

Each milestone of ${stats.requiredPerReward} referrals awards +${stats.rewardDays} Days Premium automatically!`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('referrals')
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'referral_rewards') {
            const { referralService } = require('../../services/ReferralService');
            const botUsername = ctx.botInfo?.username || config_1.config.BOT_USERNAME;
            const stats = await referralService.getReferralStats(user.telegramId, botUsername);
            const text = `
🏆 *REFERRAL REWARDS*

• *Rule:* ${stats.requiredPerReward} referrals = ⭐ +${stats.rewardDays} Days Premium
• *Milestones Claimed:* ${stats.totalMilestonesClaimed} times
• *Total Days Awarded:* ${stats.totalDaysEarned} Days Premium

Keep sharing your link:
\`${stats.referralLink}\``;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('referrals')
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'verification' || data === 'verify_check') {
            const isEnabled = await AdminService_1.adminService.getVerificationStatus();
            if (!isEnabled) {
                await ctx.editMessageText(`
🔐 *VERIFICATION*

🟢 Verification is currently disabled by the administrator.

You can use the bot normally without completing verification.`, {
                    parse_mode: 'Markdown',
                    ...(0, mainKeyboard_1.getBackKeyboard)('account')
                }).catch((err) => {
                    if (!err.message?.includes('message is not modified'))
                        throw err;
                });
                return;
            }
            const isVerified = await verification_service_1.verificationService.isUserVerified(user.id);
            if (isVerified) {
                await ctx.editMessageText(`
✅ *VERIFIED*

Your account has been successfully verified.`, {
                    parse_mode: 'Markdown',
                    ...(0, mainKeyboard_1.getVerifiedKeyboard)()
                }).catch((err) => {
                    if (!err.message?.includes('message is not modified'))
                        throw err;
                });
                return;
            }
            if (data === 'verify_check') {
                // Find existing pending session for user
                const pendingSession = await db_1.db.verificationSession.findFirst({
                    where: { userId: user.id, status: 'PENDING' },
                    orderBy: { createdAt: 'desc' }
                });
                if (pendingSession && pendingSession.expiresAt > new Date()) {
                    const shortUrl = pendingSession.shortenerReference || '';
                    if (shortUrl) {
                        await ctx.editMessageText(`
🔐 *NOT VERIFIED*

Verification has not been completed yet.`, {
                            parse_mode: 'Markdown',
                            ...(0, mainKeyboard_1.getVerificationRequiredKeyboard)(shortUrl)
                        }).catch((err) => {
                            if (!err.message?.includes('message is not modified'))
                                throw err;
                        });
                    }
                    else {
                        const { shortUrl: newUrl } = await verification_service_1.verificationService.createVerificationFlow(user.id, ctx.botInfo?.username);
                        await ctx.editMessageText(`
🔐 *NOT VERIFIED*

Verification link generated. Please complete verification below.`, {
                            parse_mode: 'Markdown',
                            ...(0, mainKeyboard_1.getVerificationRequiredKeyboard)(newUrl)
                        }).catch((err) => {
                            if (!err.message?.includes('message is not modified'))
                                throw err;
                        });
                    }
                }
                else {
                    const { getVerificationExpiredKeyboard } = require('../keyboards/mainKeyboard');
                    await ctx.editMessageText(`
⏰ *VERIFICATION EXPIRED*

Your previous verification link has expired (15-minute limit exceeded).

Create a new verification session to continue.`, {
                        parse_mode: 'Markdown',
                        ...getVerificationExpiredKeyboard()
                    }).catch((err) => {
                        if (!err.message?.includes('message is not modified'))
                            throw err;
                    });
                }
            }
            else {
                // User clicked "Verification" or "Generate New Link"
                await ctx.editMessageText(`⏳ _Creating your verification link via AroLinks..._`, { parse_mode: 'Markdown' }).catch(() => { });
                try {
                    const botUsername = ctx.botInfo?.username;
                    const { shortUrl } = await verification_service_1.verificationService.createVerificationFlow(user.id, botUsername);
                    const markup = (0, mainKeyboard_1.getVerificationRequiredKeyboard)(shortUrl);
                    await ctx.editMessageText(`
🔐 *VERIFICATION*

Your verification link is ready.

Please open the link below and complete the verification process.`, {
                        parse_mode: 'Markdown',
                        ...markup
                    }).catch((err) => {
                        if (!err.message?.includes('message is not modified'))
                            throw err;
                    });
                }
                catch (linkErr) {
                    logger_1.logger.error(`[VERIFICATION LINK ERROR] userId=${user.id}: ${linkErr?.message}`);
                    await ctx.editMessageText(`
❌ *VERIFICATION LINK ERROR*

We couldn't create your verification link right now. Please try again in a moment.`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Try Again', callback_data: 'verification' }],
                                [{ text: '⬅️ Back', callback_data: 'account' }]
                            ]
                        }
                    }).catch((err) => {
                        if (!err.message?.includes('message is not modified'))
                            throw err;
                    });
                }
            }
        }
        else if (data.startsWith('select_file_')) {
            const parts = data.split('_');
            const jobId = parts[2];
            const fsId = parts[3];
            const job = await db_1.db.job.findUnique({ where: { id: jobId } });
            if (!job) {
                await ctx.editMessageText(`❌ *Job Not Found*\n\nThis download job could not be found or has expired.`, { parse_mode: 'Markdown' }).catch(() => { });
                return;
            }
            if (['QUEUED', 'PROCESSING', 'UPLOADING', 'COMPLETED'].includes(job.status)) {
                await ctx.answerCbQuery('⚠️ This download job is already being processed or completed.', { show_alert: true }).catch(() => { });
                return;
            }
            // Check verification requirements
            const isVerificationRequiredGlobally = await AdminService_1.adminService.getVerificationStatus();
            const isVerified = (user.plan === 'PREMIUM' || !isVerificationRequiredGlobally)
                ? true
                : await verification_service_1.verificationService.isUserVerified(user.id);
            if (!isVerified) {
                await JobService_1.jobService.updateJobStatus(job.id, 'VERIFYING');
                const { getVerificationPromptKeyboard } = require('../keyboards/mainKeyboard');
                await ctx.editMessageText(`🔒 *Verification Required*\n\nTo get your selected file, please complete verification.`, {
                    parse_mode: 'Markdown',
                    ...getVerificationPromptKeyboard(job.id)
                }).catch(() => { });
                return;
            }
            // User IS verified: Check daily limits before queueing
            const usage = await UsageService_1.usageService.getUsage(user.id);
            const dailyLimit = await UsageService_1.usageService.getDailyLimit(user.plan);
            if (usage.dailyRequests >= dailyLimit) {
                await JobService_1.jobService.cancelJob(job.id);
                await ctx.editMessageText(`🚫 *Daily limit reached.*\n\nFree users: ${config_1.config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config_1.config.PREMIUM_DAILY_LIMIT} downloads/day.`, { parse_mode: 'Markdown' }).catch(() => { });
                return;
            }
            try {
                const { jobQueue } = require('../../queue/jobQueue');
                const waitingCount = await jobQueue.getWaitingCount();
                const activeCount = await jobQueue.getActiveCount();
                await JobService_1.jobService.updateJobStatus(job.id, 'QUEUED');
                const priority = user.plan === 'PREMIUM' ? 1 : 5;
                const { getJobKeyboard } = require('../keyboards/jobKeyboard');
                await ctx.editMessageText(`⏳ *PROCESSING YOUR FILE*\n\n🔗 Source: ${job.provider}\n⚡ Status: Added to queue\n\n📍 Position: #${waitingCount + 1}\n⚡ Active Jobs: ${activeCount}\n\nI'll notify you when your file is ready.`, {
                    parse_mode: 'Markdown',
                    ...getJobKeyboard(job.id)
                }).catch(() => { });
                // Queue job into BullMQ for download processing with fsId
                await jobQueue.add('processDownload', {
                    jobId: job.id,
                    url: job.url,
                    userId: user.id,
                    fsId,
                    statusMessageId: ctx.callbackQuery?.message?.message_id
                }, { priority });
            }
            catch (err) {
                await JobService_1.jobService.failJob(job.id, err.message);
                await ctx.reply('❌ *An error occurred during queueing.*', { parse_mode: 'Markdown' });
            }
        }
        else if (data.startsWith('verify_flow_')) {
            const jobId = data.replace('verify_flow_', '');
            // Step 1: Immediately show lightweight loading state
            await ctx.editMessageText(`⏳ _Creating your verification link via AroLinks..._`, { parse_mode: 'Markdown' }).catch(() => { });
            try {
                // Step 2: Asynchronously generate link via AroLinks
                const botUsername = ctx.botInfo?.username;
                const { shortUrl } = await verification_service_1.verificationService.createVerificationFlow(user.id, botUsername);
                const { getAroLinksVerifyKeyboard } = require('../keyboards/mainKeyboard');
                await ctx.editMessageText(`
🔒 *VERIFICATION REQUIRED*

Please open the verification link below and complete verification to get your file.

⏱️ *Link expires in 15 minutes.*`, {
                    parse_mode: 'Markdown',
                    ...getAroLinksVerifyKeyboard(shortUrl, jobId)
                }).catch((err) => {
                    if (!err.message?.includes('message is not modified'))
                        throw err;
                });
            }
            catch (err) {
                logger_1.logger.error(`Error creating verification link for job ${jobId}: ${err?.message}`);
                await ctx.editMessageText(`❌ *VERIFICATION LINK ERROR*\n\nWe couldn't create your verification link right now. Please try again.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔄 Try Again', callback_data: `verify_flow_${jobId}` }]]
                    }
                }).catch(() => { });
            }
        }
        else if (data.startsWith('get_file_')) {
            const jobId = data.replace('get_file_', '');
            // Re-check verification status
            const isVerified = await verification_service_1.verificationService.isUserVerified(user.id);
            if (!isVerified) {
                await ctx.answerCbQuery('🔒 Verification not completed yet. Please complete verification first.', { show_alert: true }).catch(() => { });
                return;
            }
            // User IS verified! Retrieve job
            const job = await db_1.db.job.findUnique({ where: { id: jobId } });
            if (!job) {
                await ctx.editMessageText(`❌ *Job Not Found*\n\nThis download job could not be found or has expired.`, { parse_mode: 'Markdown' }).catch(() => { });
                return;
            }
            if (job.status === 'COMPLETED') {
                await ctx.answerCbQuery('✅ This file has already been delivered.', { show_alert: true }).catch(() => { });
                return;
            }
            // Check Daily limits before queueing
            const usage = await UsageService_1.usageService.getUsage(user.id);
            const dailyLimit = await UsageService_1.usageService.getDailyLimit(user.plan);
            if (usage.dailyRequests >= dailyLimit) {
                await ctx.editMessageText(`🚫 *Daily limit reached.*\n\nFree users: ${config_1.config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config_1.config.PREMIUM_DAILY_LIMIT} downloads/day.`, { parse_mode: 'Markdown' }).catch(() => { });
                return;
            }
            try {
                const { jobQueue } = require('../../queue/jobQueue');
                const waitingCount = await jobQueue.getWaitingCount();
                const activeCount = await jobQueue.getActiveCount();
                await JobService_1.jobService.updateJobStatus(job.id, 'QUEUED');
                const priority = user.plan === 'PREMIUM' ? 1 : 5;
                const { getJobKeyboard } = require('../keyboards/jobKeyboard');
                await ctx.editMessageText(`⏳ *PROCESSING YOUR LINK*\n\n🔗 Source: ${job.provider}\n⚡ Status: Added to queue\n\n📍 Position: #${waitingCount + 1}\n⚡ Active Jobs: ${activeCount}\n\nI'll notify you when your file is ready.`, {
                    parse_mode: 'Markdown',
                    ...getJobKeyboard(job.id)
                }).catch(() => { });
                // Queue job into BullMQ for download processing
                await jobQueue.add('processDownload', {
                    jobId: job.id,
                    url: job.url,
                    userId: user.id,
                    statusMessageId: ctx.callbackQuery?.message?.message_id
                }, { priority });
            }
            catch (err) {
                await JobService_1.jobService.failJob(job.id, err.message);
                await ctx.reply('❌ *An error occurred during queueing.*', { parse_mode: 'Markdown' });
            }
        }
        else if (data === 'premium') {
            const isPremiumEnabled = await AdminService_1.adminService.getPremiumStatus();
            if (!isPremiumEnabled) {
                await ctx.editMessageText(`
⚠️ *PREMIUM CURRENTLY UNAVAILABLE*

Premium functionality is currently disabled by the administrator.

Please try again later.`, {
                    parse_mode: 'Markdown',
                    ...(0, mainKeyboard_1.getBackKeyboard)('account')
                }).catch((err) => {
                    if (!err.message?.includes('message is not modified'))
                        throw err;
                });
                return;
            }
            const usage = await UsageService_1.usageService.getUsage(user.id);
            const dailyLimit = await UsageService_1.usageService.getDailyLimit(user.plan);
            const remaining = Math.max(0, dailyLimit - usage.dailyRequests);
            const text = `
⭐ *PREMIUM STATUS*

Status: ${user.plan === 'PREMIUM' ? '🟢 Enabled' : '🔴 Disabled'}
📥 Daily Limit: ${dailyLimit} downloads
📊 Used Today: ${usage.dailyRequests}
⏳ Remaining: ${remaining} downloads

*Limits:*
• Free Plan: ${config_1.config.FREE_DAILY_LIMIT} downloads/day
• Premium Plan: ${config_1.config.PREMIUM_DAILY_LIMIT} downloads/day

Contact administrator to upgrade your account to Premium.`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('account')
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'help') {
            const text = `
❓ *HELP & INSTRUCTIONS*

1. Click *📥 Download* or send a supported link directly.
2. Supported platforms: *TeraBox*, *Diskwala*.
3. Wait while your job is queued and processed.
4. Your file will be delivered directly in chat.

*Rules & Limitations:*
• 1 active download per user at a time
• Daily download limits apply
• Verification may be required for Free users
• Downloaded files are temporary and auto-deleted after delivery`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('main_menu')
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'disclaimer') {
            await ctx.editMessageText((0, mainKeyboard_1.getDisclaimerText)(), {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('main_menu')
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'check_force_sub') {
            const { forceSubService } = require('../../services/ForceSubService');
            const checkResult = await forceSubService.checkUserMembership(ctx.telegram, user.telegramId);
            if (checkResult.isMember) {
                await ctx.answerCbQuery('✅ Membership verified! You can now use the bot.', { show_alert: true });
                await ctx.editMessageText((0, start_1.getMainMenuText)(), {
                    parse_mode: 'Markdown',
                    ...(0, mainKeyboard_1.getMainKeyboard)(isAdmin, false)
                }).catch(() => { });
            }
            else {
                await ctx.answerCbQuery('❌ You have not joined all required channels yet. Please join all channels and try again.', { show_alert: true });
            }
        }
        // ----------------- ADMIN MENUS -----------------
        else if (data === 'admin_panel') {
            await ctx.editMessageText(`
👑 *ADMIN PANEL*

Manage your bot settings, users, verification, shortener, and system status from one place.`, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_forcesub') {
            const { forceSubService } = require('../../services/ForceSubService');
            const isEnabled = await forceSubService.getForceSubStatus();
            const channels = await forceSubService.getRequiredChannels();
            let text = `📢 *FORCE SUBSCRIBE MANAGEMENT*\n\nStatus: ${isEnabled ? '🟢 Enabled' : '🔴 Disabled'}\nRequired Channels: ${channels.length}\n\n`;
            if (channels.length === 0) {
                text += `_No required channels configured yet._\n\nUse command below to add a channel:\n\`/addchannel <id_or_username> <name> <invite_url>\``;
            }
            else {
                text += `*Configured Channels:*\n`;
                channels.forEach((c, idx) => {
                    text += `${idx + 1}. *${c.name}* (\`${c.id}\`)\n   URL: ${c.inviteUrl}\n`;
                });
            }
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminForceSubKeyboard)(isEnabled)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_toggle_forcesub') {
            const { forceSubService } = require('../../services/ForceSubService');
            const isEnabled = await forceSubService.getForceSubStatus();
            await forceSubService.setForceSubStatus(!isEnabled);
            await ctx.answerCbQuery(`Force Sub set to ${!isEnabled ? 'ENABLED' : 'DISABLED'}`, { show_alert: true });
            const channels = await forceSubService.getRequiredChannels();
            let text = `📢 *FORCE SUBSCRIBE MANAGEMENT*\n\nStatus: ${!isEnabled ? '🟢 Enabled' : '🔴 Disabled'}\nRequired Channels: ${channels.length}\n\n`;
            if (channels.length === 0) {
                text += `_No required channels configured yet._\n\nUse command below to add a channel:\n\`/addchannel <id_or_username> <name> <invite_url>\``;
            }
            else {
                text += `*Configured Channels:*\n`;
                channels.forEach((c, idx) => {
                    text += `${idx + 1}. *${c.name}* (\`${c.id}\`)\n   URL: ${c.inviteUrl}\n`;
                });
            }
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminForceSubKeyboard)(!isEnabled)
            }).catch(() => { });
        }
        else if (data === 'admin_add_channel_prompt') {
            await ctx.reply(`➕ *ADD REQUIRED CHANNEL*\n\nTo add a channel, send this command:\n\n\`/addchannel <channel_id_or_username> <channel_name> <invite_url>\` \n\nExample:\n\`/addchannel -100123456789 "Main Channel" https://t.me/examplechannel\``, { parse_mode: 'Markdown' });
        }
        else if (data === 'admin_remove_channel_prompt') {
            await ctx.reply(`➖ *REMOVE REQUIRED CHANNEL*\n\nTo remove a channel, send this command:\n\n\`/removechannel <channel_id_or_username>\` \n\nExample:\n\`/removechannel -100123456789\``, { parse_mode: 'Markdown' });
        }
        else if (data === 'admin_list_channels') {
            const { forceSubService } = require('../../services/ForceSubService');
            const channels = await forceSubService.getRequiredChannels();
            let text = `📋 *REQUIRED CHANNELS LIST*\n\nTotal: ${channels.length}\n\n`;
            channels.forEach((c, idx) => {
                text += `${idx + 1}. *${c.name}*\n   ID: \`${c.id}\`\n   URL: ${c.inviteUrl}\n\n`;
            });
            await ctx.reply(text || 'No channels configured.', { parse_mode: 'Markdown' });
        }
        else if (data === 'admin_edit_forcesub_msg_prompt') {
            await ctx.reply(`✏️ *EDIT FORCE SUB MESSAGE*\n\nTo update the force sub message, send this command:\n\n\`/setforcesubmsg <custom_message_text>\` \n\nSupports placeholder: \`{user_name}\``, { parse_mode: 'Markdown' });
        }
        else if (data === 'admin_status' || data === 'refresh') {
            let dbStatus = '❌ Error';
            let redisStatus = '❌ Error';
            try {
                await db_1.db.$queryRaw `SELECT 1`;
                dbStatus = 'Connected';
            }
            catch (e) { }
            try {
                await redis_1.redis.ping();
                redisStatus = 'Connected';
            }
            catch (e) { }
            const activeJobs = await db_1.db.job.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'UPLOADING'] } } });
            const queuedJobs = await db_1.db.job.count({ where: { status: 'QUEUED' } });
            const failedJobs = await db_1.db.job.count({ where: { status: 'FAILED' } });
            const totalUsers = await db_1.db.user.count();
            const usageStats = await db_1.db.userUsage.aggregate({ _sum: { dailyRequests: true, successfulRequests: true, failedRequests: true } });
            const vEnabled = await AdminService_1.adminService.getVerificationStatus();
            const pEnabled = await AdminService_1.adminService.getPremiumStatus();
            const sEnabled = await AdminService_1.adminService.getShortenerStatus();
            const { hasTeraBoxCredentials } = require('../../providers/terabox/terabox.resolver');
            const { hasDiskwalaCredentials } = require('../../providers/diskwala/diskwala.resolver');
            const teraBoxStatus = hasTeraBoxCredentials() ? '🟢 Available' : '🟡 Requires API';
            const diskwalaStatus = hasDiskwalaCredentials() ? '🟢 Available' : '🟡 Requires API';
            const text = `
📊 *BOT STATUS*

🤖 Bot: Online
🟢 PostgreSQL: ${dbStatus}
🟢 Redis: ${redisStatus}
🟢 Queue: Running
🟢 Workers: Running
🟢 Telegram API: Connected

🔐 Verification: ${vEnabled ? 'Enabled' : 'Disabled'}
⭐ Premium: ${pEnabled ? 'Enabled' : 'Disabled'}
🔗 Shortener: ${sEnabled ? 'Active' : 'Inactive'}

🔵 TeraBox: ${teraBoxStatus}
🟢 Diskwala: ${diskwalaStatus}

👥 Total users: ${totalUsers}
📥 Downloads today: ${usageStats._sum.dailyRequests || 0}
⚡ Active jobs: ${activeJobs}
⏳ Queued jobs: ${queuedJobs}
❌ Failed jobs: ${failedJobs}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'refresh' }], [{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_verification') {
            const isEnabled = await AdminService_1.adminService.getVerificationStatus();
            const text = `
🔐 *VERIFICATION SETTINGS*

Control whether Free users must complete shortener verification before downloading.

Current status:
${isEnabled ? '🟢 Enabled' : '🔴 Disabled'}

${isEnabled ? 'Users must complete verification before downloading.' : 'Verification is bypassed for all users.'}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminVerificationKeyboard)(isEnabled)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_toggle_verify') {
            const isEnabled = await AdminService_1.adminService.getVerificationStatus();
            await AdminService_1.adminService.setVerificationStatus(!isEnabled);
            const newStatus = !isEnabled;
            await ctx.editMessageText(`
✅ *VERIFICATION UPDATED*

Verification is now:
${newStatus ? '🟢 ENABLED' : '🔴 DISABLED'}

The setting is active immediately.`, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminVerificationKeyboard)(newStatus)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_shortener') {
            const isEnabled = await AdminService_1.adminService.getShortenerStatus();
            const provider = await AdminService_1.adminService.getShortenerProvider();
            const hasKey = !!config_1.config.SHORTENER_API_KEY;
            const text = `
🔗 *SHORTENER SETTINGS*

Provider: ${provider}
Status: ${isEnabled ? '🟢 Active' : '🔴 Inactive'}
API Key: ${hasKey ? '✅ Configured' : '❌ Missing'}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminShortenerKeyboard)(isEnabled)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_toggle_shortener') {
            const isEnabled = await AdminService_1.adminService.getShortenerStatus();
            await AdminService_1.adminService.setShortenerStatus(!isEnabled);
            const newStatus = !isEnabled;
            await ctx.editMessageText(`
✅ *SHORTENER UPDATED*

Shortener status is now:
${newStatus ? '🟢 ACTIVE' : '🔴 INACTIVE'}`, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminShortenerKeyboard)(newStatus)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_premium') {
            const isEnabled = await AdminService_1.adminService.getPremiumStatus();
            const text = `
⭐ *PREMIUM MANAGEMENT PANEL*

Manage premium subscriptions, limits, and active subscribers.

Global Premium Status: ${isEnabled ? '🟢 Enabled' : '🔴 Disabled'}
Free Limit: ${config_1.config.FREE_DAILY_LIMIT} / day
Premium Limit: ${config_1.config.PREMIUM_DAILY_LIMIT} / day

Use the buttons below or commands:
• \`/addpremium <telegram_id> [days]\`
• \`/extendpremium <telegram_id> <days>\`
• \`/removepremium <telegram_id>\`
• \`/viewpremium <telegram_id>\``;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminPremiumKeyboard)(isEnabled)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_toggle_premium') {
            const isEnabled = await AdminService_1.adminService.getPremiumStatus();
            await AdminService_1.adminService.setPremiumStatus(!isEnabled);
            const newStatus = !isEnabled;
            await ctx.editMessageText(`
✅ *PREMIUM UPDATED*

Premium is now:
${newStatus ? '🟢 ENABLED' : '🔴 DISABLED'}`, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminPremiumKeyboard)(newStatus)
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data.startsWith('admin_list_premium_')) {
            const page = parseInt(data.replace('admin_list_premium_', '') || '1', 10);
            const limit = 5;
            const { users, total, totalPages } = await UserService_1.userService.getPremiumUsersList(page, limit);
            let text = `📋 *PREMIUM SUBSCRIBERS LIST* (Page ${page}/${totalPages})\n\nTotal Premium Users: ${total}\n\n`;
            if (users.length === 0) {
                text += '_No active or expired premium users found._';
            }
            else {
                let idx = (page - 1) * limit + 1;
                const now = new Date();
                users.forEach((u) => {
                    const expires = u.premiumExpiresAt ? new Date(u.premiumExpiresAt) : null;
                    const isActive = u.isPremium && u.plan === 'PREMIUM' && expires && expires > now;
                    const remainingMs = expires ? Math.max(0, expires.getTime() - now.getTime()) : 0;
                    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
                    const expStr = expires ? expires.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : 'N/A';
                    text += `${idx}. 👤 *${escapeMarkdown(u.username ? '@' + u.username : (u.firstName || 'User'))}*\n`;
                    text += `   🆔 \`${u.telegramId}\` | ${isActive ? '🟢 ACTIVE' : '🔴 EXPIRED'}\n`;
                    text += `   📅 Expires: ${expStr} (${isActive ? remainingDays + ' days left' : 'Expired'})\n\n`;
                    idx++;
                });
            }
            const navButtons = [];
            if (page > 1)
                navButtons.push(telegraf_1.Markup.button.callback('⬅️ Prev', `admin_list_premium_${page - 1}`));
            if (page < totalPages)
                navButtons.push(telegraf_1.Markup.button.callback('Next ➡️', `admin_list_premium_${page + 1}`));
            const keyboard = telegraf_1.Markup.inlineKeyboard([
                ...(navButtons.length > 0 ? [navButtons] : []),
                [telegraf_1.Markup.button.callback('⬅️ Back to Premium Menu', 'admin_premium')]
            ]);
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...keyboard
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_add_premium_prompt') {
            await ctx.editMessageText(`⭐ *ADD PREMIUM USER*\n\nTo add premium for a user, use the command:\n\n\`/addpremium <telegram_id> [days]\` \n\nExample:\n\`/addpremium 123456789 30\`\n\nPresets available: 1, 3, 7, 15, 30, 60, 90, 180, 365 days.`, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('admin_premium')
            }).catch(() => { });
        }
        else if (data === 'admin_extend_premium_prompt') {
            await ctx.editMessageText(`➕ *EXTEND PREMIUM*\n\nTo extend premium for a user, use the command:\n\n\`/extendpremium <telegram_id> <days>\` \n\nExample:\n\`/extendpremium 123456789 15\``, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('admin_premium')
            }).catch(() => { });
        }
        else if (data === 'admin_remove_premium_prompt') {
            await ctx.editMessageText(`❌ *REMOVE PREMIUM*\n\nTo remove premium from a user, use the command:\n\n\`/removepremium <telegram_id>\` \n\nExample:\n\`/removepremium 123456789\``, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('admin_premium')
            }).catch(() => { });
        }
        else if (data === 'admin_view_premium_prompt') {
            await ctx.editMessageText(`👁 *VIEW PREMIUM USER*\n\nTo view details for a specific user, use the command:\n\n\`/viewpremium <telegram_id>\` \n\nExample:\n\`/viewpremium 123456789\``, {
                parse_mode: 'Markdown',
                ...(0, mainKeyboard_1.getBackKeyboard)('admin_premium')
            }).catch(() => { });
        }
        else if (data === 'admin_users' || data.startsWith('admin_users_')) {
            const page = parseInt(data.split('_')[2] || '1', 10);
            const limit = 5;
            const { users, total, totalPages } = await UserService_1.userService.getUsers(page, limit);
            let userList = '';
            if (users.length === 0) {
                userList = '\nNo registered users were found.';
            }
            else {
                let index = (page - 1) * limit + 1;
                for (const u of users) {
                    const isVerified = await verification_service_1.verificationService.isUserVerified(u.id);
                    const userLimit = u.plan === 'PREMIUM' ? config_1.config.PREMIUM_DAILY_LIMIT : config_1.config.FREE_DAILY_LIMIT;
                    const displayName = escapeMarkdown(u.username ? `@${u.username}` : (u.firstName || 'Unknown User'));
                    const regDate = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A';
                    const lastAct = u.lastActivity ? new Date(u.lastActivity).toLocaleDateString() : 'N/A';
                    userList += `
${index}. 👤 *${displayName}*
   🆔 \`${u.telegramId}\`
   ⭐ *Premium:* ${u.plan === 'PREMIUM' ? 'Enabled 🟢' : 'Disabled 🔴'}
   🔐 *Verification:* ${isVerified ? 'Verified ✅' : 'Not Verified ❌'}
   📥 *Today:* ${u.usage?.dailyRequests || 0} / ${userLimit}
   🚫 *Banned:* ${u.isBanned ? 'Yes 🚫' : 'No'}
   📅 *Registered:* ${regDate}
   🕐 *Last Activity:* ${lastAct}
`;
                    index++;
                }
            }
            const text = `👥 *USER MANAGEMENT*

Total users: ${total}
Showing users page ${page} of ${totalPages}
${userList}`;
            const paginationButtons = [];
            if (page > 1)
                paginationButtons.push(telegraf_1.Markup.button.callback('⬅️ Previous', `admin_users_${page - 1}`));
            paginationButtons.push(telegraf_1.Markup.button.callback(`${page}/${totalPages}`, 'noop'));
            if (page < totalPages)
                paginationButtons.push(telegraf_1.Markup.button.callback('Next ➡️', `admin_users_${page + 1}`));
            const keyboard = [
                ...(paginationButtons.length > 0 ? [paginationButtons] : []),
                [{ text: '⬅️ Back', callback_data: 'admin_panel' }]
            ];
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_statistics') {
            const totalUsers = await db_1.db.user.count();
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const newUsers = await db_1.db.user.count({ where: { createdAt: { gte: today } } });
            const premiumUsers = await db_1.db.user.count({ where: { plan: 'PREMIUM' } });
            const verifiedUsers = await db_1.db.verificationSession.count({ where: { status: 'VERIFIED' } });
            const bannedUsers = await db_1.db.user.count({ where: { isBanned: true } });
            const usageStats = await db_1.db.userUsage.aggregate({ _sum: { successfulRequests: true, failedRequests: true, dailyRequests: true } });
            const activeJobs = await db_1.db.job.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'UPLOADING'] } } });
            const queuedJobs = await db_1.db.job.count({ where: { status: 'QUEUED' } });
            const text = `
📈 *STATISTICS*

👥 Total Users: ${totalUsers}
🆕 New Users Today: ${newUsers}

📅 *Today's Activity:*
• 📥 Downloads: ${usageStats._sum.dailyRequests || 0}
• ✅ Completed: ${usageStats._sum.successfulRequests || 0}
• ❌ Failed: ${usageStats._sum.failedRequests || 0}
• ⚡ Active Jobs: ${activeJobs}
• ⏳ Queued Jobs: ${queuedJobs}

📊 *Breakdown:*
• ⭐ Premium Users: ${premiumUsers}
• 🔐 Verified Users: ${verifiedUsers}
• 🚫 Banned Users: ${bannedUsers}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'admin_statistics' }], [{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_broadcast') {
            const text = `
📢 *BROADCAST MESSAGE*

To send a broadcast message to all users, use the command:

\`/broadcast <your message text>\`

*Example:*
\`/broadcast Important update: Server maintenance at 12:00 PM.\`

Click *❌ Cancel* below to close this prompt.`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminBroadcastKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_jobs') {
            const pendingJobs = await db_1.db.job.findMany({
                where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] } },
                take: 10,
                orderBy: { createdAt: 'desc' },
                include: { user: true }
            });
            let jobList = '';
            if (pendingJobs.length === 0) {
                jobList = 'No active jobs.';
            }
            else {
                const running = pendingJobs.filter((j) => j.status === 'PROCESSING' || j.status === 'UPLOADING');
                const queued = pendingJobs.filter((j) => j.status === 'QUEUED' || j.status === 'PENDING');
                if (running.length > 0) {
                    jobList += `*Running:*\n` + running.map((j) => `• Job #${j.id.substring(0, 6)}\n• User: ${j.user.telegramId}\n• Status: ${j.status}`).join('\n\n') + '\n\n';
                }
                if (queued.length > 0) {
                    jobList += `*Queued:*\n` + queued.map((j) => `• Job #${j.id.substring(0, 6)}\n• User: ${j.user.telegramId}`).join('\n\n');
                }
            }
            const text = `
⚡ *ACTIVE JOBS*

${jobList}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminJobsKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_settings') {
            const text = `
⚙️ *BOT SETTINGS*

• Free daily limit: ${config_1.config.FREE_DAILY_LIMIT}
• Premium daily limit: ${config_1.config.PREMIUM_DAILY_LIMIT}
• Maximum concurrent jobs: ${config_1.config.WORKER_CONCURRENCY}
• Per-user active-job limit: ${config_1.config.MAX_ACTIVE_JOBS_PER_USER}
• Storage retention: ${config_1.config.STORAGE_RETENTION_HOURS}h

*(Settings are loaded from environment variables in .env)*`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_storage') {
            const stored = await db_1.db.storedFile.count();
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const uploadsToday = await db_1.db.storedFile.count({ where: { createdAt: { gte: today } } });
            const text = `
📦 *STORAGE*

• 📦 Stored files: ${stored}
• 📥 Uploads today: ${uploadsToday}
• ⏱️ Retention: ${config_1.config.STORAGE_RETENTION_HOURS} hours
• 🟢 Storage status: ${config_1.config.STORAGE_CHANNEL_ID ? 'Connected' : 'Unavailable'}`;
            await ctx.editMessageText(text, {
                parse_mode: 'Markdown',
                ...(0, adminKeyboard_1.getAdminStorageKeyboard)()
            }).catch((err) => {
                if (!err.message?.includes('message is not modified'))
                    throw err;
            });
        }
        else if (data === 'admin_test_shortener') {
            await ctx.answerCbQuery('🧪 Testing shortener integration...', { show_alert: false }).catch(() => { });
            try {
                const testUrl = 'https://google.com';
                const provider = await (0, shortener_service_1.getShortenerProvider)();
                await provider.createShortUrl(testUrl);
                await ctx.editMessageText(`
✅ *SHORTENER TEST PASSED*

Arolinks responded successfully.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_shortener' }]] } });
            }
            catch (error) {
                await ctx.editMessageText(`
❌ *SHORTENER TEST FAILED*

The configured Arolinks integration could not be verified.
Error: ${error.message.substring(0, 80)}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_shortener' }]] } });
            }
        }
        else if (data === 'admin_test_storage') {
            if (!config_1.config.STORAGE_CHANNEL_ID) {
                await ctx.answerCbQuery('❌ STORAGE_CHANNEL_ID is not configured in .env', { show_alert: true }).catch(() => { });
                return;
            }
            try {
                await bot_1.bot.telegram.sendMessage(config_1.config.STORAGE_CHANNEL_ID, '🧪 Storage channel write test successful.');
                await ctx.editMessageText(`✅ *STORAGE TEST PASSED*\n\nConnected and verified channel ID: \`${config_1.config.STORAGE_CHANNEL_ID}\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_storage' }]] }
                });
            }
            catch (e) {
                await ctx.editMessageText(`❌ *STORAGE TEST FAILED*\n\nError: ${e.message}`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_storage' }]] }
                });
            }
        }
        else if (data === 'admin_clean_jobs') {
            const { jobService } = require('../../services/JobService');
            await jobService.cleanStuckJobs();
            await ctx.answerCbQuery('✅ Cleaned up stuck jobs.', { show_alert: true });
            // Refresh active jobs view
            // @ts-ignore
            ctx.callbackQuery.data = 'admin_jobs';
            return (0, exports.callbackHandler)(ctx);
        }
        else if (data === 'admin_clean_storage') {
            await db_1.db.storedFile.deleteMany({
                where: {
                    expiresAt: { lt: new Date() }
                }
            });
            await ctx.answerCbQuery('🧹 Expired cache cleanup complete.', { show_alert: true });
        }
        else if (data === 'admin_cancel_job_prompt') {
            await ctx.answerCbQuery('🛑 Send /cancel <job_id> in chat to cancel a specific job.', { show_alert: true }).catch(() => { });
        }
        else if (data === 'admin_retention_storage') {
            await ctx.answerCbQuery(`⏱️ Storage retention is currently ${config_1.config.STORAGE_RETENTION_HOURS} hours.`, { show_alert: true }).catch(() => { });
        }
        else if (data === 'noop') {
            // No-op for pagination label buttons
            await ctx.answerCbQuery().catch(() => { });
        }
        else if (data.startsWith('cancel_')) {
            const jobId = data.split('_').slice(1).join('_');
            await JobService_1.jobService.cancelJob(jobId);
            await ctx.answerCbQuery('❌ Download cancelled.', { show_alert: true }).catch(() => { });
            await ctx.editMessageText(`❌ *DOWNLOAD CANCELLED*\n\nThe download was cancelled before completion.\n\nYour daily download limit was NOT used.`, { parse_mode: 'Markdown' }).catch(() => { });
        }
        // ----------------- UNKNOWN / OUTDATED CALLBACK -----------------
        else {
            console.warn(`[callback] Unknown or outdated callback_data: "${data}"`);
            await ctx.answerCbQuery('⚠️ Menu outdated.', { show_alert: false }).catch(() => { });
            await ctx.editMessageText(`
⚠️ *MENU OUTDATED*

This menu button is no longer valid.
Please return to the main menu below.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] }
            }).catch(() => { });
        }
    }
    catch (error) {
        console.error('[ADMIN CALLBACK ERROR]', {
            data,
            userId: user?.id,
            telegramId: user?.telegramId?.toString(),
            message: error?.message || error,
            stack: error?.stack
        });
        try {
            await ctx.answerCbQuery('❌ Action failed. Please try again.', { show_alert: true });
        }
        catch { }
        try {
            await ctx.editMessageText(`
❌ *ACTION FAILED*

We couldn't complete this action due to a temporary system error.
Please try again.`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Retry', callback_data: data }, { text: '⬅️ Back', callback_data: 'admin_panel' }]
                    ]
                }
            });
        }
        catch { }
    }
};
exports.callbackHandler = callbackHandler;
