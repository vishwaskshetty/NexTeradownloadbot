"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminCommand = void 0;
const AdminService_1 = require("../../services/AdminService");
const UserService_1 = require("../../services/UserService");
const db_1 = require("../../db");
const adminCommand = async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !AdminService_1.adminService.isAdmin(telegramId)) {
        return; // Silently ignore non-admins
    }
    // @ts-ignore
    const text = ctx.message?.text || '';
    const args = text.split(' ').filter(Boolean).slice(1);
    // @ts-ignore
    const command = ctx.message?.text.split(' ')[0].substring(1);
    switch (command) {
        case 'adminpanel': {
            const { generateAdminToken } = require('../../admin/adminRouter');
            const token = generateAdminToken();
            const port = process.env.PORT || 3000;
            const adminUrl = `http://localhost:${port}/admin/verify-token?token=${token}`;
            return ctx.reply(`Here is your one-time admin panel login link (valid for 15 minutes):\n\n${adminUrl}`);
        }
        case 'verification': {
            if (args[0] === 'on') {
                await AdminService_1.adminService.setVerificationStatus(true);
                return ctx.reply('✅ Global Verification is now ON.');
            }
            else if (args[0] === 'off') {
                await AdminService_1.adminService.setVerificationStatus(false);
                return ctx.reply('⚠️ Global Verification is now OFF. Free users bypass verification.');
            }
            else if (args[0] === 'status') {
                const status = await AdminService_1.adminService.getVerificationStatus();
                return ctx.reply(`Global Verification is currently ${status ? 'ON' : 'OFF'}.`);
            }
            return ctx.reply('Usage: /verification [on|off|status]');
        }
        case 'stats': {
            const userCount = await db_1.db.user.count();
            const jobCount = await db_1.db.job.count();
            const usageCount = await db_1.db.userUsage.aggregate({ _sum: { dailyRequests: true } });
            return ctx.reply(`📊 *Admin Stats*\n\nTotal Users: ${userCount}\nTotal Jobs: ${jobCount}\nTotal Requests Today: ${usageCount._sum.dailyRequests || 0}`, { parse_mode: 'Markdown' });
        }
        case 'users': {
            const recentUsers = await db_1.db.user.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
            const userList = recentUsers.map((u) => `${u.id} - ${u.username ? '@' + u.username : u.firstName} [${u.plan}]`).join('\n');
            return ctx.reply(`Recent Users:\n${userList}`);
        }
        case 'ban': {
            if (!args[0])
                return ctx.reply('Usage: /ban <telegramId>');
            await UserService_1.userService.banUser(parseInt(args[0], 10));
            return ctx.reply(`✅ Banned user ${args[0]}`);
        }
        case 'unban': {
            if (!args[0])
                return ctx.reply('Usage: /unban <telegramId>');
            await UserService_1.userService.unbanUser(parseInt(args[0], 10));
            return ctx.reply(`✅ Unbanned user ${args[0]}`);
        }
        case 'addchannel': {
            if (args.length < 3) {
                return ctx.reply('Usage: /addchannel <channel_id_or_username> <channel_name> <invite_url>\n\nExample:\n/addchannel -100123456789 "Main Channel" https://t.me/examplechannel');
            }
            const chId = args[0];
            const chName = args[1];
            const chUrl = args[2];
            const { forceSubService } = require('../../services/ForceSubService');
            await forceSubService.addChannel({
                id: chId,
                username: chId.startsWith('@') ? chId.replace('@', '') : undefined,
                name: chName,
                inviteUrl: chUrl
            });
            return ctx.reply(`✅ Added force sub channel: *${chName}* (\`${chId}\`)`, { parse_mode: 'Markdown' });
        }
        case 'removechannel': {
            if (!args[0])
                return ctx.reply('Usage: /removechannel <channel_id_or_username>');
            const { forceSubService } = require('../../services/ForceSubService');
            const removed = await forceSubService.removeChannel(args[0]);
            if (removed) {
                return ctx.reply(`✅ Removed force sub channel \`${args[0]}\``, { parse_mode: 'Markdown' });
            }
            else {
                return ctx.reply(`❌ Channel \`${args[0]}\` was not found.`, { parse_mode: 'Markdown' });
            }
        }
        case 'setforcesubmsg': {
            if (args.length === 0)
                return ctx.reply('Usage: /setforcesubmsg <custom_message_text>');
            const msgText = args.join(' ');
            const { forceSubService } = require('../../services/ForceSubService');
            await forceSubService.setCustomMessage(msgText);
            return ctx.reply(`✅ Force sub message updated:\n\n${msgText}`, { parse_mode: 'Markdown' });
        }
        case 'addpremium': {
            if (!args[0])
                return ctx.reply('Usage: /addpremium <telegramId> [days]');
            const targetId = parseInt(args[0], 10);
            const days = args[1] ? parseInt(args[1], 10) : 30;
            try {
                const result = await UserService_1.userService.addPremium(telegramId, targetId, days);
                const expiresStr = result.newExpiry.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
                return ctx.reply(`✅ *PREMIUM ACTIVATED*\n\n👤 *User ID:* \`${targetId}\`\n⭐ *Plan:* Premium\n⏱ *Duration:* ${days} Days\n📅 *Expires:* ${expiresStr}`, { parse_mode: 'Markdown' });
            }
            catch (err) {
                return ctx.reply(err.message || '❌ Failed to add premium.', { parse_mode: 'Markdown' });
            }
        }
        case 'extendpremium': {
            if (!args[0] || !args[1])
                return ctx.reply('Usage: /extendpremium <telegramId> <days>');
            const targetId = parseInt(args[0], 10);
            const days = parseInt(args[1], 10);
            try {
                const result = await UserService_1.userService.extendPremium(telegramId, targetId, days);
                const oldExpStr = result.previousExpiry ? new Date(result.previousExpiry).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'None';
                const newExpStr = result.newExpiry.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
                return ctx.reply(`➕ *PREMIUM EXTENDED*\n\n👤 *User ID:* \`${targetId}\`\n⏱ *Added Duration:* ${days} Days\n📅 *Previous Expiry:* ${oldExpStr}\n📅 *New Expiry:* ${newExpStr}`, { parse_mode: 'Markdown' });
            }
            catch (err) {
                return ctx.reply(err.message || '❌ Failed to extend premium.', { parse_mode: 'Markdown' });
            }
        }
        case 'removepremium': {
            if (!args[0])
                return ctx.reply('Usage: /removepremium <telegramId>');
            const targetId = parseInt(args[0], 10);
            try {
                const result = await UserService_1.userService.removePremium(telegramId, targetId);
                const prevExpStr = result.previousExpiry ? new Date(result.previousExpiry).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'None';
                return ctx.reply(`✅ *PREMIUM REMOVED*\n\n👤 *User ID:* \`${targetId}\`\n⭐ *Previous Plan:* Premium\n📅 *Previous Expiry:* ${prevExpStr}`, { parse_mode: 'Markdown' });
            }
            catch (err) {
                return ctx.reply(err.message || '❌ Failed to remove premium.', { parse_mode: 'Markdown' });
            }
        }
        case 'viewpremium': {
            if (!args[0])
                return ctx.reply('Usage: /viewpremium <telegramId>');
            const targetId = parseInt(args[0], 10);
            const detail = await UserService_1.userService.getPremiumUserDetail(targetId);
            if (!detail) {
                return ctx.reply('❌ User not found.', { parse_mode: 'Markdown' });
            }
            const u = detail.user;
            const expStr = u.premiumExpiresAt ? new Date(u.premiumExpiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
            const createdStr = new Date(u.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' });
            return ctx.reply(`👤 *USER PREMIUM DETAILS*\n\n` +
                `*Telegram ID:* \`${u.telegramId}\`\n` +
                `*Username:* ${u.username ? '@' + u.username : 'N/A'}\n` +
                `*Name:* ${u.firstName || ''} ${u.lastName || ''}\n\n` +
                `*Plan:* ${detail.isActive ? '⭐ PREMIUM' : '🆓 FREE'}\n` +
                `*Status:* ${detail.statusText}\n\n` +
                `*Started:* ${createdStr}\n` +
                `*Expires:* ${expStr}\n` +
                `*Remaining:* ${detail.remainingDays} days\n` +
                `*Daily Limit:* ${detail.dailyLimit}`, { parse_mode: 'Markdown' });
        }
        case 'broadcast': {
            if (args.length === 0)
                return ctx.reply('Usage: /broadcast <message>');
            const msg = args.join(' ');
            const { broadcastQueue } = require('../../queue/jobQueue');
            await broadcastQueue.add('broadcastMessage', { text: msg });
            return ctx.reply(`📢 Broadcast queued: ${msg}`);
        }
        case 'activejobs': {
            const jobs = await db_1.db.job.count({ where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING'] } } });
            return ctx.reply(`⏳ Currently active processing jobs: ${jobs}`);
        }
        default:
            return ctx.reply('Unknown command or feature pending.');
    }
};
exports.adminCommand = adminCommand;
