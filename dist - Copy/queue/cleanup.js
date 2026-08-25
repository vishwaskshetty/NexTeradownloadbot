"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeCleanupWorker = exports.initCleanupWorker = exports.cleanupQueue = void 0;
const bullmq_1 = require("bullmq");
const redis_1 = require("../redis");
const db_1 = require("../db");
const logger_1 = require("../utils/logger");
exports.cleanupQueue = new bullmq_1.Queue('cleanup', { connection: redis_1.redis });
let cleanupWorker = null;
let cleanupInterval = null;
const initCleanupWorker = () => {
    if (cleanupWorker)
        return;
    cleanupWorker = new bullmq_1.Worker('cleanup', async () => {
        logger_1.logger.info('🧹 Running database cleanup...');
        // Delete expired verification sessions older than 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        await db_1.db.verificationSession.deleteMany({
            where: {
                OR: [
                    { status: 'EXPIRED' },
                    { status: 'USED', updatedAt: { lt: sevenDaysAgo } }
                ]
            }
        });
        // Delete completed/failed jobs older than 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        await db_1.db.job.deleteMany({
            where: {
                status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
                updatedAt: { lt: thirtyDaysAgo }
            }
        });
        // Mark stuck jobs (Processing for more than 1 hour) as FAILED
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const stuckJobs = await db_1.db.job.updateMany({
            where: {
                status: { in: ['QUEUED', 'PROCESSING', 'UPLOADING'] },
                updatedAt: { lt: oneHourAgo }
            },
            data: {
                status: 'FAILED',
                errorReason: 'Job timed out and was swept by the cleanup worker.'
            }
        });
        if (stuckJobs.count > 0) {
            logger_1.logger.info(`🧹 Marked ${stuckJobs.count} stuck jobs as FAILED.`);
        }
        // Clean orphaned temp files in os.tmpdir() starting with nextera_
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const tmpDir = os.tmpdir();
        let deletedFiles = 0;
        try {
            const files = fs.readdirSync(tmpDir);
            for (const file of files) {
                if (file.startsWith('nextera_')) {
                    const filePath = path.join(tmpDir, file);
                    const stat = fs.statSync(filePath);
                    if (stat.mtime < oneHourAgo) {
                        fs.unlinkSync(filePath);
                        deletedFiles++;
                    }
                }
            }
        }
        catch (err) {
            logger_1.logger.error(`Error during tmpdir sweep: ${err.message}`);
        }
        if (deletedFiles > 0) {
            logger_1.logger.info(`🧹 Deleted ${deletedFiles} orphaned temporary files.`);
        }
        // Clean up expired StoredFiles and their Telegram messages
        const { config } = require('../config');
        if (config.STORAGE_CHANNEL_ID) {
            const { bot } = require('../bot');
            const expiredFiles = await db_1.db.storedFile.findMany({
                where: {
                    expiresAt: { lt: new Date() }
                }
            });
            let deletedStorage = 0;
            for (const file of expiredFiles) {
                try {
                    if (file.telegramMessageId) {
                        await bot.telegram.deleteMessage(config.STORAGE_CHANNEL_ID, file.telegramMessageId);
                    }
                }
                catch (e) {
                    logger_1.logger.warn(`Could not delete storage message ${file.telegramMessageId}: ${e.message}`);
                }
                await db_1.db.storedFile.delete({ where: { id: file.id } });
                deletedStorage++;
            }
            if (deletedStorage > 0) {
                logger_1.logger.info(`🧹 Deleted ${deletedStorage} expired private storage files.`);
            }
        }
        logger_1.logger.info('🧹 Cleanup complete.');
    }, { connection: redis_1.redis });
    // In BullMQ v5, repeat is handled differently, so we'll just run one cleanup on boot
    // and schedule a local interval to push cleanup jobs to the queue.
    exports.cleanupQueue.add('dailyCleanup', {});
    cleanupInterval = setInterval(() => {
        exports.cleanupQueue.add('dailyCleanup', {});
    }, 24 * 60 * 60 * 1000);
};
exports.initCleanupWorker = initCleanupWorker;
const closeCleanupWorker = async () => {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
    }
    if (cleanupWorker) {
        await cleanupWorker.close();
    }
};
exports.closeCleanupWorker = closeCleanupWorker;
