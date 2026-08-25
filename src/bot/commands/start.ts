import { Context, Markup } from 'telegraf';
import { getMainKeyboard } from '../keyboards/mainKeyboard';
import { userService } from '../../services/UserService';
import { adminService } from '../../services/AdminService';
import { verificationService } from '../../verification/verification.service';
import { db } from '../../db';
import { logger } from '../../utils/logger';

export const getMainMenuText = () => {
  return `
👋 *WELCOME TO NexTeraDownloadBot*

⚡ Fast and reliable file processing bot.

Choose an option below:

⚠️ _By using this bot, you agree that you use it at your own risk._`;
};

export const startCommand = async (ctx: Context) => {
  try {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    logger.info(`Processing /start for ${telegramId}`);

    // Get or Create user
    const user = await userService.getOrCreateUser(
      telegramId,
      ctx.from?.username,
      ctx.from?.first_name,
      ctx.from?.last_name,
      ctx.from?.language_code
    );

    const isAdmin = adminService.isAdmin(telegramId);

    // ADMIN BYPASS: Force Subscribe check ONLY applies to normal users
    if (!isAdmin) {
      const { forceSubService } = require('../../services/ForceSubService');
      const isForceSubEnabled = await forceSubService.getForceSubStatus();
      if (isForceSubEnabled) {
        const checkResult = await forceSubService.checkUserMembership(ctx.telegram, telegramId);
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
    }

    const isVerificationRequired = await adminService.getVerificationStatus();
    const showVerification = isVerificationRequired && user.plan === 'FREE';

    // @ts-ignore
    const text: string = ctx.message?.text || '';

    // Check if there is a referral deep link payload (e.g. /start ref_123456789)
    const refMatch = text.match(/\/start\s+(?:ref_|r_)(\d+)/i);
    if (refMatch && refMatch[1]) {
      const referrerTelegramId = parseInt(refMatch[1], 10);
      logger.info(`[startCommand] Referral deep link received from ${referrerTelegramId} for new user ${telegramId}`);
      
      const { referralService } = require('../../services/ReferralService');
      await referralService.processReferral(referrerTelegramId, telegramId);
    }

    // Check if there is a verification deep link payload (e.g. /start verify_<token> or /start v_<token>)
    const payloadMatch = text.match(/\/start\s+(?:verify_|v_)([a-f0-9]+)/i);

    if (payloadMatch && payloadMatch[1]) {
      const rawToken = payloadMatch[1];
      logger.info(`[startCommand] Verification deep link received for user ${user.id} with token ${rawToken.substring(0, 8)}...`);

      const result = await verificationService.validateToken(rawToken);

      if (result.success) {
        // Check if user has an active job in VERIFYING state
        const pendingJob = await db.job.findFirst({
          where: {
            userId: user.id,
            status: 'VERIFYING'
          },
          orderBy: { createdAt: 'desc' }
        });

        if (pendingJob) {
          await ctx.reply(
            `✅ *VERIFICATION SUCCESSFUL!*\n\nYour account is now verified.\n\nClick *📥 Get File* below to start your download processing.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📥 Get File', callback_data: `get_file_${pendingJob.id}` }],
                  [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
                ]
              }
            }
          );
        } else {
          await ctx.reply(
            `✅ *VERIFICATION SUCCESSFUL!*\n\nYour account has been successfully verified for 15 minutes.\nYou can now send any supported TeraBox or Diskwala link to download.`,
            {
              parse_mode: 'Markdown',
              ...getMainKeyboard(isAdmin, showVerification)
            }
          );
        }
        return;
      } else {
        await ctx.reply(
          `❌ *VERIFICATION FAILED*\n\n${result.message}\n\nPlease generate a new link to try again. Zero daily usage was consumed.`,
          {
            parse_mode: 'Markdown',
            ...getMainKeyboard(isAdmin, showVerification)
          }
        );
        return;
      }
    }

    logger.info(`Sending welcome message to ${telegramId}`);
    const extraParams = {
      parse_mode: 'Markdown' as const,
      ...getMainKeyboard(isAdmin, showVerification)
    };

    await ctx.reply(getMainMenuText(), extraParams);
    logger.info(`Welcome message sent to ${telegramId} successfully`);
  } catch (err: any) {
    logger.error(`Error in startCommand: ${err.message}`);
    throw err;
  }
};
