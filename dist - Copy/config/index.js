"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    BOT_TOKEN: zod_1.z.string().min(1, 'BOT_TOKEN is required'),
    DATABASE_URL: process.env.NODE_ENV === 'test'
        ? zod_1.z.string().default('file:./dev.db')
        : zod_1.z.string().url('DATABASE_URL must be a valid connection string in .env'),
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: zod_1.z.string().default('info'),
    SHORTENER_PROVIDER: zod_1.z.string().default('arolinks'),
    SHORTENER_API_KEY: zod_1.z.string().optional(),
    VERIFICATION_BASE_URL: zod_1.z.string().optional(),
    VERIFICATION_VALIDITY_MINUTES: zod_1.z.coerce.number().default(15),
    ADMIN_TELEGRAM_IDS: zod_1.z.string().transform((val) => val.split(',').filter(Boolean).map(Number)).default(''),
    FREE_DAILY_LIMIT: zod_1.z.coerce.number().default(5),
    PREMIUM_DAILY_LIMIT: zod_1.z.coerce.number().default(50),
    REDIS_URL: process.env.NODE_ENV === 'test'
        ? zod_1.z.string().default('redis://127.0.0.1:6379')
        : zod_1.z.string().url('REDIS_URL must be a valid connection string in .env'),
    REDIS_TLS: zod_1.z.coerce.boolean().default(false),
    WORKER_CONCURRENCY: zod_1.z.coerce.number().default(2),
    MAX_QUEUE_SIZE: zod_1.z.coerce.number().default(100),
    MAX_ACTIVE_JOBS_PER_USER: zod_1.z.coerce.number().default(1),
    JOB_TIMEOUT_MS: zod_1.z.coerce.number().default(1800000), // 30m default
    STORAGE_CHANNEL_ID: zod_1.z.string().optional(),
    STORAGE_RETENTION_HOURS: zod_1.z.coerce.number().default(24),
    BOT_USERNAME: zod_1.z.string().default('NexTeraDownloadBot'),
    REFERRAL_ENABLED: zod_1.z.coerce.boolean().default(true),
    REFERRALS_REQUIRED: zod_1.z.coerce.number().default(10),
    REFERRAL_REWARD_DAYS: zod_1.z.coerce.number().default(5),
    // TeraBox Official API & Cookie credentials (optional)
    TERABOX_CLIENT_ID: zod_1.z.string().optional(),
    TERABOX_CLIENT_SECRET: zod_1.z.string().optional(),
    TERABOX_ACCESS_TOKEN: zod_1.z.string().optional(),
    TERABOX_REFRESH_TOKEN: zod_1.z.string().optional(),
    TERABOX_NDUS: zod_1.z.string().optional(),
    TERABOX_GATEWAY_URL: zod_1.z.string().optional(),
    // Diskwala Official API credentials (optional)
    DISKWALA_API_KEY: zod_1.z.string().optional(),
});
const _env = envSchema.safeParse(process.env);
if (!_env.success) {
    console.error('❌ Invalid environment variables:', _env.error.format());
    process.exit(1);
}
exports.config = _env.data;
