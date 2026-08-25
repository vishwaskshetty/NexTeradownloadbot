"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const logger_1 = require("./utils/logger");
const db_1 = require("./db");
const startWorker = async () => {
    try {
        // 1. Validate environment
        // 2. Connect to DB
        logger_1.logger.info('Checking PostgreSQL...');
        await db_1.db.$queryRaw `SELECT 1`;
        logger_1.logger.info('Connected to PostgreSQL successfully');
        // 3. Connect to Redis
        logger_1.logger.info('Checking Redis...');
        const { redis } = require('./redis');
        await redis.ping();
        // 4. Initialize workers
        logger_1.logger.info('Initializing workers...');
        const { initWorker } = require('./queue/worker');
        const { initBroadcastWorker } = require('./queue/broadcast');
        const { initCleanupWorker } = require('./queue/cleanup');
        initWorker();
        initBroadcastWorker();
        initCleanupWorker();
        logger_1.logger.info('Workers initialized successfully');
        logger_1.logger.info('🚀 Persistent Worker is running');
    }
    catch (error) {
        logger_1.logger.error(`Failed to start persistent worker: ${error.message}`);
        process.exit(1);
    }
};
startWorker();
// Graceful shutdown handling
let isShuttingDown = false;
const shutdown = async (signal) => {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    logger_1.logger.info(`🛑 Received ${signal}`);
    logger_1.logger.info('🧹 Shutting down worker...');
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
        const { redis } = require('./redis');
        await redis.quit();
        logger_1.logger.info('🟢 Redis disconnected');
        await db_1.db.$disconnect();
        logger_1.logger.info('🟢 PostgreSQL disconnected');
    }
    catch (err) {
        // Suppress shutdown errors
    }
    finally {
        logger_1.logger.info('✅ Shutdown complete');
        process.exit(0);
    }
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
