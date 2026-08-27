import axios from 'axios';
import {
  TeraBoxResolver,
  normalizeGatewayUrl,
  extractTeraBoxDownloadUrl,
} from '../src/providers/terabox/terabox.resolver';
import {
  TeraBoxGatewayNotConfiguredError,
  TeraBoxGatewayUnreachableError,
  TeraBoxGatewayAuthFailedError,
  TeraBoxGatewayProviderFailedError,
  TeraBoxGatewayLinkNotFoundError,
  TeraBoxGatewayVerificationSessionError,
  TeraBoxGatewaySessionExpiredError,
  TeraBoxGatewayVerificationFailedError,
} from '../src/providers/errors';
import { config } from '../src/config';

describe('TeraBox Gateway Verification-Session Architecture Suite', () => {
  let origGatewayUrl: string | undefined;
  let origAxiosGet: any;
  let origAxiosPost: any;

  beforeEach(() => {
    origGatewayUrl = config.TERABOX_GATEWAY_URL;
    origAxiosGet = axios.get;
    origAxiosPost = axios.post;
  });

  afterEach(() => {
    config.TERABOX_GATEWAY_URL = origGatewayUrl;
    axios.get = origAxiosGet;
    axios.post = origAxiosPost;
  });

  // 1. Gateway Success (HTTP 200 direct download URL)
  describe('1. Gateway Success (HTTP 200)', () => {
    it('successfully extracts direct download URL from HTTP 200 gateway response', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {
          status: 'success',
          file_name: '2026-04-23-18-55-38(8).mp4',
          file_size: 8108680,
          download_link: 'https://d.terabox.app/download/gateway-file.mp4',
        },
      });

      (resolver as any).resolveDlinkRedirect = async (url: string) => ({
        finalUrl: url,
        redirectStatus: 200,
        finalHostname: 'd.terabox.app',
      });

      const res = await resolver.resolveViaTeraBoxGateway('1fKvukFFlwMqHt3vbdFoRYQ', '207400602392562');
      expect(res).not.toBeNull();
      expect(res?.fileName).toBe('2026-04-23-18-55-38(8).mp4');
      expect(res?.size).toBe(8108680);
      expect(res?.downloadUrl).toBe('https://d.terabox.app/download/gateway-file.mp4');
      expect(res?.source).toBe('terabox-gateway');
    });
  });

  // 2. HTTP 409 Provider Verification Required & Session Extraction
  describe('2. HTTP 409 Provider Verification Required & Session Extraction', () => {
    it('extracts session_id and verification_url on HTTP 409', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 409,
        headers: { 'content-type': 'application/json' },
        data: {
          status: 'provider_verification_required',
          session_id: 'gw_sess_999',
          verification_url: 'https://gateway.example.com/verify/gw_sess_999',
        },
      });

      await expect(
        resolver.resolveViaTeraBoxGateway('testcode', '123')
      ).rejects.toThrow(TeraBoxGatewayVerificationSessionError);
    });

    it('triggers onVerificationRequired callback and executes complete flow', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      // Initial call -> 409
      const mockGet = jest.fn()
        .mockResolvedValueOnce({
          status: 409,
          headers: { 'content-type': 'application/json' },
          data: {
            status: 'provider_verification_required',
            session_id: 'gw_sess_abc123',
            verification_url: 'https://gateway.example.com/verify/gw_sess_abc123',
          },
        })
        // Polling call 1 -> pending
        .mockResolvedValueOnce({
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: { status: 'verification_pending' },
        })
        // Polling call 2 -> completed
        .mockResolvedValueOnce({
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: { status: 'verification_completed' },
        });

      axios.get = mockGet;

      // Completion call -> 200 with download link
      axios.post = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {
          status: 'success',
          download_link: 'https://d.terabox.app/download/verified.mp4',
          file_name: 'verified.mp4',
          file_size: 8108680,
        },
      });

      (resolver as any).resolveDlinkRedirect = async (url: string) => ({
        finalUrl: url,
        redirectStatus: 200,
        finalHostname: 'd.terabox.app',
      });

      const onVerificationRequired = jest.fn().mockResolvedValue(undefined);

      const res = await resolver.resolveViaTeraBoxGateway('code1', '123', undefined, {
        onVerificationRequired,
      });

      expect(onVerificationRequired).toHaveBeenCalledWith({
        sessionId: 'gw_sess_abc123',
        verificationUrl: 'https://gateway.example.com/verify/gw_sess_abc123',
        shareCode: 'code1',
        fsId: '123',
      });

      expect(res?.downloadUrl).toBe('https://d.terabox.app/download/verified.mp4');
      expect(res?.source).toBe('terabox-gateway');
    });
  });

  // 3. Verification Polling Status Transitions
  describe('3. Verification Polling Status Transitions', () => {
    it('handles verification_expired state by throwing TeraBoxGatewaySessionExpiredError', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { status: 'verification_expired' },
      });

      await expect(
        resolver.pollGatewayVerificationSession('sess_exp', 5000, 100)
      ).rejects.toThrow(TeraBoxGatewaySessionExpiredError);
    });

    it('handles HTTP 410 (Gone/Expired) by throwing TeraBoxGatewaySessionExpiredError', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 410,
        headers: { 'content-type': 'application/json' },
        data: { error: 'Session expired' },
      });

      await expect(
        resolver.pollGatewayVerificationSession('sess_410', 5000, 100)
      ).rejects.toThrow(TeraBoxGatewaySessionExpiredError);
    });

    it('handles verification_failed state by throwing TeraBoxGatewayVerificationFailedError', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { status: 'verification_failed', message: 'CAPTCHA incorrect' },
      });

      await expect(
        resolver.pollGatewayVerificationSession('sess_fail', 5000, 100)
      ).rejects.toThrow(TeraBoxGatewayVerificationFailedError);
    });
  });

  // 4. Completion Endpoint Error Handling
  describe('4. Completion Endpoint Error Handling', () => {
    it('handles completion HTTP 409 (still requires verification)', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.post = jest.fn().mockResolvedValue({
        status: 409,
        headers: { 'content-type': 'application/json' },
        data: { error: 'verification_pending' },
      });

      await expect(
        resolver.completeGatewayVerification('sess_pending')
      ).rejects.toThrow(TeraBoxGatewayVerificationSessionError);
    });

    it('handles completion HTTP 410 (expired session)', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.post = jest.fn().mockResolvedValue({
        status: 410,
        headers: { 'content-type': 'application/json' },
        data: { error: 'expired' },
      });

      await expect(
        resolver.completeGatewayVerification('sess_410')
      ).rejects.toThrow(TeraBoxGatewaySessionExpiredError);
    });
  });

  // 5. Direct Link Validation (Reject invalid & non-direct URLs)
  describe('5. Direct Link Validation', () => {
    it('extracts valid direct CDN URLs and rejects non-direct challenge links', () => {
      expect(extractTeraBoxDownloadUrl('https://d.terabox.app/download/video.mp4')).toBe('https://d.terabox.app/download/video.mp4');
      expect(extractTeraBoxDownloadUrl('https://1024terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ')).toBeNull();
      expect(extractTeraBoxDownloadUrl('https://www.terabox.app/sharing/link?surl=abc')).toBeNull();
      expect(extractTeraBoxDownloadUrl('https://passport.terabox.com/login')).toBeNull();
      expect(extractTeraBoxDownloadUrl('https://terabox.com/verify/session123')).toBeNull();
      expect(extractTeraBoxDownloadUrl('invalid-url')).toBeNull();
    });
  });
});
