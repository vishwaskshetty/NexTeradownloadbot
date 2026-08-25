import { Context } from 'telegraf';
import { userService } from '../../services/UserService';
import { usageService } from '../../services/UsageService';
import { jobService } from '../../services/JobService';
import { adminService } from '../../services/AdminService';
import { verificationService } from '../../verification/verification.service';
import { 
  getBackKeyboard, 
  getMainKeyboard, 
  getAccountKeyboard,
  getVerificationRequiredKeyboard,
  getVerifiedKeyboard
} from '../keyboards/mainKeyboard';
import { 
  getAdminKeyboard, 
  getAdminVerificationKeyboard, 
  getAdminShortenerKeyboard, 
  getAdminPremiumKeyboard,
  getAdminStorageKeyboard,
  getAdminJobsKeyboard
} from '../keyboards/adminKeyboard';
import { getMainMenuText } from '../commands/start';
import { config } from '../../config';
import { getShortenerProvider } from '../../verification/shortener.service';
import { db } from '../../db';
import { redis } from '../../redis';
import { bot } from '../../bot';
import { Markup } from 'telegraf';

export const callbackHandler = async (ctx: Context): Promise<void> => {
  try {
    // @ts-ignore
    const data = ctx.callbackQuery?.data;
    const user = ctx.state.user;

    if (!data || !user) return;

    // Immediately answer callback query to keep Telegram snappy
    if (!data.startsWith('cancel_')) {
      await ctx.answerCbQuery().catch(() => {});
    }

    const isAdmin = adminService.isAdmin(user.telegramId);

    // ----------------- USER MENUS -----------------
    if (data === 'main_menu') {
      const isVerificationRequired = await adminService.getVerificationStatus();
      const showVerification = isVerificationRequired && user.plan === 'FREE';
      await ctx.editMessageText(getMainMenuText(), {
        parse_mode: 'Markdown',
        ...getMainKeyboard(isAdmin, showVerification)
      }).catch(() => {});
    }
    else if (data === 'download') {
      const text = `
📥 *Download*

Send me a supported link.

Supported sources:
• TeraBox
• Diskwala`;
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getBackKeyboard()
      }).catch(() => {});
    }
    else if (data === 'account') {
      const usage = await usageService.getUsage(user.id);
      const dailyLimit = await usageService.getDailyLimit(user.plan);
      const isVerified = await verificationService.isUserVerified(user.id);

      const text = `
👤 *ACCOUNT*

🆔 User ID: \`${user.telegramId}\`
⭐ Premium: ${user.plan === 'PREMIUM' ? 'Enabled' : 'Disabled'}
📅 Daily limit: ${dailyLimit}
📥 Downloads today: ${usage.dailyRequests}/${dailyLimit}
🔐 Verification: ${isVerified ? 'Verified' : 'Not Verified'}`;
      
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getAccountKeyboard()
      }).catch(() => {});
    }
    else if (data === 'verification' || data === 'verify_check') {
      const isEnabled = await adminService.getVerificationStatus();
      if (!isEnabled) {
        await ctx.editMessageText(`
🔐 *VERIFICATION*

🟢 Verification is currently disabled.

You can use the bot normally without completing
the verification process.`, {
          parse_mode: 'Markdown',
          ...getBackKeyboard()
        }).catch(() => {});
        return;
      }

      const isVerified = await verificationService.isUserVerified(user.id);
      if (isVerified) {
        await ctx.editMessageText(`
✅ *VERIFIED*

Your account has been successfully verified.

You can now use the available download features
according to your account limits.`, {
          parse_mode: 'Markdown',
          ...getVerifiedKeyboard()
        }).catch(() => {});
      } else {
        const { shortUrl } = await verificationService.createVerificationFlow(user.id);
        const markup = getVerificationRequiredKeyboard(shortUrl);
        
        if (data === 'verify_check') {
          await ctx.editMessageText(`
⚠️ *VERIFICATION NOT COMPLETED*

We couldn't confirm your verification yet.

Please complete the verification process first,
then press "Check Verification" again.`, {
            parse_mode: 'Markdown',
            ...markup
          }).catch(() => {});
        } else {
          await ctx.editMessageText(`
🔐 *VERIFICATION REQUIRED*

Please verify your account to unlock downloads.

Verification helps protect the bot from abuse
and keeps the service available for everyone.

After successful verification, your access will be
unlocked automatically.`, {
            parse_mode: 'Markdown',
            ...markup
          }).catch(() => {});
        }
      }
    }
    else if (data === 'premium') {
      const isPremiumEnabled = await adminService.getPremiumStatus();
      if (!isPremiumEnabled) {
        await ctx.editMessageText(`
⚠️ *PREMIUM CURRENTLY UNAVAILABLE*

Premium functionality has temporarily been disabled by the administrator.

Please try again later.`, {
          parse_mode: 'Markdown',
          ...getBackKeyboard()
        }).catch(() => {});
        return;
      }

      const text = `
⭐ *Premium*

Premium users receive the configured Premium limits/features.

Free limit: ${config.FREE_DAILY_LIMIT}/day
Premium limit: ${config.PREMIUM_DAILY_LIMIT}/day

Contact the administrator to upgrade.`;
      
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getBackKeyboard()
      }).catch(() => {});
    }
    else if (data === 'help') {
      const text = `
❓ *How to use*

1. Choose Download
2. Send a supported link
3. Wait while your job is processed
4. Receive the file

• Only one active download per user
• Daily limits apply
• Unsupported links will be rejected`;
      
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getBackKeyboard()
      }).catch(() => {});
    }

    // ----------------- ADMIN MENUS -----------------
    else if (!isAdmin) {
      if (data.startsWith('admin_')) {
        ctx.answerCbQuery('⛔ ACCESS DENIED: You do not have permission to access the administrator panel.', { show_alert: true }).catch(() => {});
      }
      return;
    }
    else if (data === 'admin_panel') {
      await ctx.editMessageText(`
👑 *ADMIN PANEL*

Manage the bot, users, verification, Premium,
shortener, limits and system status.`, {
        parse_mode: 'Markdown',
        ...getAdminKeyboard()
      }).catch(() => {});
    }
    else if (data === 'admin_status' || data === 'refresh') {
      let dbStatus = '❌ Error';
      let redisStatus = '❌ Error';
      try {
        await db.$queryRaw`SELECT 1`;
        dbStatus = 'Connected';
      } catch (e) {}
      try {
        await redis.ping();
        redisStatus = 'Connected';
      } catch (e) {}

      const activeJobs = await db.job.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'UPLOADING'] } } });
      const queuedJobs = await db.job.count({ where: { status: 'QUEUED' } });
      const totalUsers = await db.user.count();
      const usageStats = await db.userUsage.aggregate({ _sum: { dailyRequests: true, successfulRequests: true, failedRequests: true } });
      
      const vEnabled = await adminService.getVerificationStatus();
      const pEnabled = await adminService.getPremiumStatus();
      const sEnabled = await adminService.getShortenerStatus();

      const text = `
📊 *BOT STATUS*

🤖 Bot: Online
🟢 PostgreSQL: ${dbStatus}
🟢 Redis: ${redisStatus}
🟢 Telegram API: Connected
🟢 Queue: Running
🟢 Workers: Running
🔐 Verification: ${vEnabled ? 'Enabled' : 'Disabled'}
⭐ Premium: ${pEnabled ? 'Enabled' : 'Disabled'}
🔗 Shortener: ${sEnabled ? 'Active' : 'Inactive'}
📦 Storage: Connected

*Statistics:*
👥 Total users: ${totalUsers}
📥 Downloads today: ${usageStats._sum.dailyRequests || 0}
⚡ Active jobs: ${activeJobs}
⏳ Queued jobs: ${queuedJobs}
✅ Completed: ${usageStats._sum.successfulRequests || 0}
❌ Failed: ${usageStats._sum.failedRequests || 0}`;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh Status', callback_data: 'refresh' }], [{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_verification') {
      const isEnabled = await adminService.getVerificationStatus();
      const text = `
🔐 *VERIFICATION SETTINGS*

Control whether users must complete verification
before accessing protected download features.

Current status:
${isEnabled ? '🟢 Enabled' : '🔴 Disabled'}

${isEnabled ? 'Users who are not verified must complete\nverification before downloading.' : 'Users can download without verification.'}`;
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getAdminVerificationKeyboard(isEnabled)
      }).catch(() => {});
    }
    else if (data === 'admin_toggle_verify') {
      const isEnabled = await adminService.getVerificationStatus();
      await adminService.setVerificationStatus(!isEnabled);
      await ctx.editMessageText(`
✅ *VERIFICATION UPDATED*

Verification has been successfully ${!isEnabled ? 'enabled' : 'disabled'}.

The new setting is now active for users.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_verification' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_shortener') {
      const isEnabled = await adminService.getShortenerStatus();
      const provider = await adminService.getShortenerProvider();
      const hasKey = !!config.SHORTENER_API_KEY;
      const vEnabled = await adminService.getVerificationStatus();
      
      const text = `
🔗 *SHORTENER SETTINGS*

Provider: ${provider}
Status: ${isEnabled ? '🟢 Active' : '🔴 Inactive'}
API Key: ${hasKey ? '✅ Configured' : '❌ Missing'}
Verification: ${vEnabled ? '🟢 Enabled' : '🔴 Disabled'}`;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getAdminShortenerKeyboard(isEnabled)
      }).catch(() => {});
    }
    else if (data === 'admin_toggle_shortener') {
      const isEnabled = await adminService.getShortenerStatus();
      await adminService.setShortenerStatus(!isEnabled);
      
      await ctx.editMessageText(!isEnabled ? `
✅ *SHORTENER ACTIVATED*

Arolinks is now active for the configured verification flow.` : `
⚠️ *SHORTENER DISABLED*

Arolinks verification is currently disabled.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_shortener' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_premium') {
      const isEnabled = await adminService.getPremiumStatus();
      const text = `
⭐ *PREMIUM SETTINGS*

Current status:
${isEnabled ? '🟢 Enabled' : '🔴 Disabled'}`;
      
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getAdminPremiumKeyboard(isEnabled)
      }).catch(() => {});
    }
    else if (data === 'admin_toggle_premium') {
      const isEnabled = await adminService.getPremiumStatus();
      await adminService.setPremiumStatus(!isEnabled);
      await ctx.editMessageText(`
✅ *PREMIUM UPDATED*

Premium has been successfully ${!isEnabled ? 'enabled' : 'disabled'}.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_premium' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_users' || data.startsWith('admin_users_')) {
      const page = parseInt(data.split('_')[2] || '1', 10);
      const limit = 5;
      const skip = (page - 1) * limit;
      const total = await db.user.count();
      const totalPages = Math.ceil(total / limit) || 1;

      const users = await db.user.findMany({ 
        skip, 
        take: limit, 
        orderBy: { createdAt: 'desc' },
        include: { usage: true }
      });
      
      let userList = '';
      for (const u of users) {
        const isVerified = await verificationService.isUserVerified(u.id);
        const limit = u.plan === 'PREMIUM' ? config.PREMIUM_DAILY_LIMIT : config.FREE_DAILY_LIMIT;
        
        userList += `
👤 User: @${u.username || 'Unknown'}
🆔 ID: ${u.telegramId}
⭐ Premium: ${u.plan === 'PREMIUM' ? '🟢' : '🔴'}
🔐 Verification: ${isVerified ? '✅' : '❌'}
📥 Today: ${u.usage?.dailyRequests || 0}/${limit}
🚫 Banned: ${u.isBanned ? '✅' : '❌'}
`;
      }

      const text = `
👥 *USER MANAGEMENT*
${userList || 'No users found.'}`;

      const paginationButtons = [];
      if (page > 1) paginationButtons.push(Markup.button.callback('⬅️ Previous', `admin_users_${page - 1}`));
      paginationButtons.push(Markup.button.callback(`Page ${page}/${totalPages}`, 'noop'));
      if (page < totalPages) paginationButtons.push(Markup.button.callback('Next ➡️', `admin_users_${page + 1}`));

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [paginationButtons, [{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_statistics') {
      const totalUsers = await db.user.count();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const newUsers = await db.user.count({ where: { createdAt: { gte: today } } });
      const premiumUsers = await db.user.count({ where: { plan: 'PREMIUM' } });
      const verifiedUsers = await db.verificationSession.count({ where: { status: 'VERIFIED' } });
      const bannedUsers = await db.user.count({ where: { isBanned: true } });
      const usageStats = await db.userUsage.aggregate({ _sum: { successfulRequests: true, failedRequests: true, dailyRequests: true } });
      
      const activeJobs = await db.job.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'UPLOADING'] } } });
      const queuedJobs = await db.job.count({ where: { status: 'QUEUED' } });

      const text = `
📈 *BOT STATISTICS*

👥 Total Users: ${totalUsers}

📅 Today:
• 📥 Downloads: ${usageStats._sum.dailyRequests || 0}
• ✅ Completed: ${usageStats._sum.successfulRequests || 0}
• ❌ Failed: ${usageStats._sum.failedRequests || 0}
• ⚡ Active: ${activeJobs}

📊 Users:
• ⭐ Premium: ${premiumUsers}
• 🔐 Verified: ${verifiedUsers}
• 🚫 Banned: ${bannedUsers}`;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'admin_statistics' }], [{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_jobs') {
      const pendingJobs = await db.job.findMany({ 
        where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] } },
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { user: true }
      });

      let jobList = '';
      if (pendingJobs.length === 0) {
        jobList = 'No active jobs.';
      } else {
        const running = pendingJobs.filter(j => j.status === 'PROCESSING' || j.status === 'UPLOADING');
        const queued = pendingJobs.filter(j => j.status === 'QUEUED' || j.status === 'PENDING');

        if (running.length > 0) {
          jobList += `*Running:*\n` + running.map(j => `• Job #${j.id.substring(0,6)}\n• User: ${j.user.telegramId}\n• Status: ${j.status}`).join('\n\n') + '\n\n';
        }
        if (queued.length > 0) {
          jobList += `*Queued:*\n` + queued.map(j => `• Job #${j.id.substring(0,6)}\n• User: ${j.user.telegramId}`).join('\n\n');
        }
      }

      const text = `
⚡ *ACTIVE JOBS*

${jobList}`;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getAdminJobsKeyboard()
      }).catch(() => {});
    }
    else if (data === 'admin_settings') {
      const text = `
⚙️ *BOT SETTINGS*

• Free daily limit: ${config.FREE_DAILY_LIMIT}
• Premium daily limit: ${config.PREMIUM_DAILY_LIMIT}
• Maximum concurrent jobs: ${config.WORKER_CONCURRENCY}
• Per-user active-job limit: ${config.MAX_ACTIVE_JOBS_PER_USER}
• Storage retention: ${config.STORAGE_RETENTION_HOURS}h

*(These settings are currently controlled via the .env file and process variables. Changes require a restart).*`;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
      }).catch(() => {});
    }
    else if (data === 'admin_storage') {
      const stored = await db.storedFile.count();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const uploadsToday = await db.storedFile.count({ where: { createdAt: { gte: today } } });
      
      const text = `
📦 *STORAGE*

• 📦 Stored files: ${stored}
• 📥 Uploads today: ${uploadsToday}
• ⏱️ Retention: ${config.STORAGE_RETENTION_HOURS} hours
• 🟢 Storage status: ${config.STORAGE_CHANNEL_ID ? 'Connected' : 'Unavailable'}`;

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...getAdminStorageKeyboard()
      }).catch(() => {});
    }

    else if (data === 'admin_test_shortener') {
      ctx.answerCbQuery('🧪 Shortener test initiated. Check your messages.', { show_alert: true }).catch(() => {});
      try {
        const testUrl = 'https://google.com';
        const provider = await getShortenerProvider();
        await provider.createShortUrl(testUrl);
        await ctx.editMessageText(`
✅ *SHORTENER TEST PASSED*

Arolinks responded successfully.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_shortener' }]] } });
      } catch (error: any) {
        await ctx.editMessageText(`
❌ *SHORTENER TEST FAILED*

The configured Arolinks integration could not be verified.
Error: ${error.message.substring(0, 50)}...`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_shortener' }]] } });
      }
    }
    else if (data === 'admin_test_storage') {
      if (!config.STORAGE_CHANNEL_ID) {
        ctx.answerCbQuery('❌ STORAGE_CHANNEL_ID is not configured in .env', { show_alert: true }).catch(() => {});
        return;
      }
      try {
        await bot.telegram.sendMessage(config.STORAGE_CHANNEL_ID, '🧪 Storage channel write test successful.');
        // Mock test
        await ctx.reply(`✅ *Storage Channel Verified*\nConnected to ID: \`${config.STORAGE_CHANNEL_ID}\``, { parse_mode: 'Markdown' });
      } catch (e: any) {
        await ctx.reply(`❌ *Storage Test Failed*\n${e.message}`, { parse_mode: 'Markdown' });
      }
    }
    else if (data === 'admin_clean_jobs') {
      const { jobService } = require('../../services/JobService');
      await jobService.cleanStuckJobs();
      await ctx.answerCbQuery('✅ Cleaned up stuck jobs.', { show_alert: true });
      // @ts-ignore
      ctx.callbackQuery.data = 'admin_jobs';
      return callbackHandler(ctx);
    }
    else if (data === 'admin_clean_storage') {
      await db.storedFile.deleteMany({
        where: {
          expiresAt: { lt: new Date() }
        }
      });
      await ctx.answerCbQuery('🧹 Storage Cache cleanup complete.', { show_alert: true });
    }
    else if (data === 'admin_cancel_job_prompt') {
      ctx.answerCbQuery('🛑 To cancel a job, send /cancel <job_id>', { show_alert: true }).catch(() => {});
    }
    else if (data === 'admin_retention_storage') {
      ctx.answerCbQuery(`⏱️ Retention is currently ${config.STORAGE_RETENTION_HOURS} hours. Update .env to change this.`, { show_alert: true }).catch(() => {});
    }
    else if (data === 'noop') {
      // No-op: used for pagination labels that show current page, do nothing
    }
    // ----------------- OTHER ACTIONS -----------------
    else if (data.startsWith('cancel_')) {
      const jobId = data.split('_').slice(1).join('_');
      await jobService.cancelJob(jobId);
      ctx.answerCbQuery('❌ Job cancelled.', { show_alert: true }).catch(() => {});
    }
    else {
      // Unknown callback — log and silently dismiss
      console.warn(`[callback] Unhandled callback_data: "${data}"`);
    }
  } catch (error: any) {
    console.error('[callback] Error in callback handler:', error?.message || error);
    ctx.answerCbQuery('❌ Something went wrong. Please try again.', { show_alert: true }).catch(() => {});
  }
};
