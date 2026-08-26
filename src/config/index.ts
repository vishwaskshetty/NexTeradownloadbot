import { z } from 'zod';

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  DATABASE_URL: process.env.NODE_ENV === 'test'
    ? z.string().default('file:./dev.db')
    : z.string().min(1, 'DATABASE_URL must be set in .env'),
  DIRECT_URL: z.string().optional(), // Non-pooled Supabase URL for Prisma migrations
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  SHORTENER_PROVIDER: z.string().default('arolinks'),
  SHORTENER_API_KEY: z.string().optional(),
  VERIFICATION_BASE_URL: z.string().optional(),
  VERIFICATION_VALIDITY_MINUTES: z.coerce.number().default(15),
  ADMIN_TELEGRAM_IDS: z.string().transform((val) => val.split(',').filter(Boolean).map(Number)).default(''),
  FREE_DAILY_LIMIT: z.coerce.number().default(5),
  PREMIUM_DAILY_LIMIT: z.coerce.number().default(50),
  REDIS_URL: process.env.NODE_ENV === 'test' 
    ? z.string().default('redis://127.0.0.1:6379') 
    : z.string().url('REDIS_URL must be a valid connection string in .env'),
  REDIS_TLS: z.coerce.boolean().default(false),
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  MAX_QUEUE_SIZE: z.coerce.number().default(100),
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().default(1),
  JOB_TIMEOUT_MS: z.coerce.number().default(1800000), // 30m default
  STORAGE_CHANNEL_ID: z.string().optional(),
  STORAGE_RETENTION_HOURS: z.coerce.number().default(24),
  BOT_USERNAME: z.string().default('NexTeraDownloadBot'),
  ENABLE_TELEGRAM_POLLING: z.coerce.boolean().default(true),
  REFERRAL_ENABLED: z.coerce.boolean().default(true),
  REFERRALS_REQUIRED: z.coerce.number().default(10),
  REFERRAL_REWARD_DAYS: z.coerce.number().default(5),
  // TeraBox Official API & Cookie credentials (optional)
  TERABOX_CLIENT_ID: z.string().optional(),
  TERABOX_CLIENT_SECRET: z.string().optional(),
  TERABOX_ACCESS_TOKEN: z.string().optional(),
  TERABOX_REFRESH_TOKEN: z.string().optional(),
  TERABOX_NDUS: z.string().optional(),
  TERABOX_GATEWAY_URL: z.string().optional(),
  // Diskwala Official API credentials (optional)
  DISKWALA_API_KEY: z.string().optional(),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const config = _env.data;

const isNdusConfigured = typeof config.TERABOX_NDUS === 'string' && config.TERABOX_NDUS.trim().length > 0;
if (process.env.NODE_ENV !== 'test') {
  console.log(`[Config] TERABOX_NDUS loaded: ${isNdusConfigured ? 'YES' : 'NO'}`);
  console.log(`[TeraBox Auth] TERABOX_NDUS configured: ${isNdusConfigured ? 'YES' : 'NO'}`);
  console.log(`[TeraBox Auth] Configuration source: environment`);
}


