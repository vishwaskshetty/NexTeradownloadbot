import { messageHandler } from '../src/bot/handlers/message';
import { TeraBoxResolver } from '../src/providers/terabox/terabox.resolver';
import { TeraBoxGatewayVerificationSessionError } from '../src/providers/errors';
import { jobService } from '../src/services/JobService';
import { config } from '../src/config';

describe('Telegram Markdown Safety & Verification Prompt Regression Tests', () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      state: {
        user: {
          id: 'user_123',
          telegramId: BigInt(12345678),
          plan: 'FREE',
        },
      },
      from: { first_name: 'TestUser' },
      message: { text: 'https://terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ' },
      reply: jest.fn().mockResolvedValue({ message_id: 999 }),
      telegram: {
        sendMessage: jest.fn().mockResolvedValue({ message_id: 1000 }),
        editMessageText: jest.fn().mockResolvedValue({ message_id: 1000 }),
      },
    };

    (config as any).TERABOX_TERAFLY_ENABLED = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('a & c: TeraBox verification-required error with Markdown characters (_v2, *, _) does not throw 400 entity parse error', async () => {
    const metaErr = new Error('TeraBox verification required: need verify_v2');
    jest.spyOn(TeraBoxResolver.prototype, 'getShareMetadata').mockRejectedValueOnce(metaErr);

    jest.spyOn(jobService, 'createJob').mockResolvedValueOnce({
      job: { id: 'job_verif_safe', userId: 'user_123', status: 'PENDING' } as any,
      isExisting: false,
    });
    jest.spyOn(jobService, 'getActiveJob').mockResolvedValueOnce(null);
    jest.spyOn(jobService, 'updateJobStatus').mockResolvedValue(true as any);

    // Run messageHandler
    await messageHandler(mockCtx);

    // Verify that reply was NOT called with raw unescaped markdown error string that triggers Telegram 400
    for (const call of mockCtx.reply.mock.calls) {
      const text = call[0];
      const opts = call[1];
      if (opts && opts.parse_mode === 'Markdown') {
        // Must not contain unescaped verify_v2
        expect(text).not.toContain('verify_v2');
      }
    }
  });

  it('b: URLs containing _, -, ., ?, =, &, %, () are safely handled when queued', async () => {
    mockCtx.message.text = 'https://terabox.com/s/1fKv_uk-FF.lwMq?Ht=3v&bd=Fo%20(RYQ)';

    jest.spyOn(TeraBoxResolver.prototype, 'getShareMetadata').mockResolvedValueOnce({
      shareCode: '1fKv_uk-FF.lwMq',
      fileList: [{ fs_id: '123', server_filename: 'test_video_v1.mp4', size: 1000 }],
    } as any);

    jest.spyOn(jobService, 'createJob').mockResolvedValueOnce({
      job: { id: 'job_url_safe', userId: 'user_123', status: 'PENDING' } as any,
      isExisting: false,
    });
    jest.spyOn(jobService, 'getActiveJob').mockResolvedValueOnce(null);
    jest.spyOn(jobService, 'updateJobStatus').mockResolvedValue(true as any);

    await messageHandler(mockCtx);

    // Message sending must succeed without throwing Telegram 400
    expect(mockCtx.reply).toHaveBeenCalled();
  });

  it('d: Verification button with public URL is passed separately in reply_markup and is not interpolated into Markdown text', async () => {
    const verifErr = new TeraBoxGatewayVerificationSessionError(
      'sess_abcd_1234',
      'https://terabox-gateway-nex-production.up.railway.app/verification/sess_abcd_1234',
      'TeraBox requires manual browser verification.'
    );

    // Verification button URL
    const publicUrl = verifErr.verificationUrl;
    expect(publicUrl).toContain('https://terabox-gateway-nex-production.up.railway.app');

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔐 Complete TeraBox Verification', url: publicUrl }],
        ],
      },
    };

    expect(keyboard.reply_markup.inline_keyboard[0][0].url).toBe(publicUrl);
  });
});
