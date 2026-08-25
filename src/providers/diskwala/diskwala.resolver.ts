import axios, { AxiosError } from 'axios';
import { config } from '../../config';
import { NotFoundError, ProviderAccessError, ProviderUnavailableError } from '../errors';
import { logger } from '../../utils/logger';

export interface DiskwalaResolvedFile {
  fileName: string;
  fileSize: number;
  mimeType: string;
  downloadUrl: string;
}

/**
 * Checks whether Diskwala official API credentials are configured.
 */
export function hasDiskwalaCredentials(): boolean {
  return !!config.DISKWALA_API_KEY;
}

export class DiskwalaResolver {
  private readonly DISKWALA_API_BASE = 'https://api.diskwala.com/v1';

  /**
   * Resolves a public Diskwala link using legitimate public access or official API credentials.
   * Throws ProviderAccessError if official access is required but credentials are absent.
   * Throws ProviderUnavailableError / NotFoundError on resolution failure.
   */
  async resolvePublicLink(url: string): Promise<DiskwalaResolvedFile> {
    logger.info(`[Diskwala] Resolving link: ${url}`);

    // If official credentials are configured, use the official API endpoint flow
    if (hasDiskwalaCredentials()) {
      return this.resolveWithOfficialApi(url);
    }

    // Attempt public page metadata resolution without bypassing security controls
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        maxRedirects: 5
      });

      const html: string = response.data || '';

      // Check if page indicates file not found / deleted
      if (html.includes('File Not Found') || html.includes('404 Not Found') || html.includes('File Deleted')) {
        throw new NotFoundError('This Diskwala file was not found or has been deleted.');
      }

      // Check if page requires user login or private permission
      if (html.includes('Access Denied') || html.includes('Login Required') || html.includes('Private File')) {
        throw new ProviderAccessError('Diskwala', 'This Diskwala file is private or requires login authorization.');
      }

      // Extract public metadata if exposed in standard meta tags or open attributes
      const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<title>([^<]+)<\/title>/i);
      
      const downloadLinkMatch = html.match(/<a\s+[^>]*href=["'](https?:\/\/[^"']+\/(?:download|direct|files)\/[^"']+)["']/i);

      if (titleMatch && downloadLinkMatch) {
        const fileName = titleMatch[1].replace(/ - Diskwala$/i, '').trim();
        const downloadUrl = downloadLinkMatch[1];
        
        logger.info(`[Diskwala] Resolved via public page: ${fileName}`);
        return {
          fileName: fileName || 'diskwala_file',
          fileSize: 0, // Unknown size from meta tag
          mimeType: 'application/octet-stream',
          downloadUrl
        };
      }

      // If page is accessible but does not expose a direct public download link without auth/API
      throw new ProviderAccessError('Diskwala');

    } catch (err: any) {
      if (err instanceof ProviderAccessError || err instanceof NotFoundError || err instanceof ProviderUnavailableError) {
        throw err;
      }

      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 404) {
        throw new NotFoundError('This Diskwala link was not found or has expired.');
      }

      // Default: Report requiring official API access rather than crashing
      throw new ProviderAccessError('Diskwala');
    }
  }

  /**
   * Resolves link via Diskwala's official API when DISKWALA_API_KEY is present.
   */
  private async resolveWithOfficialApi(url: string): Promise<DiskwalaResolvedFile> {
    try {
      const response = await axios.get(`${this.DISKWALA_API_BASE}/file/info`, {
        params: {
          key: config.DISKWALA_API_KEY,
          url
        },
        timeout: 15000,
        headers: {
          'User-Agent': 'NexTeraDownloadBot/1.0'
        }
      });

      const data = response.data;

      if (!data || data.status !== 200 || !data.result) {
        if (data?.status === 404) {
          throw new NotFoundError('This Diskwala file was not found.');
        }
        throw new ProviderUnavailableError('Diskwala API returned an invalid response.');
      }

      const file = data.result;
      return {
        fileName: file.filename || 'diskwala_file',
        fileSize: Number(file.size || 0),
        mimeType: file.mimetype || 'application/octet-stream',
        downloadUrl: file.download_url
      };
    } catch (err: any) {
      if (err instanceof NotFoundError || err instanceof ProviderUnavailableError) {
        throw err;
      }
      logger.error(`[Diskwala] Official API error: ${err?.message}`);
      throw new ProviderUnavailableError('Failed to access Diskwala API. Please try again later.');
    }
  }
}
