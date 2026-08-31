import axios from 'axios';
import { TeraFlyResolver, teraFlyResolver, TERAFLY_WORKER_ENDPOINT } from '../src/providers/terabox/terafly.resolver';
import { TeraBoxResolver } from '../src/providers/terabox/terabox.resolver';
import { ProviderUnavailableError, TeraBoxDownloadUrlError, TeraBoxGatewayVerificationSessionError, TeraBoxLinkResolutionFailedError } from '../src/providers/errors';
import { config } from '../src/config';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TeraFlyResolver Provider Unit Tests', () => {
  let originalEnvEnabled: any;

  beforeAll(() => {
    originalEnvEnabled = (config as any).TERABOX_TERAFLY_ENABLED;
  });

  afterEach(() => {
    jest.clearAllMocks();
    (config as any).TERABOX_TERAFLY_ENABLED = originalEnvEnabled;
  });

  describe('1. TeraFly Disabled', () => {
    it('should throw ProviderUnavailableError when disabled', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = false;
      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(ProviderUnavailableError);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('2. TeraFly Successful Resolution', () => {
    it('should extract direct download URL and return normalized result when enabled', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          title: 'sample_video.mp4',
          size: 104857600,
          download_url: 'https://d.terabox.com/file/sample_video.mp4?fin=sample_video.mp4',
        },
      });

      const resolver = new TeraFlyResolver();
      const result = await resolver.resolve('https://terabox.com/s/1abc123');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        { url: 'https://terabox.com/s/1abc123' },
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );

      expect(result).toEqual({
        fileName: 'sample_video.mp4',
        size: 104857600,
        downloadUrl: 'https://d.terabox.com/file/sample_video.mp4?fin=sample_video.mp4',
        source: 'terafly',
      });
    });
  });

  describe('3. TeraFly Primary Route Execution in TeraBoxResolver', () => {
    it('should resolve via TeraFly first and NEVER invoke TeraBox getShareMetadata or gateway on success', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          title: 'primary_video.mp4',
          size: 5000000,
          download_url: 'https://d.terabox.app/download/primary_video.mp4',
        },
      });

      const teraBoxResolver = new TeraBoxResolver();
      const metaSpy = jest.spyOn(teraBoxResolver as any, 'getShareMetadata');
      const gwSpy = jest.spyOn(teraBoxResolver as any, 'resolveViaTeraBoxGateway');

      const resolved = await teraBoxResolver.resolveSelectedFile('https://terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ');

      expect(resolved.source).toBe('terafly');
      expect(resolved.downloadUrl).toBe('https://d.terabox.app/download/primary_video.mp4');
      expect(metaSpy).not.toHaveBeenCalled();
      expect(gwSpy).not.toHaveBeenCalled();
    });

    it('should handle TeraFly failure without falling through to TeraBox auth cascade', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { ok: false, error: 'Link resolution failed' },
      });

      const teraBoxResolver = new TeraBoxResolver();
      const metaSpy = jest.spyOn(teraBoxResolver as any, 'getShareMetadata');

      await expect(
        teraBoxResolver.resolveSelectedFile('https://terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ')
      ).rejects.toThrow(TeraBoxDownloadUrlError);

      expect(metaSpy).not.toHaveBeenCalled();
    });
  });

  describe('4. TeraFly Malformed Response', () => {
    it('should throw TeraBoxDownloadUrlError on invalid non-object response', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: 'not a json object',
      });

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });

    it('should throw TeraBoxDownloadUrlError when backend returns ok=false', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: { ok: false, error: 'File deleted or unavailable' },
      });

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });
  });

  describe('5. TeraFly No Direct URL', () => {
    it('should throw TeraBoxDownloadUrlError when response has no URL field', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          title: 'file.mp4',
          size: 1000,
        },
      });

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });
  });

  describe('6. TeraFly Direct URL Validation', () => {
    it('should reject TeraBox share page returned as download URL', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          title: 'file.mp4',
          download_url: 'https://terabox.com/s/1abc123',
        },
      });

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });

    it('should reject verification challenge URL returned as download URL', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          title: 'file.mp4',
          download_url: 'https://www.terabox.com/api/verify_v2?s=123',
        },
      });

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });

    it('should reject passport/login URL returned as download URL', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      mockedAxios.post.mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          title: 'file.mp4',
          download_url: 'https://passport.terabox.com/login',
        },
      });

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });
  });

  describe('7. TeraFly Timeout', () => {
    it('should handle timeout error gracefully and throw TeraBoxDownloadUrlError', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      const timeoutErr: any = new Error('timeout of 15000ms exceeded');
      timeoutErr.isAxiosError = true;
      timeoutErr.code = 'ECONNABORTED';

      mockedAxios.post.mockRejectedValueOnce(timeoutErr);

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });
  });

  describe('8. TeraFly Network Failure', () => {
    it('should handle HTTP error status gracefully', async () => {
      (config as any).TERABOX_TERAFLY_ENABLED = true;

      const httpErr: any = new Error('Request failed with status code 503');
      httpErr.isAxiosError = true;
      httpErr.response = { status: 503, data: 'Service Unavailable' };

      mockedAxios.post.mockRejectedValueOnce(httpErr);

      const resolver = new TeraFlyResolver();
      await expect(resolver.resolve('https://terabox.com/s/1abc123')).rejects.toThrow(TeraBoxDownloadUrlError);
    });
  });
});
