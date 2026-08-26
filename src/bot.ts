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
import os from 'os';
import crypto from 'crypto';

const PROCESS_INSTANCE_ID = `${os.hostname()}_pid${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const bot = new Telegraf(config.BOT_TOKEN);
let server: http.Server | null = null;
let isPollingLaunched = false;
let isBotRunning = false;
let workersInitialized = false;
let pollingLockRenewalTimer: NodeJS.Timeout | null = null;

import { pollingManager } from './bot/pollingManager';

// Global Error Handler & 409 Conflict Guard
bot.catch(async (err: unknown, ctx) => {
  const error = err as any;
  if (error?.response?.error_code === 409 || error?.message?.includes('409') || error?.message?.includes('Conflict')) {
    logger.warn(`⚠️ [Telegram 409 Conflict] Conflict detected on PID ${process.pid} (${os.hostname()}). Handling via PollingManager.`);
    await pollingManager.handleConflict();
    return;
  }
  handleError(err as Error, ctx);
});

// Diagnostic Health Update Interceptor
bot.use(async (ctx, next) => {
  if (ctx.message && 'text' in ctx.message) {
    const updateId = ctx.update.update_id;
    console.log(`[Telegram Health] update_id received: ${updateId}`);
    console.log(`[Telegram Health] update accepted: YES`);
    console.log(`[Telegram Health] MESSAGE RECEIVED`);
    if (ctx.message.text.startsWith('/start')) {
      console.log(`[Telegram Health] START RECEIVED`);
      console.log(`[Telegram Health] Sending test response`);
      try {
        await ctx.reply('Telegram polling is working.');
        console.log(`[Telegram Health] Test response sent: YES`);
      } catch (e: any) {
        console.error(`[Telegram Health] Test response failed: ${e.message}`);
      }
    }
  }
  return next();
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

export const start = async () => {
  try {
    logger.info(`[Startup] Initializing application process (PID: ${process.pid}, Host: ${os.hostname()}, Instance: ${PROCESS_INSTANCE_ID})`);

    // 1. Connect/check PostgreSQL
    if (config.NODE_ENV !== 'test') {
      const maskedUrl = (config.DATABASE_URL || '').replace(/:([^:@]+)@/, ':***@');
      logger.info('Checking PostgreSQL...');
      logger.info(`[DB] Connecting to: ${maskedUrl}`);
      
      let dbConnected = false;
      let lastDbError: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await db.$queryRawUnsafe('SELECT 1');
          dbConnected = true;
          logger.info('Connected to PostgreSQL successfully\n');
          break;
        } catch (err: any) {
          lastDbError = err;
          if (attempt < 3) {
            logger.warn(`[DB] PostgreSQL connection attempt ${attempt} failed: ${err.message?.split('\n')[0] ?? err}. Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      if (!dbConnected) {
        logger.error(`[DB] Connection failed after 3 attempts: ${lastDbError?.message?.split('\n')[0] ?? lastDbError}`);
        logger.error(`[DB] Check DATABASE_URL in .env — currently: ${maskedUrl}`);
        logger.error('[DB] For Supabase: use port 6543 (transaction pooler) with ?sslmode=require&pgbouncer=true');
        throw new Error('Could not connect to PostgreSQL at startup. Check DATABASE_URL in .env.');
      }
    }

    // 2. Connect/check Redis
    if (config.NODE_ENV !== 'test') {
      const { redis, redisHost } = require('./redis');
      const maskedRedisUrl = (config.REDIS_URL || '').replace(/:([^:@]+)@/, ':***@');
      logger.info('Checking Redis...');
      logger.info(`[Redis Health] Provider: ${redisHost}`);
      logger.info(`[Redis] Connecting to: ${maskedRedisUrl}`);
      
      let redisConnected = false;
      let lastRedisError: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const pong = await Promise.race([
            redis.ping(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Redis ping timeout')), 10000)
            ),
          ]);
          redisConnected = true;
          logger.info(`[Redis Health] Connection: SUCCESS`);
          logger.info(`[Redis Health] Ping: ${pong}`);
          logger.info(`[Redis Health] BullMQ Redis: READY`);
          logger.info('Redis connected successfully\n');
          break;
        } catch (err: any) {
          lastRedisError = err;
          if (attempt < 3) {
            logger.warn(`[Redis] Connection attempt ${attempt} failed: ${err.message}. Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      if (!redisConnected) {
        logger.error(`[Redis] Connection failed after 3 attempts: ${lastRedisError?.message ?? lastRedisError}`);
        logger.error(`[Redis] Check REDIS_URL in .env — currently: ${maskedRedisUrl}`);
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

    // 5. Start Distributed Telegram Polling Manager
    if (config.NODE_ENV !== 'test' && config.ENABLE_TELEGRAM_POLLING) {
       await pollingManager.start(bot);
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

// Start application only when executed as the main entrypoint (prevents duplicate start when imported by workers/tests)
if (require.main === module && config.NODE_ENV !== 'test') {
  start();
}

// Graceful shutdown handling for Railway / Docker / Kubernetes
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('');
  logger.info(`🛑 Received ${signal} on PID ${process.pid} (${os.hostname()})`);
  logger.info('🧹 Shutting down...');

  // Stop polling manager and release distributed lock atomically
  await pollingManager.stop(signal);

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
process.on('uncaughtException', (err) => {
  logger.error(`[Process] Uncaught Exception: ${err.message}`);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason: any) => {
  logger.error(`[Process] Unhandled Rejection: ${reason?.message || reason}`);
});

export { bot };


