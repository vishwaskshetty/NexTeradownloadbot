import { Context } from 'telegraf';
import { logger } from '../../utils/logger';

export class StatusMessageManager {
  private ctx: Context;
  private messageId: number | null = null;
  private currentText: string = '';

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async initialize(initialText: string, keyboard?: any) {
    this.currentText = initialText;
    const msg = await this.ctx.replyWithMarkdown(initialText, keyboard);
    this.messageId = msg.message_id;
  }

  async update(newText: string, keyboard?: any) {
    if (!this.messageId) return;
    if (this.currentText === newText) return; // Avoid unnecessary API calls
    
    this.currentText = newText;
    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat?.id,
        this.messageId,
        undefined,
        newText,
        { parse_mode: 'Markdown', ...keyboard }
      );
    } catch (error: any) {
      if (!error.message?.includes('message is not modified')) {
        logger.error(error, 'Error updating status message');
      }
    }
  }
}
