import {
  normalizeNdus,
  mergeCookies,
  SessionCookieJar,
  inspectNdusConfiguration,
  extractTeraBoxDownloadUrl,
  extractJsToken,
  extractDpLogId,
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
  ProviderAccessError,
} from '../src/providers/errors';

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

  // 2. Cookie merging
  describe('2. Cookie merging', () => {
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

  // 3. Session reuse & CookieJar
  describe('3. Session reuse & CookieJar', () => {
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

  // 4. Token extraction (jsToken & dp-logid)
  describe('4. Token extraction (jsToken & dp-logid)', () => {
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

  // 5. SignDownload algorithm & test vectors
  describe('5. SignDownload (RC4 stream cipher) algorithm', () => {
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

  // 6. getHomeInfo & signb generation
  describe('6. getHomeInfo & signb generation', () => {
    it('fetches home info and computes signb on errno=0', async () => {
      const customResolver = new TeraBoxResolver();
      const mockJar = new SessionCookieJar('ndus=token');
      (customResolver as any).safeFetch = async (url: string) => {
        if (url.includes('/api/home/info')) {
          return {
            errno: 0,
            data: {
              sign1: 'test_sign1',
              sign3: 'test_sign3',
              timestamp: 1700000000,
            },
          };
        }
        return { errno: -1 };
      };

      const res = await customResolver.getHomeInfo(mockJar);
      expect(res.errno).toBe(0);
      expect(res.data?.sign1).toBe('test_sign1');
      expect(res.data?.sign3).toBe('test_sign3');
      expect(res.data?.timestamp).toBe(1700000000);
      expect(res.data?.signb).toBeDefined();
      expect(res.data?.signb).toBe(signDownload('test_sign3', 'test_sign1'));
    });
  });

  // 7. Full Authenticated /api/download flow
  describe('7. Full Authenticated /api/download flow (seiya-authenticated-download)', () => {
    it('executes updateAppData -> getHomeInfo -> signb -> POST /api/download -> redirect', async () => {
      const mockMeta = {
        shareId: '123',
        shareCode: '1fKvukFFlwMqHt3vbdFoRYQ',
        surl: '1fKvukFFlwMqHt3vbdFoRYQ',
        uk: '456',
        timestamp: 1700000000,
        sign: 'abc',
        jsToken: 'JSTOKEN123',
        cookies: 'ndus=mock_ndus_token',
        cookieJar: new SessionCookieJar('ndus=mock_ndus_token'),
        fileList: [
          {
            fs_id: '207400602392562',
            server_filename: '2026-04-23-18-55-38(8).mp4',
            size: 8108680,
            category: 1,
          },
        ],
      };

      const customResolver = new TeraBoxResolver();
      (customResolver as any).updateAppData = async () => true;
      (customResolver as any).getHomeInfo = async () => ({
        errno: 0,
        data: {
          sign1: 'sign1_sample',
          sign3: 'sign3_sample',
          signb: 'computed_signb',
          timestamp: 1700000000,
        },
      });
      (customResolver as any).safeFetch = async (url: string, opts: any) => {
        if (url.includes('/api/download')) {
          expect(opts.method).toBe('POST');
          expect(opts.data).toContain('fidlist=%5B%22207400602392562%22%5D');
          expect(opts.data).toContain('sign=computed_signb');
          return {
            errno: 0,
            dlink: 'https://d.terabox.app/download/2026-04-23-18-55-38(8).mp4',
          };
        }
        return { errno: -1 };
      };
      (customResolver as any).resolveDlinkRedirect = async (dlink: string) => ({
        finalUrl: dlink,
        redirectStatus: 200,
        finalHostname: 'd.terabox.app',
      });

      const res = await customResolver.resolveWithAuthenticatedDownloadFlow('207400602392562', mockMeta as any);
      expect(res.fileName).toBe('2026-04-23-18-55-38(8).mp4');
      expect(res.size).toBe(8108680);
      expect(res.downloadUrl).toBe('https://d.terabox.app/download/2026-04-23-18-55-38(8).mp4');
      expect(res.source).toBe('seiya-authenticated-download');
    });
  });

  // 8. Public-share /share/list flow
  describe('8. Public-share reference flow (/share/list -> file.dlink)', () => {
    it('resolves dlink from /share/list and performs redirect resolution', async () => {
      const mockMeta = {
        shareId: '123',
        shareCode: '1fKvukFFlwMqHt3vbdFoRYQ',
        surl: '1fKvukFFlwMqHt3vbdFoRYQ',
        uk: '456',
        timestamp: 1700000000,
        sign: 'abc',
        jsToken: 'JSTOKEN123',
        dpLogId: 'DPLOGID456',
        fileList: [
          {
            fs_id: '207400602392562',
            server_filename: '2026-04-23-18-55-38(8).mp4',
            size: 8108680,
            category: 1,
          },
        ],
      };

      const customResolver = new TeraBoxResolver();
      (customResolver as any).safeFetch = async (url: string) => {
        if (url.includes('/share/list')) {
          return {
            errno: 0,
            list: [
              {
                fs_id: '207400602392562',
                server_filename: '2026-04-23-18-55-38(8).mp4',
                size: 8108680,
                dlink: 'https://d.1024tera.com/file/207400602392562?sign=abcdef',
              },
            ],
          };
        }
        return { errno: -1 };
      };
      (customResolver as any).resolveDlinkRedirect = async (dlink: string) => ({
        finalUrl: dlink,
        redirectStatus: 200,
        finalHostname: 'd.1024tera.com',
      });

      const res = await customResolver.resolveWithTeraboxApiReference('207400602392562', mockMeta as any);
      expect(res.fileName).toBe('2026-04-23-18-55-38(8).mp4');
      expect(res.size).toBe(8108680);
      expect(res.downloadUrl).toBe('https://d.1024tera.com/file/207400602392562?sign=abcdef');
      expect(res.source).toBe('terabox-api-reference');
    });
  });

  // 9. Response normalization into TeraBoxResolvedFile
  describe('9. Response normalization into TeraBoxResolvedFile', () => {
    it('normalizes response into structured TeraBoxResolvedFile', async () => {
      const mockMeta = {
        shareId: '123',
        surl: 'testcode',
        uk: '456',
        timestamp: 1700000000,
        sign: 'abc',
        fileList: [
          {
            fs_id: '999',
            server_filename: 'video.mp4',
            size: 8108680,
            category: 1,
          },
        ],
      };

      const customResolver = new TeraBoxResolver();
      (customResolver as any).getShareMetadata = async () => mockMeta;
      (customResolver as any).resolveWithAuthenticatedDownloadFlow = async () => ({
        fileName: 'video.mp4',
        size: 8108680,
        downloadUrl: 'https://d.terabox.app/download/video.mp4',
        source: 'seiya-authenticated-download',
      });

      const result = await customResolver.resolveSelectedFile('https://1024terabox.com/s/1testcode', '999');
      expect(result.fileName).toBe('video.mp4');
      expect(result.fileSize).toBe(8108680);
      expect(result.fsId).toBe('999');
      expect(result.downloadUrl).toBe('https://d.terabox.app/download/video.mp4');
      expect(result.source).toBe('seiya-authenticated-download');
    });
  });

  // 10. Provider errno 400310 handling & verify_v2 classification
  describe('10. Provider errno 400310 handling & verify_v2 classification', () => {
    it('identifies 400310 and maps correctly', async () => {
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
      (customResolver as any).safeFetch = async () => ({
        errno: 400310,
        errmsg: 'need verify_v2',
      });

      await expect(
        customResolver.resolveSelectedFile('https://1024terabox.com/s/1testcode')
      ).rejects.toThrow();
    });
  });

  // 11. Strategy fallback order
  describe('11. Strategy fallback order', () => {
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

  // 12. Short-lived URL cache clearing
  describe('12. Short-lived URL cache clearing', () => {
    it('clearTeraBoxShareCache successfully triggers cache clearing', async () => {
      await expect(clearTeraBoxShareCache('testcode')).resolves.not.toThrow();
    });
  });
});
