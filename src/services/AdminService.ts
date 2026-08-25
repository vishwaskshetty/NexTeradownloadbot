import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';

export class AdminService {
  isAdmin(telegramId?: number | string | bigint): boolean {
    if (!telegramId) return false;
    const idNum = Number(telegramId);
    const adminIds = config.ADMIN_TELEGRAM_IDS;
    const result = adminIds.includes(idNum);
    logger.info(`Admin check: telegramUserId=${idNum} isAdmin=${result} configuredAdmins=${JSON.stringify(adminIds)}`);
    return result;
  }

  // --- VERIFICATION ---
  async getVerificationStatus(): Promise<boolean> {
    const { redis } = require('../redis');
    const cached = await redis.get('VERIFICATION_ENABLED');
    if (cached !== null) return cached === 'true';

    const setting = await db.botSetting.findUnique({ where: { key: 'VERIFICATION_ENABLED' } });
    const isEnabled = setting ? setting.value === 'true' : true;
    await redis.setex('VERIFICATION_ENABLED', 300, isEnabled ? 'true' : 'false');
    return isEnabled;
  }

  async setVerificationStatus(enabled: boolean): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'VERIFICATION_ENABLED' },
      update: { value: enabled ? 'true' : 'false' },
      create: { key: 'VERIFICATION_ENABLED', value: enabled ? 'true' : 'false' }
    });
    const { redis } = require('../redis');
    await redis.setex('VERIFICATION_ENABLED', 300, enabled ? 'true' : 'false');
    logger.info(`Admin set VERIFICATION_ENABLED to ${enabled}`);
  }

  // --- PREMIUM SYSTEM ---
  async getPremiumStatus(): Promise<boolean> {
    const { redis } = require('../redis');
    const cached = await redis.get('PREMIUM_ENABLED');
    if (cached !== null) return cached === 'true';

    const setting = await db.botSetting.findUnique({ where: { key: 'PREMIUM_ENABLED' } });
    const isEnabled = setting ? setting.value === 'true' : true;
    await redis.setex('PREMIUM_ENABLED', 300, isEnabled ? 'true' : 'false');
    return isEnabled;
  }

  async setPremiumStatus(enabled: boolean): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'PREMIUM_ENABLED' },
      update: { value: enabled ? 'true' : 'false' },
      create: { key: 'PREMIUM_ENABLED', value: enabled ? 'true' : 'false' }
    });
    const { redis } = require('../redis');
    await redis.setex('PREMIUM_ENABLED', 300, enabled ? 'true' : 'false');
    logger.info(`Admin set PREMIUM_ENABLED to ${enabled}`);
  }

  async setPremiumUser(userId: number, isPremium: boolean): Promise<void> {
    await db.user.update({
      where: { id: userId },
      data: { plan: isPremium ? 'PREMIUM' : 'FREE' }
    });
    const { redis } = require('../redis');
    await redis.del(`user:${userId}:verified`);
  }

  // --- SHORTENER ---
  async getShortenerStatus(): Promise<boolean> {
    const setting = await db.botSetting.findUnique({ where: { key: 'SHORTENER_ENABLED' } });
    if (!setting) return true; // Default ON
    return setting.value === 'true';
  }

  async setShortenerStatus(enabled: boolean): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'SHORTENER_ENABLED' },
      update: { value: enabled ? 'true' : 'false' },
      create: { key: 'SHORTENER_ENABLED', value: enabled ? 'true' : 'false' }
    });
    logger.info(`Admin set SHORTENER_ENABLED to ${enabled}`);
  }

  async getShortenerProvider(): Promise<string> {
    const setting = await db.botSetting.findUnique({ where: { key: 'SHORTENER_PROVIDER' } });
    if (!setting) return config.SHORTENER_PROVIDER || 'Bitly';
    return setting.value;
  }

  async setShortenerProvider(provider: string): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'SHORTENER_PROVIDER' },
      update: { value: provider },
      create: { key: 'SHORTENER_PROVIDER', value: provider }
    });
    logger.info(`Admin set SHORTENER_PROVIDER to ${provider}`);
  }

  // --- REFERRAL SYSTEM ---
  async getReferralStatus(): Promise<boolean> {
    const { redis } = require('../redis');
    const cached = await redis.get('REFERRAL_ENABLED');
    if (cached !== null) return cached === 'true';

    const setting = await db.botSetting.findUnique({ where: { key: 'REFERRAL_ENABLED' } });
    const isEnabled = setting ? setting.value === 'true' : (config.REFERRAL_ENABLED ?? true);
    await redis.setex('REFERRAL_ENABLED', 300, isEnabled ? 'true' : 'false');
    return isEnabled;
  }

  async setReferralStatus(enabled: boolean): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'REFERRAL_ENABLED' },
      update: { value: enabled ? 'true' : 'false' },
      create: { key: 'REFERRAL_ENABLED', value: enabled ? 'true' : 'false' }
    });
    const { redis } = require('../redis');
    await redis.setex('REFERRAL_ENABLED', 300, enabled ? 'true' : 'false');
    logger.info(`Admin set REFERRAL_ENABLED to ${enabled}`);
  }

  async getReferralsRequired(): Promise<number> {
    const setting = await db.botSetting.findUnique({ where: { key: 'REFERRALS_REQUIRED' } });
    if (setting) return parseInt(setting.value, 10) || 10;
    return config.REFERRALS_REQUIRED || 10;
  }

  async setReferralsRequired(count: number): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'REFERRALS_REQUIRED' },
      update: { value: count.toString() },
      create: { key: 'REFERRALS_REQUIRED', value: count.toString() }
    });
    logger.info(`Admin set REFERRALS_REQUIRED to ${count}`);
  }

  async getReferralRewardDays(): Promise<number> {
    const setting = await db.botSetting.findUnique({ where: { key: 'REFERRAL_REWARD_DAYS' } });
    if (setting) return parseInt(setting.value, 10) || 5;
    return config.REFERRAL_REWARD_DAYS || 5;
  }

  async setReferralRewardDays(days: number): Promise<void> {
    await db.botSetting.upsert({
      where: { key: 'REFERRAL_REWARD_DAYS' },
      update: { value: days.toString() },
      create: { key: 'REFERRAL_REWARD_DAYS', value: days.toString() }
    });
    logger.info(`Admin set REFERRAL_REWARD_DAYS to ${days}`);
  }
}

export const adminService = new AdminService();
