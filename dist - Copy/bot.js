"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bot = void 0;
require("dotenv/config");
const telegraf_1 = require("telegraf");
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
const db_1 = require("./db");
const errorHandler_1 = require("./utils/errorHandler");
const start_1 = require("./bot/commands/start");
const admin_1 = require("./bot/commands/admin");
const auth_1 = require("./bot/middleware/auth");
const callback_1 = require("./bot/handlers/callback");
const message_1 = require("./bot/handlers/message");
const server_1 = require("./server");
const bot = new telegraf_1.Telegraf(config_1.config.BOT_TOKEN);
exports.bot = bot;
let server = null;
// Global Error Handler
bot.catch((err, ctx) => {
    (0, errorHandler_1.handleError)(err, ctx);
});
// Middleware
const rateLimit_1 = require("./bot/middleware/rateLimit");
bot.use(rateLimit_1.rateLimitMiddleware);
bot.use(auth_1.authMiddleware);
// Commands
bot.start(start_1.startCommand);
bot.command('adminpanel', admin_1.adminCommand);
bot.command('verification', admin_1.adminCommand);
bot.command('stats', admin_1.adminCommand);
bot.command('users', admin_1.adminCommand);
bot.command('ban', admin_1.adminCommand);
bot.command('unban', admin_1.adminCommand);
bot.command('broadcast', admin_1.adminCommand);
bot.command('setlimit', admin_1.adminCommand);
bot.command('setdaily', admin_1.adminCommand);
bot.command('platforms', admin_1.adminCommand);
bot.command('premium', admin_1.adminCommand);
bot.command('addpremium', admin_1.adminCommand);
bot.command('extendpremium', admin_1.adminCommand);
bot.command('removepremium', admin_1.adminCommand);
bot.command('viewpremium', admin_1.adminCommand);
bot.command('addchannel', admin_1.adminCommand);
bot.command('removechannel', admin_1.adminCommand);
bot.command('setforcesubmsg', admin_1.adminCommand);
bot.command('activejobs', admin_1.adminCommand);
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
        editMessageText: async (text, extra) => ctx.reply(text, extra)
    });
});
bot.command('account', (ctx) => {
    return require('./bot/handlers/callback').callbackHandler({
        ...ctx,
        callbackQuery: { data: 'account' },
        answerCbQuery: async () => true,
        editMessageText: async (text, extra) => ctx.reply(text, extra)
    });
});
bot.command('help', (ctx) => {
    return require('./bot/handlers/callback').callbackHandler({
        ...ctx,
        callbackQuery: { data: 'help' },
        answerCbQuery: async () => true,
        editMessageText: async (text, extra) => ctx.reply(text, extra)
    });
});
bot.command('referrals', (ctx) => {
    return require('./bot/handlers/callback').callbackHandler({
        ...ctx,
        callbackQuery: { data: 'referrals' },
        answerCbQuery: async () => true,
        editMessageText: async (text, extra) => ctx.reply(text, extra)
    });
});
bot.command('disclaimer', (ctx) => {
    return require('./bot/handlers/callback').callbackHandler({
        ...ctx,
        callbackQuery: { data: 'disclaimer' },
        answerCbQuery: async () => true,
        editMessageText: async (text, extra) => ctx.reply(text, extra)
    });
});
// Actions/Callbacks
bot.on('callback_query', (ctx) => (0, callback_1.callbackHandler)(ctx));
// Messages
bot.on('text', (ctx) => (0, message_1.messageHandler)(ctx));
// Start the bot gracefully
let isBotRunning = false;
let workersInitialized = false;
const start = async () => {
    try {
        // 1. Connect/check PostgreSQL
        if (config_1.config.NODE_ENV !== 'test') {
            try {
                logger_1.logger.info('Checking PostgreSQL...');
                await db_1.db.$queryRaw `SELECT 1`;
                logger_1.logger.info('Connected to PostgreSQL successfully\n');
            }
            catch (err) {
                throw new Error('Could not connect to PostgreSQL at startup.');
            }
        }
        // 2. Connect/check Redis
        if (config_1.config.NODE_ENV !== 'test') {
            try {
                logger_1.logger.info('Checking Redis...');
                const { redis } = require('./redis');
                await redis.ping();
                console.log('');
            }
            catch (err) {
                throw new Error('Redis connection failed during startup health check.');
            }
        }
        // 3. Start Express HTTP verification & Admin server (listens on PORT or 3000)
        if (config_1.config.NODE_ENV !== 'test') {
            logger_1.logger.info('Starting HTTP server...');
            const port = Number(process.env.PORT) || 3000;
            server = (0, server_1.startServer)(port);
            logger_1.logger.info(`HTTP server started successfully on port ${port}\n`);
        }
        // 4. Initialize download and system workers (Runs in both Dev & Production)
        if (config_1.config.NODE_ENV !== 'test' && !workersInitialized) {
            logger_1.logger.info('Initializing workers...');
            const { initWorker } = require('./queue/worker');
            const { initBroadcastWorker } = require('./queue/broadcast');
            const { initCleanupWorker } = require('./queue/cleanup');
            initWorker();
            initBroadcastWorker();
            initCleanupWorker();
            workersInitialized = true;
            logger_1.logger.info('Workers initialized successfully\n');
        }
        // 5. Remove any leftover Telegram webhooks before long polling
        logger_1.logger.info('Removing Telegram webhook...');
        try {
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            logger_1.logger.info('Telegram webhook removed successfully\n');
        }
        catch (e) {
            logger_1.logger.error('Failed to remove Telegram webhook.');
        }
        // 6. Start Telegram bot long polling (Runs in both Dev & Production)
        if (config_1.config.NODE_ENV !== 'test') {
            logger_1.logger.info('🚀 Starting NexTeraDownloadBot Telegram polling...');
            bot.launch({ dropPendingUpdates: true })
                .then(() => {
                isBotRunning = true;
                logger_1.logger.info('🟢 PostgreSQL connected');
                logger_1.logger.info('🟢 Redis connected');
                logger_1.logger.info('🟢 HTTP server started');
                logger_1.logger.info('🟢 Queue initialized');
                logger_1.logger.info('🟢 Workers initialized');
                logger_1.logger.info('🟢 Telegram bot started');
                logger_1.logger.info('🤖 NexTeraDownloadBot is online 24/7');
            })
                .catch((err) => {
                isBotRunning = false;
                logger_1.logger.error(`❌ Telegram launch failed: ${err.message}`);
            });
        }
    }
    catch (error) {
        if (error.code === 'EPERM' && error.message.includes('query_engine-windows.dll.node')) {
            logger_1.logger.warn('Windows EPERM lock detected on Prisma.');
        }
        else {
            logger_1.logger.error(`Failed to start the bot: ${error.message}`);
        }
        if (server) {
            server.close();
        }
        await db_1.db.$disconnect();
        if (config_1.config.NODE_ENV !== 'test') {
            try {
                const { redis } = require('./redis');
                await redis.quit();
            }
            catch (e) { }
        }
        process.exit(1);
    }
};
if (config_1.config.NODE_ENV !== 'test') {
    start();
}
// Graceful shutdown handling for Railway / Docker / Kubernetes
let isShuttingDown = false;
const shutdown = async (signal) => {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    console.log('');
    logger_1.logger.info(`🛑 Received ${signal}`);
    logger_1.logger.info('🧹 Shutting down...');
    if (isBotRunning) {
        try {
            bot.stop(signal);
            logger_1.logger.info('🟢 Telegram stopped');
        }
        catch (error) { }
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
        logger_1.logger.info('🟢 Workers stopped');
        if (server) {
            server.close();
            logger_1.logger.info('🟢 HTTP server stopped');
        }
        if (config_1.config.NODE_ENV !== 'test') {
            const { redis } = require('./redis');
            await redis.quit();
            logger_1.logger.info('🟢 Redis disconnected');
        }
        await db_1.db.$disconnect();
        logger_1.logger.info('🟢 PostgreSQL disconnected');
    }
    catch (err) {
    }
    finally {
        logger_1.logger.info('✅ Shutdown complete');
        process.exit(0);
    }
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
