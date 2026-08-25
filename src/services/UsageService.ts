import { db } from '../db';
import type { UserUsage } from '@prisma/client';
import { config } from '../config';

export class UsageService {
  async getUsage(userId: number): Promise<UserUsage> {
    let usage = await db.userUsage.findUnique({ where: { userId } });
    if (!usage) {
      usage = await db.userUsage.create({ data: { userId } });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastReset = new Date(usage.lastResetDate);
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

  /**
   * Records a failed download attempt.
   * NOTE: Does NOT increment dailyRequests or dailyLimit quota.
   */
  async recordFailedRequest(userId: number): Promise<void> {
    const usage = await this.getUsage(userId);
    await db.userUsage.update({
      where: { userId },
      data: {
        failedRequests: usage.failedRequests + 1
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

  async getDailyLimitForUser(userId: number): Promise<number> {
    const { userService } = require('./UserService');
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return config.FREE_DAILY_LIMIT;
    const checkedUser = await userService.checkAndUpdatePremiumStatus(user);
    return this.getDailyLimit(checkedUser.plan);
  }
}

export const usageService = new UsageService();
