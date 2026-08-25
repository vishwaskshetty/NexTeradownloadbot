"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jobService = exports.JobService = void 0;
const db_1 = require("../db");
const logger_1 = require("../utils/logger");
class JobService {
    async createJob(userId, url, provider) {
        try {
            // Check active job to enforce one active process per user
            const activeJob = await this.getActiveJob(userId);
            if (activeJob) {
                return { job: activeJob, isExisting: true };
            }
            // NOTE: Creating a job MUST NOT increment user's daily usage limit
            const job = await db_1.db.job.create({
                data: {
                    userId,
                    url,
                    provider,
                    status: 'PENDING'
                }
            });
            return { job, isExisting: false };
        }
        catch (error) {
            throw error;
        }
    }
    async getActiveJob(userId) {
        return db_1.db.job.findFirst({
            where: {
                userId,
                status: {
                    in: ['PENDING', 'VERIFYING', 'QUEUED', 'PROCESSING', 'UPLOADING', 'FILE_READY', 'SENDING']
                }
            }
        });
    }
    async getHistory(userId, limit = 5) {
        return db_1.db.job.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
    }
    async getJobWithUser(jobId) {
        return db_1.db.job.findUnique({
            where: { id: jobId },
            include: { user: true }
        });
    }
    async updateJobStatus(jobId, status) {
        return db_1.db.job.update({
            where: { id: jobId },
            data: { status }
        });
    }
    async cancelJob(jobId) {
        // Cancellation DOES NOT increment usage
        return db_1.db.job.update({
            where: { id: jobId },
            data: { status: 'CANCELLED' }
        });
    }
    async failJob(jobId, errorReason) {
        // Failure DOES NOT increment usage
        return db_1.db.job.update({
            where: { id: jobId },
            data: { status: 'FAILED', errorReason }
        });
    }
    /**
     * ATOMIC & IDEMPOTENT COMPLETION:
     * Increments the user's daily usage by 1 ONLY when the job completes successfully.
     * Employs atomic updateMany count checking to prevent race conditions or duplicate concurrent increments.
     */
    async completeJob(jobId, fileSize) {
        const existingJob = await db_1.db.job.findUnique({ where: { id: jobId } });
        if (!existingJob) {
            throw new Error(`Job ${jobId} not found`);
        }
        const sizeBigInt = fileSize !== undefined ? BigInt(fileSize) : (existingJob.fileSize || 0n);
        // ATOMIC RACE CONDITION GUARD:
        // Update status to COMPLETED ONLY IF it is not already COMPLETED.
        // updateMany returns { count: 1 } for exactly one execution, and { count: 0 } for any duplicate/concurrent executions.
        const updateResult = await db_1.db.job.updateMany({
            where: {
                id: jobId,
                status: { not: 'COMPLETED' }
            },
            data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                fileSize: sizeBigInt
            }
        });
        if (updateResult.count === 0) {
            logger_1.logger.info(`[JobService] Job ${jobId} is already COMPLETED. Idempotency guard triggered (count=0).`);
            const currentJob = await db_1.db.job.findUnique({ where: { id: jobId } });
            return { job: currentJob || existingJob, newlyCompleted: false };
        }
        // Since we atomically claimed the transition to COMPLETED, increment usage EXACTLY ONCE
        const completedJob = await db_1.db.$transaction(async (tx) => {
            const jobRecord = await tx.job.findUnique({ where: { id: jobId } });
            let usage = await tx.userUsage.findUnique({ where: { userId: existingJob.userId } });
            if (!usage) {
                usage = await tx.userUsage.create({ data: { userId: existingJob.userId } });
            }
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const lastReset = new Date(usage.lastResetDate);
            lastReset.setHours(0, 0, 0, 0);
            const isNewDay = lastReset < today;
            await tx.userUsage.update({
                where: { userId: existingJob.userId },
                data: {
                    dailyRequests: isNewDay ? 1 : usage.dailyRequests + 1,
                    successfulRequests: usage.successfulRequests + 1,
                    dailyFiles: isNewDay ? 1 : usage.dailyFiles + 1,
                    totalFiles: usage.totalFiles + 1,
                    dailyBytes: isNewDay ? sizeBigInt : usage.dailyBytes + sizeBigInt,
                    totalBytes: usage.totalBytes + sizeBigInt,
                    lastResetDate: isNewDay ? new Date() : usage.lastResetDate
                }
            });
            return jobRecord;
        });
        logger_1.logger.info(`[JobService] Job ${jobId} completed successfully. Incremented daily usage for user ${existingJob.userId}.`);
        return { job: completedJob, newlyCompleted: true };
    }
    async expireJob(jobId) {
        return db_1.db.job.update({
            where: { id: jobId },
            data: { status: 'EXPIRED', expiresAt: new Date() }
        });
    }
}
exports.JobService = JobService;
exports.jobService = new JobService();
