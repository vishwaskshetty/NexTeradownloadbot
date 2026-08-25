import { Context } from 'telegraf';
import { userService } from '../../services/UserService';

export const authMiddleware = async (ctx: Context, next: () => Promise<void>) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return next();

  const user = await userService.getOrCreateUser(
    telegramId,
    ctx.from?.username,
    ctx.from?.first_name,
    ctx.from?.last_name,
    ctx.from?.language_code
  );

  if (user.isBanned) {
    if (ctx.updateType === 'message') {
      await ctx.reply('❌ You have been banned from using this bot.');
    } else if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery('❌ You have been banned from using this bot.', { show_alert: true });
    }
    return;
  }

  // Update activity
  await userService.updateUserActivity(telegramId);
  
  // Expose user to context state
  ctx.state.user = user;

  return next();
};
