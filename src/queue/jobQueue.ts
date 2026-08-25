import { Queue } from 'bullmq';
import { redis } from '../redis';

export const jobQueue = new Queue('downloads', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// For broadcasting messages to all users safely
export const broadcastQueue = new Queue('broadcast', {
  connection: redis
});
