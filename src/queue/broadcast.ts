import { Worker, Job } from 'bullmq';
import { redis } from '../redis';
import { db } from '../db';
import { logger } from '../utils/logger';
import { bot } from '../bot';

let broadcastWorker: Worker | null = null;

export const initBroadcastWorker = () => {
  if (broadcastWorker) return;
  broadcastWorker = new Worker('broadcast', async (job: Job) => {
    const { text } = job.data;
    
    // Broadcast message to all users safely
    // Note: In a real environment, you'd page through the db
    const users = await db.user.findMany({ select: { telegramId: true } });
    
    let sent = 0;
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.telegramId.toString(), text);
        sent++;
        // Throttle to respect telegram limits (30 per second broad limit)
        await new Promise(r => setTimeout(r, 50));
      } catch (err) {
        // Ignore users who blocked the bot
      }
    }
    
    logger.info(`📢 Broadcast complete. Sent to ${sent}/${users.length} users.`);
  }, { connection: redis });
};

export const closeBroadcastWorker = async () => {
  if (broadcastWorker) {
    await broadcastWorker.close();
  }
};
