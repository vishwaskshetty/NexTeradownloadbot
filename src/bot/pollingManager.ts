import { Telegraf } from 'telegraf';
import { logger } from '../utils/logger';
import { redis } from '../redis';
import { config } from '../config';
import os from 'os';
import crypto from 'crypto';

export interface PollingStatus {
  instanceId: string;
  isLockAcquired: boolean;
  currentOwner: string | null;
  lockTtlMs: number;
  isPollingActive: boolean;
}

export class TelegramPollingManager {
  private static instance: TelegramPollingManager | null = null;

  public readonly instanceId: string;
  public readonly lockKey: string = 'telegram:polling:lock';
  public readonly lockTtlMs: number = 30000;
  public readonly renewIntervalMs: number = 10000;
  public readonly retryIntervalMs: number = 12000;

  private isPollingActive: boolean = false;
  private renewalTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private bot: Telegraf<any> | null = null;
  private isShuttingDown: boolean = false;

  private readonly renewScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  private readonly releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(customInstanceId?: string) {
    this.instanceId =
      customInstanceId ||
      `${os.hostname()}_pid${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  }

  public static getInstance(): TelegramPollingManager {
    if (!TelegramPollingManager.instance) {
      TelegramPollingManager.instance = new TelegramPollingManager();
    }
    return TelegramPollingManager.instance;
  }

  public getStatus(): PollingStatus {
    return {
      instanceId: this.instanceId,
      isLockAcquired: this.isPollingActive,
      currentOwner: null,
      lockTtlMs: 0,
      isPollingActive: this.isPollingActive,
    };
  }

  public async acquireLock(redisClient = redis): Promise<boolean> {
    try {
      const res = await redisClient.set(
        this.lockKey,
        this.instanceId,
        'PX',
        this.lockTtlMs,
        'NX'
      );
      return res === 'OK';
    } catch (e: any) {
      logger.warn(`[Telegram Polling] Redis error during lock acquisition: ${e.message}`);
      return false;
    }
  }

  public async renewLock(redisClient = redis): Promise<boolean> {
    try {
      const res = await redisClient.eval(
        this.renewScript,
        1,
        this.lockKey,
        this.instanceId,
        this.lockTtlMs
      );
      return res === 1;
    } catch (e: any) {
      logger.warn(`[Telegram Polling] Redis error during lock renewal: ${e.message}`);
      return false;
    }
  }

  public async releaseLock(redisClient = redis): Promise<boolean> {
    try {
      const res = await redisClient.eval(
        this.releaseScript,
        1,
        this.lockKey,
        this.instanceId
      );
      return res === 1;
    } catch (e: any) {
      logger.warn(`[Telegram Polling] Redis error during lock release: ${e.message}`);
      return false;
    }
  }

  public async start(bot: Telegraf<any>): Promise<void> {
    this.bot = bot;
    this.isShuttingDown = false;

    if (!config.ENABLE_TELEGRAM_POLLING) {
      logger.info(`[Telegram Polling] Polling is disabled via ENABLE_TELEGRAM_POLLING=false.`);
      return;
    }

    await this.tryAcquireAndStart();
  }

  public async tryAcquireAndStart(): Promise<void> {
    if (this.isShuttingDown || this.isPollingActive) {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    logger.info(`[Telegram Polling] Attempting to acquire lock for instance ${this.instanceId}...`);

    const acquired = await this.acquireLock();
    const currentOwner = (await redis.get(this.lockKey).catch(() => null)) || 'unknown';
    const currentTtl = (await redis.pttl(this.lockKey).catch(() => 0)) || 0;

    if (acquired) {
      logger.info(`[Telegram Polling] Lock acquired by ${this.instanceId}`);
      logger.info(`[Telegram Polling] Current lock owner: ${this.instanceId}`);
      logger.info(`[Telegram Polling] Lock TTL: ${this.lockTtlMs} ms`);
      logger.info(`[Telegram Polling] Polling active: YES`);
      await this.launchPolling();
    } else {
      if (currentTtl <= 0) {
        logger.info(`[Telegram Polling] Stale lock detected, recovering...`);
      }
      logger.info(`[Telegram Polling] Lock held by ${currentOwner}, running worker/HTTP only (TTL: ${currentTtl > 0 ? currentTtl : 0} ms)`);
      logger.info(`[Telegram Polling] Lock acquired: NO`);
      logger.info(`[Telegram Polling] Polling active: NO`);

      // Standby replica / candidate: retry acquisition in background with jitter
      const jitterMs = Math.floor(Math.random() * 4000);
      const nextDelay = this.retryIntervalMs + jitterMs;
      logger.info(`[Telegram Polling] Replica in standby. Next acquisition attempt in ${nextDelay}ms...`);
      this.retryTimer = setTimeout(() => {
        this.tryAcquireAndStart().catch(e => logger.error(`[Telegram Polling] Retry error: ${e.message}`));
      }, nextDelay);
      this.retryTimer.unref();
    }
  }

  private async launchPolling(): Promise<void> {
    if (!this.bot || this.isPollingActive) {
      return;
    }

    try {
      logger.info(`[Telegram Polling] Testing bot token for instance ${this.instanceId}...`);
      const me = await this.bot.telegram.getMe();
      logger.info(`[Telegram Polling] Bot initialized successfully (@${me.username})`);

      logger.info(`[Telegram Polling] Removing leftover webhooks...`);
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (e: any) {
      if (e?.response?.error_code === 409 || e?.message?.includes('409') || e?.message?.includes('Conflict')) {
        await this.handleConflict();
        return;
      }
      logger.error(`[Telegram Polling] Webhook removal / getMe failed: ${e.message}`);
    }

    this.isPollingActive = true;
    logger.info(`🚀 [Telegram Polling] Starting long-polling on instance ${this.instanceId}...`);

    this.bot
      .launch({ dropPendingUpdates: true })
      .catch(async (err: any) => {
        if (err?.response?.error_code === 409 || err?.message?.includes('409') || err?.message?.includes('Conflict')) {
          await this.handleConflict();
        } else {
          logger.error(`❌ [Telegram Polling] Polling loop error: ${err.message}`);
        }
      });

    // Start periodic renewal heartbeat
    this.startRenewalHeartbeat();
  }

  private startRenewalHeartbeat(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }

    this.renewalTimer = setInterval(async () => {
      if (!this.isPollingActive || this.isShuttingDown) {
        return;
      }

      const renewed = await this.renewLock();
      if (!renewed) {
        logger.warn(
          `⚠️ [Telegram Polling] Lock renewal failed for instance ${this.instanceId}. Relinquishing polling to prevent duplicate consumer conflict.`
        );
        await this.stopLocalPollingOnly();
        // Re-enter candidate standby loop
        const jitter = Math.floor(Math.random() * 3000);
        this.retryTimer = setTimeout(() => {
          this.tryAcquireAndStart().catch(e => logger.error(`[Telegram Polling] Re-acquire error: ${e.message}`));
        }, 5000 + jitter);
        this.retryTimer.unref();
      }
    }, this.renewIntervalMs);
    this.renewalTimer.unref();
  }

  public async handleConflict(): Promise<void> {
    logger.warn(
      `⚠️ [Telegram 409 Conflict] Detected Telegram conflict on ${this.instanceId}. Relinquishing lock and re-entering candidate queue.`
    );
    await this.stopLocalPollingOnly();
    await this.releaseLock();

    // Back off and re-enter acquisition loop
    const backoffMs = 8000 + Math.floor(Math.random() * 5000);
    logger.info(`[Telegram Polling] Backing off for ${backoffMs}ms before re-attempting lock acquisition...`);
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.retryTimer = setTimeout(() => {
      this.tryAcquireAndStart().catch(e => logger.error(`[Telegram Polling] Conflict recovery error: ${e.message}`));
    }, backoffMs);
    this.retryTimer.unref();
  }

  public async stopLocalPollingOnly(): Promise<void> {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }

    if (this.isPollingActive && this.bot) {
      try {
        this.bot.stop('SIGTERM');
        logger.info(`🟢 [Telegram Polling] Local polling stopped on instance ${this.instanceId}`);
      } catch (e) {}
    }
    this.isPollingActive = false;
  }

  public async stop(signal = 'SIGTERM'): Promise<void> {
    this.isShuttingDown = true;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }

    if (this.isPollingActive && this.bot) {
      try {
        this.bot.stop(signal);
        logger.info(`🟢 [Telegram Polling] Local polling stopped for shutdown on instance ${this.instanceId}`);
      } catch (e) {}
    }
    this.isPollingActive = false;

    // Release lock atomically
    const released = await this.releaseLock();
    if (released) {
      logger.info(`🟢 [Telegram Polling] Distributed lock released successfully on instance ${this.instanceId}`);
    }
  }
}

export const pollingManager = TelegramPollingManager.getInstance();
