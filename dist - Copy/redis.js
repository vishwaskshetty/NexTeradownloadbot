"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
const isRediss = config_1.config.REDIS_URL.startsWith('rediss://');
const isUpstash = config_1.config.REDIS_URL.includes('upstash.io');
let retryCounter = 0;
const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    family: 0, // Allow both IPv4 and IPv6 resolution
    retryStrategy(times) {
        retryCounter = times;
        const delay = Math.min(times * 500, 10000);
        if (times % 5 === 1) {
            logger_1.logger.warn(`Redis connection retry #${times} in ${delay / 1000}s...`);
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
if (isRediss || config_1.config.REDIS_TLS || isUpstash) {
    options.tls = {
        rejectUnauthorized: false
    };
}
exports.redis = new ioredis_1.default(config_1.config.REDIS_URL, options);
// Prevent max listeners warning since bullmq might attach listeners
exports.redis.setMaxListeners(20);
// Log errors with 10-second throttling to prevent log spamming
let lastErrorTime = 0;
exports.redis.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrorTime > 10000) {
        const cleanMsg = (err.message || '').replace(/:[^:]*@/, ':***@');
        logger_1.logger.error(`Redis connection error: ${cleanMsg}`);
        lastErrorTime = now;
    }
});
let hasConnected = false;
exports.redis.on('connect', () => {
    if (!hasConnected) {
        logger_1.logger.info('Redis connected successfully');
        hasConnected = true;
    }
    else if (retryCounter > 0) {
        logger_1.logger.info(`Redis reconnected successfully after ${retryCounter} attempts.`);
        retryCounter = 0;
    }
});
