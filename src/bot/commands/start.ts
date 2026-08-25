import { Context } from 'telegraf';
import { getMainKeyboard } from '../keyboards/mainKeyboard';
import { userService } from '../../services/UserService';
import { adminService } from '../../services/AdminService';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export const getMainMenuText = () => {
  return `
👋 *WELCOME TO NexTeraDownloadBot*

⚡ Fast and reliable file processing bot.

Choose an option below:`;
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

    logger.info(`Sending welcome message to ${telegramId}`);
    const isAdmin = adminService.isAdmin(telegramId);
    const isVerificationRequired = await adminService.getVerificationStatus();
    const showVerification = isVerificationRequired && user.plan === 'FREE';
    
    // Explicitly destructure keyboard into extra params to avoid Telegraf 4.x type/serialization issues
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
