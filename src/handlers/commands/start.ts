import { Context, Markup } from 'telegraf';

export const startCommand = async (ctx: Context) => {
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
  
  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.url('Help & Support', 'https://t.me/support')],
    [Markup.button.callback('View My Stats', 'view_stats')]
  ]);

  return ctx.replyWithMarkdown(welcomeMessage, inlineKeyboard);
};
