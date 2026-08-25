"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forceSubService = exports.ForceSubService = void 0;
const db_1 = require("../db");
const logger_1 = require("../utils/logger");
class ForceSubService {
    /**
     * Retrieves whether Force Subscription is enabled globally
     */
    async getForceSubStatus() {
        const { redis } = require('../redis');
        const cached = await redis.get('FORCE_SUB_ENABLED');
        if (cached !== null)
            return cached === 'true';
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'FORCE_SUB_ENABLED' } });
        const isEnabled = setting ? setting.value === 'true' : false;
        await redis.setex('FORCE_SUB_ENABLED', 300, isEnabled ? 'true' : 'false');
        return isEnabled;
    }
    /**
     * Sets global Force Subscription status
     */
    async setForceSubStatus(enabled) {
        await db_1.db.botSetting.upsert({
            where: { key: 'FORCE_SUB_ENABLED' },
            update: { value: enabled ? 'true' : 'false' },
            create: { key: 'FORCE_SUB_ENABLED', value: enabled ? 'true' : 'false' }
        });
        const { redis } = require('../redis');
        await redis.setex('FORCE_SUB_ENABLED', 300, enabled ? 'true' : 'false');
        logger_1.logger.info(`Admin set FORCE_SUB_ENABLED to ${enabled}`);
    }
    /**
     * Retrieves list of required channels
     */
    async getRequiredChannels() {
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'FORCE_SUB_CHANNELS' } });
        if (!setting || !setting.value)
            return [];
        try {
            return JSON.parse(setting.value);
        }
        catch {
            return [];
        }
    }
    /**
     * Adds a required channel
     */
    async addChannel(channel) {
        const channels = await this.getRequiredChannels();
        const existingIndex = channels.findIndex(c => c.id === channel.id || (c.username && c.username.toLowerCase() === channel.username?.toLowerCase()));
        if (existingIndex >= 0) {
            channels[existingIndex] = channel;
        }
        else {
            channels.push(channel);
        }
        await db_1.db.botSetting.upsert({
            where: { key: 'FORCE_SUB_CHANNELS' },
            update: { value: JSON.stringify(channels) },
            create: { key: 'FORCE_SUB_CHANNELS', value: JSON.stringify(channels) }
        });
        logger_1.logger.info(`Added force sub channel: ${channel.name} (${channel.id})`);
    }
    /**
     * Removes a required channel by ID or username
     */
    async removeChannel(channelIdOrUsername) {
        const channels = await this.getRequiredChannels();
        const filtered = channels.filter(c => c.id !== channelIdOrUsername &&
            c.username?.toLowerCase() !== channelIdOrUsername.toLowerCase().replace('@', ''));
        if (filtered.length === channels.length)
            return false;
        await db_1.db.botSetting.upsert({
            where: { key: 'FORCE_SUB_CHANNELS' },
            update: { value: JSON.stringify(filtered) },
            create: { key: 'FORCE_SUB_CHANNELS', value: JSON.stringify(filtered) }
        });
        logger_1.logger.info(`Removed force sub channel: ${channelIdOrUsername}`);
        return true;
    }
    /**
     * Gets custom Force Sub message template
     */
    async getCustomMessage() {
        const setting = await db_1.db.botSetting.findUnique({ where: { key: 'FORCE_SUB_MESSAGE' } });
        if (setting && setting.value)
            return setting.value;
        return `👋 *Hello {user_name}!*\n\n📢 *Please join our required channels below to use NexTeraDownloadBot.*\n\nAfter joining all channels, click *Check Again* below.`;
    }
    /**
     * Sets custom Force Sub message template
     */
    async setCustomMessage(msg) {
        await db_1.db.botSetting.upsert({
            where: { key: 'FORCE_SUB_MESSAGE' },
            update: { value: msg },
            create: { key: 'FORCE_SUB_MESSAGE', value: msg }
        });
    }
    /**
     * Checks if user has joined ALL required channels via Telegram getChatMember
     */
    async checkUserMembership(telegram, telegramUserId) {
        const channels = await this.getRequiredChannels();
        if (channels.length === 0)
            return { isMember: true, missingChannels: [] };
        const missingChannels = [];
        const userIdNum = Number(telegramUserId);
        for (const channel of channels) {
            try {
                const member = await telegram.getChatMember(channel.id, userIdNum);
                const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
                if (!member || !validStatuses.includes(member.status)) {
                    missingChannels.push(channel);
                }
            }
            catch (err) {
                logger_1.logger.warn(`Could not verify channel membership for ${channel.name} (${channel.id}): ${err.message}`);
                missingChannels.push(channel);
            }
        }
        return {
            isMember: missingChannels.length === 0,
            missingChannels
        };
    }
}
exports.ForceSubService = ForceSubService;
exports.forceSubService = new ForceSubService();
