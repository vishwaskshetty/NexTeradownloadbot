"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusMessageManager = void 0;
const logger_1 = require("../../utils/logger");
class StatusMessageManager {
    ctx;
    messageId = null;
    currentText = '';
    constructor(ctx) {
        this.ctx = ctx;
    }
    async initialize(initialText, keyboard) {
        this.currentText = initialText;
        const msg = await this.ctx.replyWithMarkdown(initialText, keyboard);
        this.messageId = msg.message_id;
    }
    async update(newText, keyboard) {
        if (!this.messageId)
            return;
        if (this.currentText === newText)
            return; // Avoid unnecessary API calls
        this.currentText = newText;
        try {
            await this.ctx.telegram.editMessageText(this.ctx.chat?.id, this.messageId, undefined, newText, { parse_mode: 'Markdown', ...keyboard });
        }
        catch (error) {
            if (!error.message?.includes('message is not modified')) {
                logger_1.logger.error(error, 'Error updating status message');
            }
        }
    }
}
exports.StatusMessageManager = StatusMessageManager;
