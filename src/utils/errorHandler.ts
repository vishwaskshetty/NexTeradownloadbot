import { logger } from './logger';
import { Context } from 'telegraf';

export class AppError extends Error {
  public readonly isOperational: boolean;

  constructor(message: string, isOperational = true) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.isOperational = isOperational;
    Error.captureStackTrace(this);
  }
}

export const handleError = async (error: Error | AppError, ctx?: Context) => {
  logger.error({
    msg: error.message,
    stack: error.stack,
    isOperational: error instanceof AppError ? error.isOperational : false,
    updateType: ctx?.updateType,
  });

  if (ctx) {
    try {
      await ctx.reply('❌ An unexpected error occurred. Please try again later.');
    } catch (replyError) {
      logger.error(replyError, 'Failed to send error message to user:');
    }
  }
};
