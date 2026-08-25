"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const UserService_1 = require("../../services/UserService");
const authMiddleware = async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId)
        return next();
    const user = await UserService_1.userService.getOrCreateUser(telegramId, ctx.from?.username, ctx.from?.first_name, ctx.from?.last_name, ctx.from?.language_code);
    if (user.isBanned) {
        if (ctx.updateType === 'message') {
            await ctx.reply('❌ You have been banned from using this bot.');
        }
        else if (ctx.updateType === 'callback_query') {
            await ctx.answerCbQuery('❌ You have been banned from using this bot.', { show_alert: true });
        }
        return;
    }
    // Update activity
    await UserService_1.userService.updateUserActivity(telegramId);
    // Expose user to context state
    ctx.state.user = user;
    return next();
};
exports.authMiddleware = authMiddleware;
