import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { config } from '../../config';
import { redis } from '../../redis';
import { InvalidUrlError, NotFoundError, ProviderAccessError, ProviderUnavailableError, ProviderError } from '../errors';
import { logger } from '../../utils/logger';

/**
 * TypeScript Interfaces for TeraBox API responses
 */
export interface TeraBoxFileItem {
  fs_id: string | number;
  server_filename?: string;
  filename?: string;
  size?: number | string;
  category?: number;
  dlink?: string;
  isdir?: number | boolean;
  children?: TeraBoxFileItem[];
}

export interface TeraBoxShareMetadata {
  shareId?: string;
  surl: string;
  uk?: string;
  timestamp?: number;
  sign?: string;
  fileList: TeraBoxFileItem[];
}

export interface TeraBoxResolvedFile {
  fileName: string;
  fileSize: number;
  mimeType: string;
  downloadUrl: string;
  sourceUrl: string;
  headers?: Record<string, string>;
  isUnofficial?: boolean;
}

/**
 * Official & supported TeraBox public share domains.
 */
export const TERABOX_DOMAINS = [
  'terabox.com',
  'www.terabox.com',
  'teraboxapp.com',
  'www.teraboxapp.com',
  '1024terabox.com',
  'www.1024terabox.com',
  'teraboxlink.com',
  'nephobox.com',
  '4funbox.com',
  'mirrobox.com',
  'terabox.app',
  'www.terabox.app',
  'freeterabox.com',
  '1024tera.com',
  'momole.com',
  'gibox.com',
];

/**
 * Validates domain and guards against SSRF (blocking localhost, private IP ranges, etc.)
 */
export function isSafeTeraBoxUrl(inputUrl: string): boolean {
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // 1. SSRF Guard: Block localhost, loopback, private IPv4 & IPv6 addresses
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '::' ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return false;
    }

    // 2. Domain Whitelist Check
    return TERABOX_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Extract share code (surl) from TeraBox share link
 */
