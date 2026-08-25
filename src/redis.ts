import Redis, { RedisOptions } from 'ioredis';
import { config } from './config';
import { logger } from './utils/logger';

const isRediss = config.REDIS_URL.startsWith('rediss://');
const isUpstash = config.REDIS_URL.includes('upstash.io');

const options: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  family: 0, // Allow both IPv4 and IPv6 resolution
  retryStrategy(times) {
    // Reconnect with exponential backoff, up to 10 seconds max
    const delay = Math.min(times * 500, 10000);
    return delay;
  },
};

if (isRediss || config.REDIS_TLS || isUpstash) {
  options.tls = {
    rejectUnauthorized: false
  };
}

export const redis = new Redis(config.REDIS_URL, options);

// Prevent max listeners warning since bullmq might attach listeners
redis.setMaxListeners(20);

// Only log error once per connection drop to avoid spam
let lastErrorTime = 0;
redis.on('error', (err: any) => {
  const now = Date.now();
  if (now - lastErrorTime > 10000) { // Log at most once every 10 seconds
    // Mask potential credentials in the error message
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
  }
});
