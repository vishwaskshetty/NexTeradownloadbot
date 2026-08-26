import { bot } from '../src/bot';
import { TelegramPollingManager } from '../src/bot/pollingManager';

describe('Telegram 409 Conflict & Distributed Polling Lifecycle Tests', () => {
  it('1. Bot instance is exported without auto-executing start() on module import', () => {
    expect(bot).toBeDefined();
    expect(typeof bot.launch).toBe('function');
    expect(typeof bot.telegram.getMe).toBe('function');
  });

  it('2. First instance acquires lock successfully', async () => {
    const mockStore = new Map<string, { value: string; expiresAt: number }>();
    const mockRedis: any = {
      set: jest.fn(async (key, val, mode, ttl, flag) => {
        const now = Date.now();
        const existing = mockStore.get(key);
        if (existing && existing.expiresAt > now) {
          return null;
        }
        mockStore.set(key, { value: val, expiresAt: now + ttl });
        return 'OK';
      }),
      eval: jest.fn(async (script, numKeys, key, val, ttl) => {
        const now = Date.now();
        const existing = mockStore.get(key);
        if (script.includes('pexpire')) {
          if (existing && existing.value === val && existing.expiresAt > now) {
            existing.expiresAt = now + Number(ttl);
            return 1;
          }
          return 0;
        }
        if (script.includes('del')) {
          if (existing && existing.value === val) {
            mockStore.delete(key);
            return 1;
          }
          return 0;
        }
        return 0;
      }),
      get: jest.fn(async (key) => {
        const item = mockStore.get(key);
        return item && item.expiresAt > Date.now() ? item.value : null;
      }),
      pttl: jest.fn(async (key) => {
        const item = mockStore.get(key);
        return item ? Math.max(0, item.expiresAt - Date.now()) : -2;
      })
    };

    const manager1 = new TelegramPollingManager('replica_1_hostA');
    const manager2 = new TelegramPollingManager('replica_2_hostB');

    // 1. First instance acquires lock
    const acquired1 = await manager1.acquireLock(mockRedis);
    expect(acquired1).toBe(true);

    // 2. Second instance cannot acquire lock while first is active
    const acquired2 = await manager2.acquireLock(mockRedis);
    expect(acquired2).toBe(false);

    // 3. Lock holder renews successfully
    const renewed1 = await manager1.renewLock(mockRedis);
    expect(renewed1).toBe(true);

    // 4. Non-owner cannot renew lock
    const renewed2 = await manager2.renewLock(mockRedis);
    expect(renewed2).toBe(false);

    // 5. Non-owner cannot release lock
    const released2 = await manager2.releaseLock(mockRedis);
    expect(released2).toBe(false);

    // 6. Owner releases lock successfully
    const released1 = await manager1.releaseLock(mockRedis);
    expect(released1).toBe(true);

    // 7. Second instance can now acquire lock after owner released
    const acquired2AfterRelease = await manager2.acquireLock(mockRedis);
    expect(acquired2AfterRelease).toBe(true);
  });

  it('3. Takeover happens automatically after stale lock expires', async () => {
    let mockTime = 1000000;
    const mockStore = new Map<string, { value: string; expiresAt: number }>();
    const mockRedis: any = {
      set: jest.fn(async (key, val, mode, ttl, flag) => {
        const existing = mockStore.get(key);
        if (existing && existing.expiresAt > mockTime) {
          return null;
        }
        mockStore.set(key, { value: val, expiresAt: mockTime + ttl });
        return 'OK';
      }),
      eval: jest.fn(async (script, numKeys, key, val, ttl) => {
        const existing = mockStore.get(key);
        if (script.includes('pexpire')) {
          if (existing && existing.value === val && existing.expiresAt > mockTime) {
            existing.expiresAt = mockTime + Number(ttl);
            return 1;
          }
          return 0;
        }
        if (script.includes('del')) {
          if (existing && existing.value === val) {
            mockStore.delete(key);
            return 1;
          }
          return 0;
        }
        return 0;
      }),
      get: jest.fn(async (key) => {
        const item = mockStore.get(key);
        return item && item.expiresAt > mockTime ? item.value : null;
      }),
      pttl: jest.fn(async (key) => {
        const item = mockStore.get(key);
        return item ? Math.max(0, item.expiresAt - mockTime) : -2;
      })
    };

    const staleManager = new TelegramPollingManager('crashed_replica_dead');
    const newReplica = new TelegramPollingManager('new_healthy_replica');

    // Stale instance acquires lock with 30s TTL
    expect(await staleManager.acquireLock(mockRedis)).toBe(true);

    // New instance attempts to acquire while stale is still valid
    expect(await newReplica.acquireLock(mockRedis)).toBe(false);

    // Stale instance crashes (no renewals, time advances by 35 seconds)
    mockTime += 35000;

    // New instance attempts acquisition and successfully takes over!
    expect(await newReplica.acquireLock(mockRedis)).toBe(true);
  });

  it('4. Telegram 409 Conflict triggers graceful backoff without crashing process', async () => {
    const manager = new TelegramPollingManager('conflict_test_replica');
    let localPollingActive = true;

    manager.stopLocalPollingOnly = jest.fn(async () => {
      localPollingActive = false;
    });
    manager.releaseLock = jest.fn(async () => true);

    await manager.handleConflict();

    expect(manager.stopLocalPollingOnly).toHaveBeenCalled();
    expect(manager.releaseLock).toHaveBeenCalled();
    expect(localPollingActive).toBe(false);
  });
});
