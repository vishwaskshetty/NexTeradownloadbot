import { Context } from 'telegraf';
import { redis } from '../../redis';
import { adminService } from '../../services/AdminService';

// Rate limit only applies to text messages to prevent spam
// Callbacks are never rate-limited — they must always be answered
const WINDOW_SECS = 5;
const MAX_MESSAGES = 5; // 5 messages per 5 seconds

export const rateLimitMiddleware = async (ctx: Context, next: () => Promise<void>) => {
  // Never rate-limit callback queries — Telegram requires immediate answerCbQuery
  if (ctx.updateType === 'callback_query') {
    return next();
  }

  const userId = ctx.from?.id;
  if (!userId) return next();

  // Never rate-limit admins
  if (adminService.isAdmin(userId)) {
    return next();
  }

  const key = `ratelimit:${userId}`;
  
  try {
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, WINDOW_SECS);
    }

    if (count > MAX_MESSAGES) {
      if (ctx.updateType === 'message') {
        await ctx.reply('⚠️ You are sending messages too fast. Please slow down.').catch(() => {});
      }
      return;
    }
  } catch (error) {
    // Fail open if Redis is disconnected
  }

  return next();
};
