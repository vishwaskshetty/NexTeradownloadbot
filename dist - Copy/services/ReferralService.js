"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referralService = exports.ReferralService = void 0;
const db_1 = require("../db");
const logger_1 = require("../utils/logger");
const config_1 = require("../config");
const AdminService_1 = require("./AdminService");
const UserService_1 = require("./UserService");
class ReferralService {
    /**
     * Generates progress bar visualization string (e.g. ███████░░░ 7/10)
     */
    generateProgressBar(current, total) {
        const length = 10;
        const filled = Math.min(length, Math.floor((current / total) * length));
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty) + ` ${current}/${total}`;
    }
    /**
     * Processes a referral link click during /start ref_<referrerTelegramId>
     */
    async processReferral(referrerTelegramId, newTelegramId) {
        const refId = BigInt(referrerTelegramId);
        const newId = BigInt(newTelegramId);
        // 1. Self-referral guard
        if (refId === newId) {
            return { success: false, message: 'Self-referrals are not allowed.' };
        }
        // 2. Check global referral system status
        const isEnabled = await AdminService_1.adminService.getReferralStatus();
        if (!isEnabled) {
            return { success: false, message: 'Referral system is currently disabled.' };
        }
        // 3. Find referrer user & new user
        const referrer = await db_1.db.user.findUnique({ where: { telegramId: refId } });
        if (!referrer) {
            return { success: false, message: 'Referrer user not found.' };
        }
        const newUser = await db_1.db.user.findUnique({ where: { telegramId: newId } });
        if (!newUser) {
            return { success: false, message: 'New user record not found.' };
        }
        // 4. Duplicate referral guard: check if new user was already referred
        const existingRef = await db_1.db.referral.findUnique({ where: { referredUserId: newUser.id } });
        if (existingRef) {
            return { success: false, message: 'User has already been referred previously.' };
        }
        // 5. Create Referral record
        await db_1.db.referral.create({
            data: {
                referrerUserId: referrer.id,
                referredUserId: newUser.id,
            }
        });
        logger_1.logger.info(`[ReferralService] User ${newTelegramId} successfully referred by ${referrerTelegramId}`);
        // 6. Check total successful referrals for referrer & calculate rewards
        await this.checkAndAwardMilestones(referrer.id, referrer.telegramId);
        return { success: true, message: 'Referral successfully registered.' };
    }
    /**
     * Idempotent milestone reward check:
     * Calculates earned milestones and awards +5 days premium for every 10 successful referrals.
     */
    async checkAndAwardMilestones(userId, telegramId) {
        const count = await db_1.db.referral.count({ where: { referrerUserId: userId } });
        const requiredPerReward = await AdminService_1.adminService.getReferralsRequired();
        const rewardDays = await AdminService_1.adminService.getReferralRewardDays();
        if (requiredPerReward <= 0)
            return;
        const milestonesEarned = Math.floor(count / requiredPerReward);
        const adminId = config_1.config.ADMIN_TELEGRAM_IDS[0] || 0;
        for (let m = 1; m <= milestonesEarned; m++) {
            const existingMilestone = await db_1.db.referralMilestone.findUnique({
                where: {
                    referrerUserId_milestone: {
                        referrerUserId: userId,
                        milestone: m
                    }
                }
            });
            if (!existingMilestone) {
                // Record milestone to prevent duplicate awards across restarts/retries
                await db_1.db.referralMilestone.create({
                    data: {
                        referrerUserId: userId,
                        milestone: m,
                        referralCount: m * requiredPerReward,
                        rewardDays
                    }
                });
                // Award premium extension
                const rewardResult = await UserService_1.userService.addPremium(adminId, telegramId, rewardDays);
                logger_1.logger.info(`🎉 [ReferralService] User ${telegramId} unlocked Milestone #${m}! Awarded +${rewardDays} days premium. New expiry: ${rewardResult.newExpiry.toISOString()}`);
                // Send Telegram notification if bot instance is available
                try {
                    const { bot } = require('../bot/bot');
                    const expStr = rewardResult.newExpiry.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
                    await bot.telegram.sendMessage(telegramId.toString(), `🎉 *REWARD UNLOCKED!*\n\nYou reached *${m * requiredPerReward} successful referrals*!\n\n⭐ *Earned:* +${rewardDays} DAYS PREMIUM\n📅 *New Premium Expiry:* ${expStr}`, { parse_mode: 'Markdown' });
                }
                catch (e) { }
            }
        }
    }
    /**
     * Retrieves referral statistics for a user
     */
    async getReferralStats(telegramId, targetBotUsername) {
        const botName = targetBotUsername || config_1.config.BOT_USERNAME || 'NexTeraDownloadBot';
        const user = await db_1.db.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
        const referralLink = `https://t.me/${botName}?start=ref_${telegramId}`;
        if (!user) {
            return {
                referralLink,
                totalReferrals: 0,
                currentProgress: 0,
                requiredPerReward: 10,
                neededForNext: 10,
                progressBar: '░░░░░░░░░░ 0/10',
                rewardDays: 5,
                totalMilestonesClaimed: 0,
                totalDaysEarned: 0,
            };
        }
        const totalReferrals = await db_1.db.referral.count({ where: { referrerUserId: user.id } });
        const requiredPerReward = await AdminService_1.adminService.getReferralsRequired();
        const rewardDays = await AdminService_1.adminService.getReferralRewardDays();
        const currentProgress = totalReferrals % requiredPerReward;
        const neededForNext = requiredPerReward - currentProgress;
        const totalMilestonesClaimed = await db_1.db.referralMilestone.count({ where: { referrerUserId: user.id } });
        const progressBar = this.generateProgressBar(currentProgress, requiredPerReward);
        return {
            referralLink,
            totalReferrals,
            currentProgress,
            requiredPerReward,
            neededForNext,
            progressBar,
            rewardDays,
            totalMilestonesClaimed,
            totalDaysEarned: totalMilestonesClaimed * rewardDays,
        };
    }
    /**
     * Retrieves global referral statistics for Admin Panel
     */
    async getGlobalReferralStats() {
        const totalReferrals = await db_1.db.referral.count();
        const totalMilestones = await db_1.db.referralMilestone.count();
        const isEnabled = await AdminService_1.adminService.getReferralStatus();
        const referralsRequired = await AdminService_1.adminService.getReferralsRequired();
        const rewardDays = await AdminService_1.adminService.getReferralRewardDays();
        return {
            totalReferrals,
            totalRewardsGranted: totalMilestones,
            totalPremiumDaysAwarded: totalMilestones * rewardDays,
            isEnabled,
            referralsRequired,
            rewardDays,
        };
    }
}
exports.ReferralService = ReferralService;
exports.referralService = new ReferralService();
