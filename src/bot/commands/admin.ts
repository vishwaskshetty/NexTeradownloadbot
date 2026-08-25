import { Context } from 'telegraf';
import type { User } from '@prisma/client';
import { adminService } from '../../services/AdminService';
import { userService } from '../../services/UserService';
import { jobService } from '../../services/JobService';
import { db } from '../../db';

export const adminCommand = async (ctx: Context) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || !adminService.isAdmin(telegramId)) {
    return; // Silently ignore non-admins
  }

  // @ts-ignore
  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1);
  // @ts-ignore
  const command = ctx.message?.text.split(' ')[0].substring(1); // gets 'stats' from '/stats'

  switch(command) {
    case 'adminpanel':
      const { generateAdminToken } = require('../../admin/adminRouter');
      const token = generateAdminToken();
      // Using process.env.PORT or 3000 assuming the bot runs on the same machine
      const port = process.env.PORT || 3000;
      const adminUrl = `http://localhost:${port}/admin/verify-token?token=${token}`;
      return ctx.reply(`Here is your one-time admin panel login link (valid for 15 minutes):\n\n${adminUrl}`);

    case 'verification':
      if (args[0] === 'on') {
        await adminService.setVerificationStatus(true);
        return ctx.reply('✅ Global Verification is now ON.');
      } else if (args[0] === 'off') {
        await adminService.setVerificationStatus(false);
        return ctx.reply('⚠️ Global Verification is now OFF. Free users bypass verification.');
      } else if (args[0] === 'status') {
        const status = await adminService.getVerificationStatus();
        return ctx.reply(`Global Verification is currently ${status ? 'ON' : 'OFF'}.`);
      }
      return ctx.reply('Usage: /verification [on|off|status]');

    case 'stats':
      const userCount = await db.user.count();
      const jobCount = await db.job.count();
      const usageCount = await db.userUsage.aggregate({ _sum: { dailyRequests: true } });
      return ctx.reply(`📊 *Admin Stats*\n\nTotal Users: ${userCount}\nTotal Jobs: ${jobCount}\nTotal Requests Today: ${usageCount._sum.dailyRequests || 0}`, { parse_mode: 'Markdown' });

    case 'users':
      const recentUsers = await db.user.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
      const userList = recentUsers.map((u: User) => `${u.id} - ${u.username || u.firstName} [${u.plan}]`).join('\n');
      return ctx.reply(`Recent Users:\n${userList}`);

    case 'ban':
      if (!args[0]) return ctx.reply('Usage: /ban <telegramId>');
      await userService.banUser(parseInt(args[0], 10));
      return ctx.reply(`✅ Banned user ${args[0]}`);

    case 'unban':
      if (!args[0]) return ctx.reply('Usage: /unban <telegramId>');
      await userService.unbanUser(parseInt(args[0], 10));
      return ctx.reply(`✅ Unbanned user ${args[0]}`);

    case 'addpremium':
      if (!args[0]) return ctx.reply('Usage: /addpremium <telegramId>');
      // Find internal DB ID by Telegram ID
      const pUser = await db.user.findUnique({ where: { telegramId: BigInt(args[0]) }});
      if (!pUser) return ctx.reply('User not found.');
      await adminService.setPremiumUser(pUser.id, true);
      return ctx.reply(`⭐ Premium added to ${args[0]}`);

    case 'removepremium':
      if (!args[0]) return ctx.reply('Usage: /removepremium <telegramId>');
      const rUser = await db.user.findUnique({ where: { telegramId: BigInt(args[0]) }});
      if (!rUser) return ctx.reply('User not found.');
      await adminService.setPremiumUser(rUser.id, false);
      return ctx.reply(`❌ Premium removed from ${args[0]}`);

    case 'broadcast':
      if (args.length === 0) return ctx.reply('Usage: /broadcast <message>');
      const msg = args.join(' ');
      const { broadcastQueue } = require('../../queue/jobQueue');
      await broadcastQueue.add('broadcastMessage', { text: msg });
      return ctx.reply(`📢 Broadcast queued: ${msg}`);

    case 'activejobs':
      const jobs = await db.job.count({ where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING'] } } });
      return ctx.reply(`⏳ Currently active processing jobs: ${jobs}`);

    default:
      return ctx.reply('Unknown command or feature pending (setlimit, platforms).');
  }
};
