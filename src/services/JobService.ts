import { db } from '../db';
import { Job } from '@prisma/client';
import { logger } from '../utils/logger';

export class JobService {
  async createJob(userId: Int, url: string, provider: string): Promise<{ job: Job, isExisting: boolean }> {
    try {
      // First, check if there's an active job to enforce one active process per user
      const activeJob = await this.getActiveJob(userId);
      if (activeJob) {
        return { job: activeJob, isExisting: true };
      }

      const job = await db.job.create({
        data: {
          userId,
          url,
          provider,
          status: 'PENDING'
        }
      });
      return { job, isExisting: false };
    } catch (error: any) {
      throw error;
    }
  }

  async getActiveJob(userId: Int): Promise<Job | null> {
    return db.job.findFirst({
      where: {
        userId,
        status: {
          in: ['PENDING', 'VERIFYING', 'QUEUED', 'PROCESSING', 'UPLOADING']
        }
      }
    });
  }

  async getHistory(userId: Int, limit: number = 5): Promise<Job[]> {
    return db.job.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  async getJobWithUser(jobId: string) {
    return db.job.findUnique({
      where: { id: jobId },
      include: { user: true }
    });
  }

  async updateJobStatus(jobId: string, status: string): Promise<Job> {
    return db.job.update({
      where: { id: jobId },
      data: { status }
    });
  }

  async cancelJob(jobId: string): Promise<Job> {
    return db.job.update({
      where: { id: jobId },
      data: { status: 'CANCELLED' }
    });
  }

  async failJob(jobId: string, errorReason: string): Promise<Job> {
    return db.job.update({
      where: { id: jobId },
      data: { status: 'FAILED', errorReason }
    });
  }

  async completeJob(jobId: string): Promise<Job> {
    return db.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', completedAt: new Date() }
    });
  }

  async expireJob(jobId: string): Promise<Job> {
    return db.job.update({
      where: { id: jobId },
      data: { status: 'EXPIRED', expiresAt: new Date() }
    });
  }
}

// Temporary type to alias number to Int for Prisma types ease
type Int = number;

export const jobService = new JobService();
