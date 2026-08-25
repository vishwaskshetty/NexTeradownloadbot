import Redis, { RedisOptions } from 'ioredis';
import { config } from './config';
import { logger } from './utils/logger';

const isRediss = config.REDIS_URL.startsWith('rediss://');
const isUpstash = config.REDIS_URL.includes('upstash.io');

let retryCounter = 0;

const options: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  family: 0, // Allow both IPv4 and IPv6 resolution
  retryStrategy(times) {
    retryCounter = times;
    const delay = Math.min(times * 500, 10000);
    if (times % 5 === 1) {
      logger.warn(`Redis connection retry #${times} in ${delay / 1000}s...`);
    }
    return delay;
  },
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'];
    if (targetErrors.some(e => err.message.includes(e))) {
      return true;
    }
    return false;
  }
};

if (isRediss || config.REDIS_TLS || isUpstash) {
  options.tls = {
    rejectUnauthorized: false
  };
}

export const redis = new Redis(config.REDIS_URL, options);

// Prevent max listeners warning since bullmq might attach listeners
redis.setMaxListeners(20);

// Log errors with 10-second throttling to prevent log spamming
let lastErrorTime = 0;
redis.on('error', (err: any) => {
  const now = Date.now();
  if (now - lastErrorTime > 10000) {
    const cleanMsg = (err.message || '').replace(/:[^:]*@/, ':***@');
    logger.error(`Redis connection error: ${cleanMsg}`);
    lastErrorTime = now;
  }
});

let hasConnected = false;
redis.on('connect', () => {
  if (!hasConnected) {
    logger.info('Redis connected successfully');
    hasConnected = true;
  } else if (retryCounter > 0) {
    logger.info(`Redis reconnected successfully after ${retryCounter} attempts.`);
    retryCounter = 0;
  }
});
