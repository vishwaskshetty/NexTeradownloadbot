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
bot.command('extendpremium', adminCommand);
bot.command('removepremium', adminCommand);
bot.command('viewpremium', adminCommand);
bot.command('addchannel', adminCommand);
bot.command('removechannel', adminCommand);
bot.command('setforcesubmsg', adminCommand);
bot.command('activejobs', adminCommand);
bot.command('cancel', async (ctx) => {
  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1);
  if (!args[0]) {
    return ctx.reply('Usage: /cancel <job_id>');
  }
  const { jobService } = require('./services/JobService');
  await jobService.cancelJob(args[0]);
  return ctx.reply(`❌ Job #${args[0].substring(0, 6)} has been cancelled.`);
});

bot.command('admin', async (ctx) => {
  const user = ctx.state?.user;
  if (!user || !require('./services/AdminService').adminService.isAdmin(user.telegramId)) {
    return ctx.reply('❌ ACCESS DENIED: Administrator permissions required.');
  }
  return require('./bot/handlers/callback').callbackHandler({
    ...ctx,
    callbackQuery: { data: 'admin_panel' },
    answerCbQuery: async () => true,
    editMessageText: async (text: string, extra: any) => ctx.reply(text, extra)
  } as any);
});

bot.command('account', (ctx) => {
  return require('./bot/handlers/callback').callbackHandler({
    ...ctx,
    callbackQuery: { data: 'account' },
    answerCbQuery: async () => true,
    editMessageText: async (text: string, extra: any) => ctx.reply(text, extra)
  } as any);
});

bot.command('help', (ctx) => {
  return require('./bot/handlers/callback').callbackHandler({
    ...ctx,
    callbackQuery: { data: 'help' },
    answerCbQuery: async () => true,
    editMessageText: async (text: string, extra: any) => ctx.reply(text, extra)
  } as any);
});

bot.command('referrals', (ctx) => {
  return require('./bot/handlers/callback').callbackHandler({
    ...ctx,
    callbackQuery: { data: 'referrals' },
    answerCbQuery: async () => true,
    editMessageText: async (text: string, extra: any) => ctx.reply(text, extra)
  } as any);
});

bot.command('disclaimer', (ctx) => {
  return require('./bot/handlers/callback').callbackHandler({
    ...ctx,
    callbackQuery: { data: 'disclaimer' },
    answerCbQuery: async () => true,
    editMessageText: async (text: string, extra: any) => ctx.reply(text, extra)
  } as any);
});

// Actions/Callbacks
bot.on('callback_query', (ctx) => callbackHandler(ctx));

// Messages
bot.on('text', (ctx) => messageHandler(ctx));

// Start the bot gracefully
let isBotRunning = false;
let workersInitialized = false;

const start = async () => {
  try {
    // 1. Connect/check PostgreSQL
    if (config.NODE_ENV !== 'test') {
      try {
        logger.info('Checking PostgreSQL...');
        await db.$queryRaw`SELECT 1`;
        logger.info('Connected to PostgreSQL successfully\n');
      } catch (err) {
        throw new Error('Could not connect to PostgreSQL at startup.');
      }
    }

    // 2. Connect/check Redis
    if (config.NODE_ENV !== 'test') {
      try {
        logger.info('Checking Redis...');
        const { redis } = require('./redis');
        await redis.ping();
        console.log('');
      } catch (err) {
        throw new Error('Redis connection failed during startup health check.');
      }
    }

    // 3. Start Express HTTP verification & Admin server (listens on PORT or 3000)
    if (config.NODE_ENV !== 'test') {
       logger.info('Starting HTTP server...');
       const port = Number(process.env.PORT) || 3000;
       server = startServer(port);
       logger.info(`HTTP server started successfully on port ${port}\n`);
    }

    // 4. Initialize download and system workers (Runs in both Dev & Production)
    if (config.NODE_ENV !== 'test' && !workersInitialized) {
       logger.info('Initializing workers...');
       const { initWorker } = require('./queue/worker');
       const { initBroadcastWorker } = require('./queue/broadcast');
       const { initCleanupWorker } = require('./queue/cleanup');
       initWorker();
       initBroadcastWorker();
       initCleanupWorker();
       workersInitialized = true;
       logger.info('Workers initialized successfully\n');
    }

    // 5. Remove any leftover Telegram webhooks before long polling
    logger.info('Removing Telegram webhook...');
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      logger.info('Telegram webhook removed successfully\n');
    } catch (e) {
      logger.error('Failed to remove Telegram webhook.');
    }

    // 6. Start Telegram bot long polling (Runs in both Dev & Production)
    if (config.NODE_ENV !== 'test') {
      logger.info('🚀 Starting NexTeraDownloadBot Telegram polling...');

      bot.launch({ dropPendingUpdates: true })
        .then(() => {
          isBotRunning = true;
          logger.info('🟢 PostgreSQL connected');
          logger.info('🟢 Redis connected');
          logger.info('🟢 HTTP server started');
          logger.info('🟢 Queue initialized');
          logger.info('🟢 Workers initialized');
          logger.info('🟢 Telegram bot started');
          logger.info('🤖 NexTeraDownloadBot is online 24/7');
        })
        .catch((err) => {
          isBotRunning = false;
          logger.error(`❌ Telegram launch failed: ${err.message}`);
        });
    }

  } catch (error: any) {
    if (error.code === 'EPERM' && error.message.includes('query_engine-windows.dll.node')) {
      logger.warn('Windows EPERM lock detected on Prisma.');
    } else {
      logger.error(`Failed to start the bot: ${error.message}`);
    }
    
    if (server) {
      server.close();
    }
    
    await db.$disconnect();
    
    if (config.NODE_ENV !== 'test') {
      try {
        const { redis } = require('./redis');
        await redis.quit();
      } catch (e) {}
    }
    
    process.exit(1);
  }
};

if (config.NODE_ENV !== 'test') {
  start();
}

// Graceful shutdown handling for Railway / Docker / Kubernetes
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
    } catch (error) {}
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
  } finally {
    logger.info('✅ Shutdown complete');
    process.exit(0);
  }
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

export { bot };
