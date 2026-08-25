"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeBroadcastWorker = exports.initBroadcastWorker = void 0;
const bullmq_1 = require("bullmq");
const redis_1 = require("../redis");
const db_1 = require("../db");
const logger_1 = require("../utils/logger");
const bot_1 = require("../bot");
let broadcastWorker = null;
const initBroadcastWorker = () => {
    if (broadcastWorker)
        return;
    broadcastWorker = new bullmq_1.Worker('broadcast', async (job) => {
        const { text } = job.data;
        // Broadcast message to all users safely
        // Note: In a real environment, you'd page through the db
        const users = await db_1.db.user.findMany({ select: { telegramId: true } });
        let sent = 0;
        for (const user of users) {
            try {
                await bot_1.bot.telegram.sendMessage(user.telegramId.toString(), text);
                sent++;
                // Throttle to respect telegram limits (30 per second broad limit)
                await new Promise(r => setTimeout(r, 50));
            }
            catch (err) {
                // Ignore users who blocked the bot
            }
        }
        logger_1.logger.info(`📢 Broadcast complete. Sent to ${sent}/${users.length} users.`);
    }, { connection: redis_1.redis });
};
exports.initBroadcastWorker = initBroadcastWorker;
const closeBroadcastWorker = async () => {
    if (broadcastWorker) {
        await broadcastWorker.close();
    }
};
exports.closeBroadcastWorker = closeBroadcastWorker;
