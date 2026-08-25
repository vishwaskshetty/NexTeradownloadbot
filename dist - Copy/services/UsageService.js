"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usageService = exports.UsageService = void 0;
const db_1 = require("../db");
const config_1 = require("../config");
class UsageService {
    async getUsage(userId) {
        let usage = await db_1.db.userUsage.findUnique({ where: { userId } });
        if (!usage) {
            usage = await db_1.db.userUsage.create({ data: { userId } });
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const lastReset = new Date(usage.lastResetDate);
        lastReset.setHours(0, 0, 0, 0);
        if (lastReset < today) {
            usage = await db_1.db.userUsage.update({
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
    async recordFailedRequest(userId) {
        const usage = await this.getUsage(userId);
        await db_1.db.userUsage.update({
            where: { userId },
            data: {
                failedRequests: usage.failedRequests + 1
            }
        });
    }
    async getDailyLimit(plan) {
        const { adminService } = require('./AdminService');
        const isPremiumEnabled = await adminService.getPremiumStatus();
        if (plan === 'PREMIUM' && isPremiumEnabled) {
            return config_1.config.PREMIUM_DAILY_LIMIT;
        }
        return config_1.config.FREE_DAILY_LIMIT;
    }
    async getDailyLimitForUser(userId) {
        const { userService } = require('./UserService');
        const user = await db_1.db.user.findUnique({ where: { id: userId } });
        if (!user)
            return config_1.config.FREE_DAILY_LIMIT;
        const checkedUser = await userService.checkAndUpdatePremiumStatus(user);
        return this.getDailyLimit(checkedUser.plan);
    }
}
exports.UsageService = UsageService;
exports.usageService = new UsageService();
