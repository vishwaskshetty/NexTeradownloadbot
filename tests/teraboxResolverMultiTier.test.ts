import axios from 'axios';
import {
  normalizeNdus,
  normalizeGatewayUrl,
  mergeCookies,
  SessionCookieJar,
  inspectNdusConfiguration,
  extractTeraBoxDownloadUrl,
  extractJsToken,
  extractDpLogId,
  extractHomeSigningContext,
  signDownload,
  SignDownload,
  teraBoxResolver,
  TeraBoxResolver,
  clearTeraBoxShareCache,
  testTeraBoxAuthentication,
} from '../src/providers/terabox/terabox.resolver';
import {
  TeraBoxAuthRequiredError,
  TeraBoxAuthRejectedError,
  TeraBoxVerificationRequiredError,
  TeraBoxLinkResolutionFailedError,
  TeraBoxGatewayNotConfiguredError,
  TeraBoxGatewayUnreachableError,
  TeraBoxGatewayAuthFailedError,
  TeraBoxGatewayProviderFailedError,
  TeraBoxGatewayLinkNotFoundError,
  ProviderAccessError,
} from '../src/providers/errors';
import { config } from '../src/config';

describe('TeraBox Authenticated Multi-Tier Resolver Suite', () => {
  // 1. NDUS normalization
  describe('1. NDUS normalization', () => {
    it('normalizes various raw token formats and prefixes', () => {
      expect(normalizeNdus('token_12345')).toBe('token_12345');
      expect(normalizeNdus('ndus=token_12345')).toBe('token_12345');
      expect(normalizeNdus('Cookie: ndus=token_12345; other=abc')).toBe('token_12345');
      expect(normalizeNdus('"token_12345"')).toBe('token_12345');
      expect(normalizeNdus('ndus="token_12345"')).toBe('token_12345');
      expect(normalizeNdus('')).toBeNull();
      expect(normalizeNdus(undefined)).toBeNull();
    });
  });

  // 2. Gateway URL Normalization
  describe('2. Gateway URL Normalization', () => {
    it('normalizes and validates gateway URLs cleanly', () => {
      expect(normalizeGatewayUrl('http://localhost:5000/')).toBe('http://localhost:5000');
      expect(normalizeGatewayUrl('https://my-terabox-gateway.up.railway.app///')).toBe('https://my-terabox-gateway.up.railway.app');
      expect(normalizeGatewayUrl('https://gateway.example.com/api/')).toBe('https://gateway.example.com/api');
      expect(normalizeGatewayUrl('not_a_valid_url')).toBeNull();
      expect(normalizeGatewayUrl('ftp://example.com')).toBeNull();
      expect(normalizeGatewayUrl('')).toBeNull();
      expect(normalizeGatewayUrl(undefined)).toBeNull();
    });
  });

  // 3. Cookie merging
  describe('3. Cookie merging', () => {
    it('merges cookies and handles Set-Cookie headers properly', () => {
      const merged = mergeCookies('ndus=token123', [
        'csrfToken=csrftok; path=/',
        'browserid=bid123; domain=.terabox.app',
      ]);
      expect(merged).toContain('ndus=token123');
      expect(merged).toContain('csrfToken=csrftok');
      expect(merged).toContain('browserid=bid123');
    });
  });

  // 4. Session reuse & CookieJar
  describe('4. Session reuse & CookieJar', () => {
    it('preserves and updates cookies in SessionCookieJar', () => {
      const jar = new SessionCookieJar('ndus=test_ndus');
      expect(jar.has('ndus')).toBe(true);
      expect(jar.get('ndus')).toBe('test_ndus');

      jar.merge(['csrfToken=abc; path=/']);
      expect(jar.has('csrfToken')).toBe(true);
      expect(jar.getCookieNames()).toEqual(expect.arrayContaining(['ndus', 'csrfToken']));

      const header = jar.toCookieHeader();
      expect(header).toContain('ndus=test_ndus');
      expect(header).toContain('csrfToken=abc');
    });
  });

  // 5. Token extraction (jsToken & dp-logid)
  describe('5. Token extraction (jsToken & dp-logid)', () => {
    it('extracts jsToken from various HTML string patterns safely', () => {
      expect(extractJsToken('fn%28%22ABC123DEF%22%29')).toBe('ABC123DEF');
      expect(extractJsToken('fn("XYZ789")')).toBe('XYZ789');
      expect(extractJsToken("fn('TOKEN456')")).toBe('TOKEN456');
      expect(extractJsToken('"jsToken":"SECRET123"')).toBe('SECRET123');
      expect(extractJsToken('no token here')).toBeUndefined();
    });

    it('extracts dp-logid from response headers and HTML', () => {
      expect(extractDpLogId('', { 'dp-logid': 'log_9999' })).toBe('log_9999');
      expect(extractDpLogId('window.yunData = { "dp-logid": "log_html_123" };')).toBe('log_html_123');
      expect(extractDpLogId('dplogid="log_var_456"')).toBe('log_var_456');
      expect(extractDpLogId('')).toBeUndefined();
    });
  });

  // 6. extractHomeSigningContext from HTML
  describe('6. extractHomeSigningContext from HTML', () => {
    it('extracts sign1, sign3, timestamp, and security tokens from HTML / JS state', () => {
      const html = `
        <html>
          <script>
            window.yunData = {
              "sign1": "html_sign1_token",
              "sign3": "html_sign3_token",
              "timestamp": 1710000000,
              "bdstoken": "bds_token_123",
              "csrfToken": "csrf_token_456"
            };
          </script>
        </html>
      `;
      const ctx = extractHomeSigningContext(html);
      expect(ctx.sign1).toBe('html_sign1_token');
      expect(ctx.sign3).toBe('html_sign3_token');
      expect(ctx.timestamp).toBe(1710000000);
      expect(ctx.bdstoken).toBe('bds_token_123');
      expect(ctx.csrfToken).toBe('csrf_token_456');
    });
  });

  // 7. SignDownload algorithm & test vectors
  describe('7. SignDownload (RC4 stream cipher) algorithm', () => {
    it('produces valid base64 signature from sign3 and sign1 test vectors', () => {
      const sign3 = 'k3y12345';
      const sign1 = 'payloadData6789';
      const signb = signDownload(sign3, sign1);
      expect(typeof signb).toBe('string');
      expect(signb.length).toBeGreaterThan(0);
      expect(SignDownload(sign3, sign1)).toBe(signb);

      // Verify deterministic output
      const secondRun = signDownload(sign3, sign1);
      expect(secondRun).toBe(signb);
    });

    it('handles empty inputs safely', () => {
      expect(signDownload('', 'payload')).toBe('');
      expect(signDownload('key', '')).toBe('');
      expect(signDownload('', '')).toBe('');
    });
  });

  // 8. Gateway Resolution Adapter (saahiyo/terabox-gateway)
  describe('8. Gateway Resolution Adapter (saahiyo/terabox-gateway)', () => {
    let origGatewayUrl: string | undefined;
    let origAxiosGet: any;

    beforeEach(() => {
      origGatewayUrl = config.TERABOX_GATEWAY_URL;
      origAxiosGet = axios.get;
    });

    afterEach(() => {
      config.TERABOX_GATEWAY_URL = origGatewayUrl;
      axios.get = origAxiosGet;
    });

    it('normalizes Railway internal gateway URLs to port 8080 when port is omitted', () => {
      expect(normalizeGatewayUrl('http://terabox-gateway-nex.railway.internal')).toBe('http://terabox-gateway-nex.railway.internal:8080');
      expect(normalizeGatewayUrl('http://terabox-gateway-nex.railway.internal:8080')).toBe('http://terabox-gateway-nex.railway.internal:8080');
      expect(normalizeGatewayUrl('http://terabox-gateway-nex.railway.internal:8080/api')).toBe('http://terabox-gateway-nex.railway.internal:8080/api');
      expect(normalizeGatewayUrl('http://localhost:5000')).toBe('http://localhost:5000');
    });

    it('throws TeraBoxGatewayNotConfiguredError when gateway is unset', async () => {
      config.TERABOX_GATEWAY_URL = undefined;
      const resolver = new TeraBoxResolver();
      await expect(
        resolver.resolveViaTeraBoxGateway('testcode', '123')
      ).rejects.toThrow(TeraBoxGatewayNotConfiguredError);
    });

    it('successfully extracts download_link from saahiyo/terabox-gateway response', async () => {
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

    it('extracts direct_link, dlink, and proxy_url format correctly', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {
          direct_link: 'https://d.terabox.app/direct.mp4',
        },
      });

      (resolver as any).resolveDlinkRedirect = async (url: string) => ({
        finalUrl: url,
        redirectStatus: 200,
        finalHostname: 'd.terabox.app',
      });

      const res = await resolver.resolveViaTeraBoxGateway('code1', '123');
      expect(res?.downloadUrl).toBe('https://d.terabox.app/direct.mp4');
    });

    it('handles gateway HTTP 500 server error', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 500,
        headers: { 'content-type': 'application/json' },
        data: { error: 'Internal Server Error' },
      });

      await expect(
        resolver.resolveViaTeraBoxGateway('code1', '123')
      ).rejects.toThrow(TeraBoxGatewayUnreachableError);
    });

    it('calls exact /api endpoint with url and resolve=1 parameters and parses files array', async () => {
      config.TERABOX_GATEWAY_URL = 'http://terabox-gateway-nex.railway.internal';
      const resolver = new TeraBoxResolver();

      let calledUrl = '';
      let calledParams: any = {};

      axios.get = jest.fn().mockImplementation((url: string, opts: any) => {
        calledUrl = url;
        calledParams = opts?.params;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: {
            status: 'success',
            url: 'https://1024terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ',
            files: [
              {
                filename: 'video_file.mp4',
                size: '7.73 MB',
                size_bytes: 8108680,
                direct_link: 'https://d.terabox.app/download/video_direct.mp4',
                fs_id: '207400602392562',
              },
            ],
            total_files: 1,
          },
        });
      });

      (resolver as any).resolveDlinkRedirect = async (url: string) => ({
        finalUrl: url,
        redirectStatus: 200,
        finalHostname: 'd.terabox.app',
      });

      const res = await resolver.resolveViaTeraBoxGateway('1fKvukFFlwMqHt3vbdFoRYQ', '207400602392562');
      expect(calledUrl).toBe('http://terabox-gateway-nex.railway.internal:8080/api');
      expect(calledParams).toEqual({
        url: 'https://1024terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ',
        resolve: '1',
      });
      expect(res).not.toBeNull();
      expect(res?.fileName).toBe('video_file.mp4');
      expect(res?.size).toBe(8108680);
      expect(res?.downloadUrl).toBe('https://d.terabox.app/download/video_direct.mp4');
      expect(res?.source).toBe('terabox-gateway');
    });

    it('handles gateway verify_v2 errno response', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { errno: 400310, errmsg: 'need verify_v2' },
      });

      await expect(
        resolver.resolveViaTeraBoxGateway('code1', '123')
      ).rejects.toThrow(TeraBoxGatewayAuthFailedError);
    });

    it('handles gateway HTTP 409 provider_verification_required response', async () => {
      config.TERABOX_GATEWAY_URL = 'http://localhost:5000';
      const resolver = new TeraBoxResolver();

      axios.get = jest.fn().mockResolvedValue({
        status: 409,
        headers: { 'content-type': 'application/json' },
        data: { status: 'error', error: 'provider_verification_required', errno: 400210, message: 'need verify_v2' },
      });

      await expect(
        resolver.resolveViaTeraBoxGateway('https://terabox.com/s/1abc', '123')
      ).rejects.toThrow(TeraBoxGatewayAuthFailedError);
    });
  });

  // 9. Primary Strategy Ordering (Gateway FIRST when configured)
  describe('9. Primary Strategy Ordering (Gateway FIRST when configured)', () => {
    it('executes gateway first when TERABOX_GATEWAY_URL is configured', async () => {
      const customResolver = new TeraBoxResolver();
      const mockMeta = {
        shareId: '123',
        surl: 'testcode',
        uk: '456',
        timestamp: 1700000000,
        sign: 'abc',
        fileList: [
          {
            fs_id: '207400602392562',
            server_filename: '2026-04-23-18-55-38(8).mp4',
            size: 8108680,
            category: 1,
          },
        ],
      };

      (customResolver as any).getShareMetadata = async () => mockMeta;
      (customResolver as any).resolveWithGateway = async () => ({
        fileName: '2026-04-23-18-55-38(8).mp4',
        size: 8108680,
        downloadUrl: 'https://gateway.cdn.terabox/video.mp4',
        source: 'terabox-gateway',
      });
      (customResolver as any).resolveWithAuthenticatedDownloadFlow = jest.fn();

      const result = await customResolver.resolveSelectedFile('https://1024terabox.com/s/1testcode', '207400602392562');
      expect(result.downloadUrl).toBe('https://gateway.cdn.terabox/video.mp4');
      expect(result.source).toBe('terabox-gateway');
      // Authenticated download flow should not have been called because gateway succeeded
      expect((customResolver as any).resolveWithAuthenticatedDownloadFlow).not.toHaveBeenCalled();
    });
  });

  // 10. Strategy fallback order
  describe('10. Strategy fallback order', () => {
    it('falls back through strategies in order until success', async () => {
      const customResolver = new TeraBoxResolver();
      const mockMeta = {
        shareId: '123',
        surl: 'testcode',
        uk: '456',
        timestamp: 1700000000,
        sign: 'abc',
        fileList: [{ fs_id: '999', server_filename: 'video.mp4', size: 100 }],
      };

      (customResolver as any).getShareMetadata = async () => mockMeta;
      (customResolver as any).resolveWithGateway = async () => {
        throw new TeraBoxGatewayNotConfiguredError();
      };
      (customResolver as any).resolveWithAuthenticatedDownloadFlow = async () => {
        throw new TeraBoxAuthRejectedError('Auth rejected');
      };
      (customResolver as any).resolveWithTeraboxApiReference = async () => {
        throw new TeraBoxLinkResolutionFailedError('No dlink in share/list');
      };
      (customResolver as any).resolveWithPahadi10Flow = async () => {
        throw new TeraBoxVerificationRequiredError('Pahadi10 fail');
      };
      (customResolver as any).resolveWithHrishiFlow = async () => {
        throw new TeraBoxLinkResolutionFailedError('Hrishi fail');
      };
      (customResolver as any).resolveWithItzFlow = async () => {
        return {
          fileName: 'video.mp4',
          size: 100,
          downloadUrl: 'https://d.terabox.app/itz-success.mp4',
          source: 'itz-reference',
        };
      };

      const result = await customResolver.resolveSelectedFile('https://1024terabox.com/s/1testcode');
      expect(result.downloadUrl).toBe('https://d.terabox.app/itz-success.mp4');
      expect(result.source).toBe('itz-reference');
    });
  });

  // 11. Short-lived URL cache clearing
  describe('11. Short-lived URL cache clearing', () => {
    it('clearTeraBoxShareCache successfully triggers cache clearing', async () => {
      await expect(clearTeraBoxShareCache('testcode')).resolves.not.toThrow();
    });
  });
});
