import 'dotenv/config';
import { config } from './config';
import { logger } from './utils/logger';
import { db } from './db';

const startWorker = async () => {
  try {
    // 1. Validate environment
    // 2. Connect to DB
    logger.info('Checking PostgreSQL...');
    await db.$queryRaw`SELECT 1`;
    logger.info('Connected to PostgreSQL successfully');

    // 3. Connect to Redis
    logger.info('Checking Redis...');
    const { redis } = require('./redis');
    await redis.ping();

    // 4. Initialize workers
    logger.info('Initializing workers...');
    const { initWorker } = require('./queue/worker');
    const { initBroadcastWorker } = require('./queue/broadcast');
    const { initCleanupWorker } = require('./queue/cleanup');
    
    initWorker();
    initBroadcastWorker();
    initCleanupWorker();
    logger.info('Workers initialized successfully');
    logger.info('[TeraBox] Resolver version: 1.0.0 (commit: 40a4872)');
    logger.info('🚀 Persistent Worker is running');
  } catch (error: any) {
    logger.error(`Failed to start persistent worker: ${error.message}`);
    process.exit(1);
  }
};

startWorker();

// Graceful shutdown handling
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`🛑 Received ${signal}`);
  logger.info('🧹 Shutting down worker...');

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

    const { redis } = require('./redis');
    await redis.quit();
    logger.info('🟢 Redis disconnected');

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
