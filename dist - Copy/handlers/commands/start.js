"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCommand = void 0;
const telegraf_1 = require("telegraf");
const startCommand = async (ctx) => {
    const welcomeMessage = `
👋 *Welcome to NexTeraDownloadBot!*

I am a professional bot designed to help you download files directly from supported platforms.

*Supported Links:*
✅ TeraBox (terabox.com, etc.)
✅ Diskwala (diskwala.com, etc.)

*Current Limits:*
🔹 1 active download process per user at a time.
🔹 Only single file extraction is supported currently.

*How to use:*
Just send me a supported link and I'll take care of the rest!
  `;
    const inlineKeyboard = telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.url('Help & Support', 'https://t.me/support')],
        [telegraf_1.Markup.button.callback('View My Stats', 'view_stats')]
    ]);
    return ctx.replyWithMarkdown(welcomeMessage, inlineKeyboard);
};
exports.startCommand = startCommand;
