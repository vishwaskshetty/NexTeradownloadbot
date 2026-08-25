import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { config } from './config';
import { logger } from './utils/logger';
import { db } from './db';
import { handleError } from './utils/errorHandler';
import { startCommand } from './bot/commands/start';
import { adminCommand } from './bot/commands/admin';
import { authMiddleware } from './bot/middleware/auth';
import { callbackHandler } from './bot/handlers/callback';
import { messageHandler } from './bot/handlers/message';
import { startServer } from './server';
import http from 'http';

const bot = new Telegraf(config.BOT_TOKEN);
let server: http.Server | null = null;

// Global Error Handler
bot.catch((err: unknown, ctx) => {
  handleError(err as Error, ctx);
});

// Middleware
import { rateLimitMiddleware } from './bot/middleware/rateLimit';
bot.use(rateLimitMiddleware);
bot.use(authMiddleware);

// Commands
bot.start(startCommand);
bot.command('adminpanel', adminCommand);
bot.command('verification', adminCommand);
bot.command('stats', adminCommand);
bot.command('users', adminCommand);
bot.command('ban', adminCommand);
bot.command('unban', adminCommand);
bot.command('broadcast', adminCommand);
bot.command('setlimit', adminCommand);
bot.command('setdaily', adminCommand);
bot.command('platforms', adminCommand);
bot.command('premium', adminCommand);
bot.command('addpremium', adminCommand);
bot.command('removepremium', adminCommand);
bot.command('activejobs', adminCommand);
bot.command('account', (ctx) => {
  // Simulate clicking the account button
  ctx.state.simulateAccount = true;
  return require('./bot/handlers/callback').callbackHandler({
    ...ctx,
    callbackQuery: { data: 'account' },
    answerCbQuery: async () => true,
    editMessageText: async (text: string, extra: any) => ctx.reply(text, extra)
  } as any);
});

// Actions/Callbacks
bot.on('callback_query', callbackHandler);

// Messages
bot.on('text', messageHandler);

// Start the bot gracefully
let isBotRunning = false;

const start = async () => {
  try {
    // 1. Validate environment
    // (config/index.ts already does this on import)

    // 2. Connect/check PostgreSQL
    if (config.NODE_ENV !== 'test') {
      try {
        logger.info('Checking PostgreSQL...');
        await db.$queryRaw`SELECT 1`;
        logger.info('Connected to PostgreSQL successfully\n');
      } catch (err) {
        throw new Error('Could not connect to PostgreSQL at startup.');
      }
    }

    // 3. Connect/check Redis
    if (config.NODE_ENV !== 'test') {
      try {
        logger.info('Checking Redis...');
        const { redis } = require('./redis');
        await redis.ping();
        // The success log is handled by redis.ts connect event, 
        // but we'll ensure the spacing looks correct if needed.
        console.log(''); // Blank line to match requested format
      } catch (err) {
        throw new Error('Redis connection failed during startup health check.');
      }
    }

    // 4. Start HTTP verification server
    if (config.NODE_ENV !== 'test') {
       logger.info('Starting HTTP server...');
       const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
       server = startServer(port);
       logger.info('HTTP server started successfully\n');
    }

    // 5. Initialize workers/queues (ONLY IF NOT IN PRODUCTION)
    let workersInitialized = false;
    if (config.NODE_ENV !== 'test' && config.NODE_ENV !== 'production' && !workersInitialized) {
       logger.info('Initializing workers locally...');
       const { initWorker } = require('./queue/worker');
       const { initBroadcastWorker } = require('./queue/broadcast');
       const { initCleanupWorker } = require('./queue/cleanup');
       initWorker();
       initBroadcastWorker();
       initCleanupWorker();
       workersInitialized = true;
       logger.info('Workers initialized successfully locally\n');
    }

    // 6. Remove any Telegram webhook
    logger.info('Removing Telegram webhook...');
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      logger.info('Telegram webhook removed successfully\n');
    } catch (e) {
      logger.error('Failed to remove Telegram webhook.');
    }

    // 7. Start Telegram long polling & Confirm successful startup
    // 9. Keep process alive if local
    if (config.NODE_ENV !== 'production') {
      bot.launch({ dropPendingUpdates: true }).catch(err => {
        logger.error(`Telegram launch failed: ${err.message}`);
        isBotRunning = false;
      });
      isBotRunning = true;
      console.log('');
      logger.info('🚀 Starting NexTeraDownloadBot...');
      logger.info('🟢 PostgreSQL connected');
      logger.info('🟢 Redis connected');
      logger.info('🟢 HTTP server started');
      logger.info('🟢 Queue initialized');
      logger.info('🟢 Workers initialized');
      logger.info('🟢 Telegram bot started');
      logger.info('🤖 NexTeraDownloadBot is online');
      console.log('');
    }

  } catch (error: any) {
    if (error.code === 'EPERM' && error.message.includes('query_engine-windows.dll.node')) {
      logger.warn('Windows EPERM lock detected on Prisma. Please run: taskkill /F /IM node.exe');
    } else {
      logger.error(`Failed to start the bot: ${error.message}`);
    }
    
    // Cleanup before exit
    if (server) {
      server.close();
    }
    
    await db.$disconnect();
    
    if (config.NODE_ENV !== 'test') {
      try {
        const { redis } = require('./redis');
        await redis.quit();
      } catch (e) {
        // Ignore redis cleanup errors
      }
    }
    
    process.exit(1);
  }
};

if (config.NODE_ENV !== 'test') {
  start();
}

// Graceful shutdown handling
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('');
  logger.info(`🛑 Received ${signal}`);
  logger.info('🧹 Shutting down...');

  if (isBotRunning) {
    try {
      bot.stop(signal);
      logger.info('🟢 Telegram stopped');
    } catch (error) {
      // Ignore
    }
    isBotRunning = false;
  }

  try {
    const { closeWorker } = require('./queue/worker');
    const { closeBroadcastWorker } = require('./queue/broadcast');
    const { closeCleanupWorker } = require('./queue/cleanup');
    
    await Promise.allSettled([
      closeWorker && closeWorker(),
      closeBroadcastWorker && closeBroadcastWorker(),
      closeCleanupWorker && closeCleanupWorker()
    ]);
    logger.info('🟢 Workers stopped');

    if (server) {
      server.close();
      logger.info('🟢 HTTP server stopped');
    }

    if (config.NODE_ENV !== 'test') {
      const { redis } = require('./redis');
      await redis.quit();
      logger.info('🟢 Redis disconnected');
    }

    await db.$disconnect();
    logger.info('🟢 PostgreSQL disconnected');

  } catch (err: any) {
    // Suppress shutdown errors
  } finally {
    logger.info('✅ Shutdown complete');
    process.exit(0);
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

export { bot }; // export for testing
