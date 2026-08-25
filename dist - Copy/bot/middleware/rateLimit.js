"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimitMiddleware = void 0;
const redis_1 = require("../../redis");
const AdminService_1 = require("../../services/AdminService");
// Rate limit only applies to text messages to prevent spam
// Callbacks are never rate-limited — they must always be answered
const WINDOW_SECS = 5;
const MAX_MESSAGES = 5; // 5 messages per 5 seconds
const rateLimitMiddleware = async (ctx, next) => {
    // Never rate-limit callback queries — Telegram requires immediate answerCbQuery
    if (ctx.updateType === 'callback_query') {
        return next();
    }
    const userId = ctx.from?.id;
    if (!userId)
        return next();
    // Never rate-limit admins
    if (AdminService_1.adminService.isAdmin(userId)) {
        return next();
    }
    const key = `ratelimit:${userId}`;
    try {
        const count = await redis_1.redis.incr(key);
        if (count === 1) {
            await redis_1.redis.expire(key, WINDOW_SECS);
        }
        if (count > MAX_MESSAGES) {
            if (ctx.updateType === 'message') {
                await ctx.reply('⚠️ You are sending messages too fast. Please slow down.').catch(() => { });
            }
            return;
        }
    }
    catch (error) {
        // Fail open if Redis is disconnected
    }
    return next();
};
exports.rateLimitMiddleware = rateLimitMiddleware;
