"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastQueue = exports.jobQueue = void 0;
const bullmq_1 = require("bullmq");
const redis_1 = require("../redis");
exports.jobQueue = new bullmq_1.Queue('downloads', {
    connection: redis_1.redis,
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
exports.broadcastQueue = new bullmq_1.Queue('broadcast', {
    connection: redis_1.redis
});
