"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminService = exports.AdminService = void 0;
const config_1 = require("../config");
const db_1 = require("../db");
const logger_1 = require("../utils/logger");
class AdminService {
    isAdmin(telegramId) {
        if (!telegramId)
            return false;
        const idNum = Number(telegramId);
        const adminIds = config_1.config.ADMIN_TELEGRAM_IDS;
        const result = adminIds.includes(idNum);
        logger_1.logger.info(`Admin check: telegramUserId=${idNum} isAdmin=${result} configuredAdmins=${JSON.stringify(adminIds)}`);
        return result;
    }
    // --- VERIFICATION ---
    async getVerificationStatus() {
        const { redis } = require('../redis');
        const cached = await redis.get('VERIFICATION_ENABLED');
        if (cached !== null)
            return cached === 'true';
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'VERIFICATION_ENABLED' } });
        const isEnabled = setting ? setting.value === 'true' : true;
        await redis.setex('VERIFICATION_ENABLED', 300, isEnabled ? 'true' : 'false');
        return isEnabled;
    }
    async setVerificationStatus(enabled) {
        await db_1.db.botSetting.upsert({
            where: { key: 'VERIFICATION_ENABLED' },
            update: { value: enabled ? 'true' : 'false' },
            create: { key: 'VERIFICATION_ENABLED', value: enabled ? 'true' : 'false' }
        });
        const { redis } = require('../redis');
        await redis.setex('VERIFICATION_ENABLED', 300, enabled ? 'true' : 'false');
        logger_1.logger.info(`Admin set VERIFICATION_ENABLED to ${enabled}`);
    }
    // --- PREMIUM SYSTEM ---
    async getPremiumStatus() {
        const { redis } = require('../redis');
        const cached = await redis.get('PREMIUM_ENABLED');
        if (cached !== null)
            return cached === 'true';
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'PREMIUM_ENABLED' } });
        const isEnabled = setting ? setting.value === 'true' : true;
        await redis.setex('PREMIUM_ENABLED', 300, isEnabled ? 'true' : 'false');
        return isEnabled;
    }
    async setPremiumStatus(enabled) {
        await db_1.db.botSetting.upsert({
            where: { key: 'PREMIUM_ENABLED' },
            update: { value: enabled ? 'true' : 'false' },
            create: { key: 'PREMIUM_ENABLED', value: enabled ? 'true' : 'false' }
        });
        const { redis } = require('../redis');
        await redis.setex('PREMIUM_ENABLED', 300, enabled ? 'true' : 'false');
        logger_1.logger.info(`Admin set PREMIUM_ENABLED to ${enabled}`);
    }
    async setPremiumUser(userId, isPremium) {
        await db_1.db.user.update({
            where: { id: userId },
            data: { plan: isPremium ? 'PREMIUM' : 'FREE' }
        });
        const { redis } = require('../redis');
        await redis.del(`user:${userId}:verified`);
    }
    // --- SHORTENER ---
    async getShortenerStatus() {
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'SHORTENER_ENABLED' } });
        if (!setting)
            return true; // Default ON
        return setting.value === 'true';
    }
    async setShortenerStatus(enabled) {
        await db_1.db.botSetting.upsert({
            where: { key: 'SHORTENER_ENABLED' },
            update: { value: enabled ? 'true' : 'false' },
            create: { key: 'SHORTENER_ENABLED', value: enabled ? 'true' : 'false' }
        });
        logger_1.logger.info(`Admin set SHORTENER_ENABLED to ${enabled}`);
    }
    async getShortenerProvider() {
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'SHORTENER_PROVIDER' } });
        if (!setting)
            return config_1.config.SHORTENER_PROVIDER || 'Bitly';
        return setting.value;
    }
    async setShortenerProvider(provider) {
        await db_1.db.botSetting.upsert({
            where: { key: 'SHORTENER_PROVIDER' },
            update: { value: provider },
            create: { key: 'SHORTENER_PROVIDER', value: provider }
        });
        logger_1.logger.info(`Admin set SHORTENER_PROVIDER to ${provider}`);
    }
    // --- REFERRAL SYSTEM ---
    async getReferralStatus() {
        const { redis } = require('../redis');
        const cached = await redis.get('REFERRAL_ENABLED');
        if (cached !== null)
            return cached === 'true';
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'REFERRAL_ENABLED' } });
        const isEnabled = setting ? setting.value === 'true' : (config_1.config.REFERRAL_ENABLED ?? true);
        await redis.setex('REFERRAL_ENABLED', 300, isEnabled ? 'true' : 'false');
        return isEnabled;
    }
    async setReferralStatus(enabled) {
        await db_1.db.botSetting.upsert({
            where: { key: 'REFERRAL_ENABLED' },
            update: { value: enabled ? 'true' : 'false' },
            create: { key: 'REFERRAL_ENABLED', value: enabled ? 'true' : 'false' }
        });
        const { redis } = require('../redis');
        await redis.setex('REFERRAL_ENABLED', 300, enabled ? 'true' : 'false');
        logger_1.logger.info(`Admin set REFERRAL_ENABLED to ${enabled}`);
    }
    async getReferralsRequired() {
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'REFERRALS_REQUIRED' } });
        if (setting)
            return parseInt(setting.value, 10) || 10;
        return config_1.config.REFERRALS_REQUIRED || 10;
    }
    async setReferralsRequired(count) {
        await db_1.db.botSetting.upsert({
            where: { key: 'REFERRALS_REQUIRED' },
            update: { value: count.toString() },
            create: { key: 'REFERRALS_REQUIRED', value: count.toString() }
        });
        logger_1.logger.info(`Admin set REFERRALS_REQUIRED to ${count}`);
    }
    async getReferralRewardDays() {
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'REFERRAL_REWARD_DAYS' } });
        if (setting)
            return parseInt(setting.value, 10) || 5;
        return config_1.config.REFERRAL_REWARD_DAYS || 5;
    }
    async setReferralRewardDays(days) {
        await db_1.db.botSetting.upsert({
            where: { key: 'REFERRAL_REWARD_DAYS' },
            update: { value: days.toString() },
            create: { key: 'REFERRAL_REWARD_DAYS', value: days.toString() }
        });
        logger_1.logger.info(`Admin set REFERRAL_REWARD_DAYS to ${days}`);
    }
}
exports.AdminService = AdminService;
exports.adminService = new AdminService();
