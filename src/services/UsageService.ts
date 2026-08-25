import { db } from '../db';
import { UserUsage } from '@prisma/client';
import { config } from '../config';

export class UsageService {
  async getUsage(userId: number): Promise<UserUsage> {
    let usage = await db.userUsage.findUnique({ where: { userId } });
    if (!usage) {
      usage = await db.userUsage.create({ data: { userId } });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastReset = usage.lastResetDate;
    lastReset.setHours(0, 0, 0, 0);

    if (lastReset < today) {
      usage = await db.userUsage.update({
        where: { userId },
        data: {
          dailyRequests: 0,
          dailyBytes: 0n,
          dailyFiles: 0,
          lastResetDate: new Date()
        }
      });
    }

    return usage;
  }

  async recordRequest(userId: number, success: boolean): Promise<void> {
    const usage = await this.getUsage(userId);
    await db.userUsage.update({
      where: { userId },
      data: {
        dailyRequests: usage.dailyRequests + 1,
        successfulRequests: success ? usage.successfulRequests + 1 : usage.successfulRequests,
        failedRequests: !success ? usage.failedRequests + 1 : usage.failedRequests
      }
    });
  }

  async getDailyLimit(plan: string): Promise<number> {
    const { adminService } = require('./AdminService');
    const isPremiumEnabled = await adminService.getPremiumStatus();
    
    if (plan === 'PREMIUM' && isPremiumEnabled) {
      return config.PREMIUM_DAILY_LIMIT;
    }
    return config.FREE_DAILY_LIMIT;
  }
}

export const usageService = new UsageService();
