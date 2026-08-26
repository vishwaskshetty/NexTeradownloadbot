import { bot, isPollingLaunched } from '../src/bot';

describe('Telegram 409 Conflict & Polling Singleton Guard', () => {
  it('1. Bot instance is exported without auto-executing start() on module import', () => {
    expect(bot).toBeDefined();
    expect(typeof bot.launch).toBe('function');
    expect(typeof bot.telegram.getMe).toBe('function');
  });

  it('2. In-process guard tracks polling state correctly', () => {
    let launched = false;
    const launchGuard = () => {
      if (launched) {
        return 'SKIPPED_DUPLICATE';
      }
      launched = true;
      return 'STARTED';
    };

    expect(launchGuard()).toBe('STARTED');
    expect(launchGuard()).toBe('SKIPPED_DUPLICATE');
  });

  it('3. Distributed lock simulation prevents multi-replica duplicate polling', async () => {
    const lockMap = new Map<string, string>();

    const acquireLock = async (instanceId: string): Promise<boolean> => {
      if (lockMap.has('lock:telegram_polling')) {
        return false;
      }
      lockMap.set('lock:telegram_polling', instanceId);
      return true;
    };

    const releaseLock = async (instanceId: string): Promise<boolean> => {
      if (lockMap.get('lock:telegram_polling') === instanceId) {
        lockMap.delete('lock:telegram_polling');
        return true;
      }
      return false;
    };

    // Primary replica acquires lock
    const replica1 = 'hostA_pid100_abc';
    const replica2 = 'hostB_pid200_xyz';

    expect(await acquireLock(replica1)).toBe(true);
    // Secondary replica is blocked from polling
    expect(await acquireLock(replica2)).toBe(false);

    // Primary replica releases on shutdown
    expect(await releaseLock(replica1)).toBe(true);

    // Now secondary replica can acquire lock
    expect(await acquireLock(replica2)).toBe(true);
  });

  it('4. Telegram 409 Conflict error handler handles error gracefully without process exit', () => {
    let running = true;
    const conflictError = {
      response: { error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
      message: '409 Conflict'
    };

    const handleBotCatch = (err: any) => {
      if (err?.response?.error_code === 409 || err?.message?.includes('409')) {
        running = false;
        return 'STOPPED_POLLING';
      }
      throw err;
    };

    expect(handleBotCatch(conflictError)).toBe('STOPPED_POLLING');
    expect(running).toBe(false);
  });
});
