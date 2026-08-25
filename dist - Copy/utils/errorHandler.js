"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleError = exports.AppError = void 0;
const logger_1 = require("./logger");
class AppError extends Error {
    isOperational;
    constructor(message, isOperational = true) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.isOperational = isOperational;
        Error.captureStackTrace(this);
    }
}
exports.AppError = AppError;
const handleError = async (error, ctx) => {
    logger_1.logger.error({
        msg: error.message,
        stack: error.stack,
        isOperational: error instanceof AppError ? error.isOperational : false,
        updateType: ctx?.updateType,
    });
    if (ctx) {
        try {
            await ctx.reply('❌ An unexpected error occurred. Please try again later.');
        }
        catch (replyError) {
            logger_1.logger.error(replyError, 'Failed to send error message to user:');
        }
    }
};
exports.handleError = handleError;