export function extractShareCode(url: string): string | null {
  try {
    const parsed = new URL(url);

    // /s/1XXXXX or /s/XXXXX format
    const pathMatch = parsed.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (pathMatch) {
      let code = pathMatch[1];
      if (code.startsWith('1')) {
        code = code.substring(1);
      }
      return code;
    }

    // ?surl=XXXXX format
    const surl = parsed.searchParams.get('surl');
    if (surl) {
      return surl.startsWith('1') ? surl.substring(1) : surl;
    }

    // ?shorturl=XXXXX format
    const shorturl = parsed.searchParams.get('shorturl');
    if (shorturl) {
      return shorturl.startsWith('1') ? shorturl.substring(1) : shorturl;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Checks whether official TeraBox API credentials are fully configured in environment
 */
export function hasTeraBoxCredentials(): boolean {
  return !!(
    config.TERABOX_CLIENT_ID &&
    config.TERABOX_CLIENT_SECRET &&
    config.TERABOX_ACCESS_TOKEN
  );
}

export class TeraBoxResolver {
  private readonly OFFICIAL_API_BASE = 'https://openapi.terabox.com';
  private readonly UNOFFICIAL_API_BASE = 'https://www.terabox.app';
  private readonly REQUEST_TIMEOUT_MS = 15000;
  private readonly MAX_RETRIES = 2;

  /**
   * Safe HTTP fetcher with AbortController timeout & limited retries for temporary network errors
   */
  private async safeFetch(url: string, options: AxiosRequestConfig = {}): Promise<any> {
    let attempt = 0;
    while (attempt <= this.MAX_RETRIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      const requestHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.terabox.app/',
        ...((options.headers as Record<string, string>) || {}),
      };

      if (config.TERABOX_NDUS && !requestHeaders['Cookie']) {
        requestHeaders['Cookie'] = `ndus=${config.TERABOX_NDUS}`;
      }

      try {
        const response = await axios({
          ...options,
          url,
          signal: controller.signal,
          timeout: this.REQUEST_TIMEOUT_MS,
          headers: requestHeaders,
          maxRedirects: 5,
        });
        clearTimeout(timer);
        return response.data;
      } catch (err: any) {
        clearTimeout(timer);
        attempt++;

        const isAxiosErr = axios.isAxiosError(err);
        const status = isAxiosErr ? err.response?.status : undefined;

        // Do NOT retry 4xx errors
        if (status && status >= 400 && status < 500) {
          throw err;
        }

        if (attempt <= this.MAX_RETRIES) {
          const delay = attempt * 1500;
          logger.warn(`[TeraBoxResolver] Network attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Retrieve file metadata array for a TeraBox share (supports both single and multi-file shares)
   */
  async getShareMetadata(url: string): Promise<TeraBoxShareMetadata> {
    if (!isSafeTeraBoxUrl(url)) {
      throw new InvalidUrlError('❌ Invalid TeraBox link');
    }

    const shareCode = extractShareCode(url);
    if (!shareCode) {
      throw new InvalidUrlError('❌ Unsupported TeraBox link');
    }

    logger.info(`[TeraBox] Resolving share URL code: ${shareCode}`);

    // Check cache
    const cacheKey = `terabox:meta_list:${shareCode}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as TeraBoxShareMetadata;
      }
    } catch {}

    let fileList: TeraBoxFileItem[] = [];

    // Strategy 1: Configured Gateway Service (if set)
    if (config.TERABOX_GATEWAY_URL) {
      try {
        const gwRes = await this.safeFetch(`${config.TERABOX_GATEWAY_URL}/api/get-info?shorturl=${shareCode}`);
        if (gwRes && Array.isArray(gwRes.list) && gwRes.list.length > 0) {
          fileList = gwRes.list;
        }
      } catch (e: any) {
        logger.warn(`[TeraBox] Configured gateway resolution failed: ${e.message}`);
      }
    }

    // Strategy 2: Official API
    if (fileList.length === 0 && hasTeraBoxCredentials()) {
      const accessToken = config.TERABOX_ACCESS_TOKEN!;
      try {
        const data = await this.safeFetch(`${this.OFFICIAL_API_BASE}/rest/2.0/xpan/share/sharepage/query`, {
          method: 'GET',
          params: { access_token: accessToken, shorturl: shareCode, root: 1 },
        });
        if (data && data.errno === 0 && Array.isArray(data.list)) {
          fileList = data.list;
        }
      } catch {}
    }

    // Strategy 3: Unofficial TeraBox shorturlinfo
    if (fileList.length === 0) {
      const infoUrl = `${this.UNOFFICIAL_API_BASE}/api/shorturlinfo`;
      try {
        const data = await this.safeFetch(infoUrl, {
          method: 'GET',
          params: { shorturl: shareCode, root: '1' },
        });
        if (data && data.errno === 0 && Array.isArray(data.list)) {
          fileList = data.list;
        }
      } catch {}

      if (fileList.length === 0) {
        const shareListUrl = `${this.UNOFFICIAL_API_BASE}/share/list`;
        try {
          const shareListData = await this.safeFetch(shareListUrl, {
            method: 'GET',
            params: { app_id: '250528', shorturl: shareCode, root: '1' },
          });
          if (shareListData && shareListData.errno === 0 && Array.isArray(shareListData.list)) {
            fileList = shareListData.list;
          }
        } catch {}
      }
    }

    if (fileList.length === 0) {
      throw new NotFoundError('❌ File is unavailable or private');
    }

    const firstFile = fileList[0];
    logger.info(`[TeraBox] File identified: "${firstFile.server_filename || firstFile.filename}" (Expected size: ${firstFile.size || 'unknown'})`);

    const metadata: TeraBoxShareMetadata = {
      surl: shareCode,
      fileList,
    };

    try {
      await redis.setex(cacheKey, 600, JSON.stringify(metadata));
    } catch {}

    return metadata;
  }

  /**
   * Resolve direct download URL for a specific selected file (or first file if fsId omitted)
   */
  async resolveSelectedFile(url: string, fsId?: string | number): Promise<TeraBoxResolvedFile> {
    const shareMetadata = await this.getShareMetadata(url);
    const fileList = shareMetadata.fileList;

    let file: TeraBoxFileItem | undefined;
    if (fsId !== undefined && fsId !== null) {
      file = fileList.find(f => String(f.fs_id) === String(fsId));
    }
    if (!file) {
      file = fileList[0];
    }

    if (!file) {
      throw new NotFoundError('❌ File is unavailable or private');
    }

    const shareCode = shareMetadata.surl;
    const fileName = file.server_filename || file.filename || `terabox_${shareCode}.file`;
    const fileSize = Number(file.size || 0);
    const mimeType = this.categoryToMime(file.category);

    let downloadUrl = file.dlink;

    if (!downloadUrl && config.TERABOX_GATEWAY_URL) {
      try {
        const gwRes = await this.safeFetch(`${config.TERABOX_GATEWAY_URL}/api/get-info?shorturl=${shareCode}&fs_id=${file.fs_id}`);
        if (gwRes?.downloadUrl) {
          downloadUrl = gwRes.downloadUrl;
        }
      } catch {}
    }

    if (!downloadUrl && hasTeraBoxCredentials()) {
      try {
        downloadUrl = await this.getOfficialDownloadUrl(config.TERABOX_ACCESS_TOKEN!, String(file.fs_id), shareCode);
      } catch {}
    }

    if (!downloadUrl) {
      downloadUrl = `${this.UNOFFICIAL_API_BASE}/share/download?surl=${shareCode}&fs_id=${file.fs_id}`;
    }

    logger.info(`[TeraBox] Direct download URL obtained for "${fileName}" (${fileSize} bytes)`);

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://www.terabox.app/',
      'Accept': '*/*',
    };

    if (config.TERABOX_NDUS) {
      headers['Cookie'] = `ndus=${config.TERABOX_NDUS}`;
    }

    return {
      fileName,
      fileSize,
      mimeType,
      downloadUrl,
      sourceUrl: url,
      headers,
      isUnofficial: !hasTeraBoxCredentials(),
    };
  }

  /**
   * Resolve public link metadata & download URL safely
   */
  async resolvePublicLink(url: string): Promise<TeraBoxResolvedFile> {
    return this.resolveSelectedFile(url);
  }

  /**
   * Official Download URL getter
   */
  private async getOfficialDownloadUrl(accessToken: string, fsId: string, shareCode: string): Promise<string> {
    const data = await this.safeFetch(`${this.OFFICIAL_API_BASE}/rest/2.0/xpan/share/sharepage/download`, {
      method: 'GET',
      params: {
        access_token: accessToken,
        shareid: shareCode,
        filelist: JSON.stringify([fsId]),
      },
    });

    const downloadList = data?.list || [];
    if (!downloadList[0]?.dlink) {
      throw new ProviderUnavailableError('❌ Temporary TeraBox service error. Please try again.');
    }
    return downloadList[0].dlink;
  }

  /**
   * Map TeraBox file categories to standard MIME types
   */
  private categoryToMime(category?: number): string {
    const map: Record<number, string> = {
      1: 'video/mp4',
      2: 'audio/mpeg',
      3: 'image/jpeg',
      4: 'application/pdf',
      5: 'application/octet-stream',
      6: 'application/zip',
    };
    return (category && map[category]) || 'application/octet-stream';
  }
}

export const teraBoxResolver = new TeraBoxResolver();
