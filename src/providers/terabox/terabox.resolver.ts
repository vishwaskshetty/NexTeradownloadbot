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
  jsToken?: string;
  cookies?: string;
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
 * Diagnostic logger for candidate values without leaking secrets or full signed URLs
 */
export function describeCandidate(name: string, value: unknown): void {
  logger.info(
    `[TeraBox Debug] ${name}: ` +
      JSON.stringify({
        exists: value !== undefined && value !== null,
        type: Array.isArray(value) ? 'array' : typeof value,
        preview: typeof value === 'string' ? value.slice(0, 120) : undefined,
        objectKeys:
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.keys(value as Record<string, unknown>)
            : undefined,
      })
  );
}

/**
 * Diagnostic logger for provider API responses (errno, errmsg, requestId, keys)
 */
export function describeProviderResponse(name: string, response: unknown): void {
  if (!response || typeof response !== 'object') {
    logger.info(`[TeraBox Debug] ${name}: ` + JSON.stringify({ type: typeof response }));
    return;
  }

  const obj = response as Record<string, unknown>;

  logger.info(
    `[TeraBox Debug] ${name}: ` +
      JSON.stringify({
        keys: Object.keys(obj),
        errno: obj.errno,
        errmsg: typeof obj.errmsg === 'string' ? obj.errmsg.slice(0, 300) : undefined,
        requestId: obj.request_id ?? obj.request_id_string,
      })
  );
}

/**
 * Safely extracts and validates a download URL from any candidate source value.
 * Handles:
 * - Direct strings, nested objects ({ url, dlink, download_url, downloadUrl, link }), arrays
 * - Escaped characters (\/, \u0026, &amp;)
 * - Safe URL decoding without double-decoding
 * - Protocol validation (http:, https:)
 */
export function extractTeraBoxDownloadUrl(input: unknown): string | null {
  if (!input) return null;

  if (typeof input === 'string') {
    let cleaned = input.trim();
    if (!cleaned) return null;

    // Unescape JSON escaped slashes, html entities and unicode
    cleaned = cleaned.replace(/\\\//g, '/');
    cleaned = cleaned.replace(/\\u0026/g, '&');
    cleaned = cleaned.replace(/&amp;/g, '&');

    // If it looks like a URL-encoded string, try safe decode
    if (cleaned.includes('%3A%2F%2F') || cleaned.includes('%3a%2f%2f')) {
      try {
        cleaned = decodeURIComponent(cleaned);
      } catch {}
    }

    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return null;
    }
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const extracted = extractTeraBoxDownloadUrl(item);
      if (extracted) return extracted;
    }
    return null;
  }

  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, any>;
    const priorityKeys = [
      'dlink',
      'download_url',
      'downloadUrl',
      'url',
      'direct_link',
      'link',
      'download',
      'file_url',
    ];

    for (const key of priorityKeys) {
      if (obj[key] !== undefined && obj[key] !== null) {
        const extracted = extractTeraBoxDownloadUrl(obj[key]);
        if (extracted) return extracted;
      }
    }

    if (obj.data) {
      const extracted = extractTeraBoxDownloadUrl(obj.data);
      if (extracted) return extracted;
    }

    if (obj.list) {
      const extracted = extractTeraBoxDownloadUrl(obj.list);
      if (extracted) return extracted;
    }
  }

  return null;
}

export const extractValidDownloadUrl = extractTeraBoxDownloadUrl;
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

    logger.info(`[TeraBox] Share code resolved: ${shareCode}`);

    // Check cache
    const cacheKey = `terabox:meta_list:${shareCode}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as TeraBoxShareMetadata;
      }
    } catch {}

    let fileList: TeraBoxFileItem[] = [];

    let shareId: string | undefined;
    let uk: string | undefined;
    let sign: string | undefined;
    let timestamp: number | undefined;
    let jsToken: string | undefined;
    let sessionCookies: string | undefined;

    // Scrape share page to extract active jsToken and session cookies
    try {
      const pageRes = await axios.get(`https://dm.terabox.app/sharing/link?surl=1${shareCode}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 10000,
      });

      const html = String(pageRes.data || '');
      const jsTokenMatch = html.match(/fn%28%22([0-9A-Fa-f]+)%22%29/) || decodeURIComponent(html).match(/fn\("([0-9A-Fa-f]+)"\)/);
      jsToken = jsTokenMatch ? jsTokenMatch[1] : undefined;
      sessionCookies = pageRes.headers['set-cookie']
        ? pageRes.headers['set-cookie'].map((c: string) => c.split(';')[0]).join('; ')
        : undefined;
    } catch {}

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

    // Strategy 3: Unofficial shorturlinfo with jsToken and cookies
    if (fileList.length === 0) {
      const infoUrl = `${this.UNOFFICIAL_API_BASE}/api/shorturlinfo`;
      try {
        const data = await this.safeFetch(infoUrl, {
          method: 'GET',
          params: {
            app_id: '250528',
            shorturl: `1${shareCode}`,
            root: '1',
            ...(jsToken ? { jsToken } : {}),
          },
          headers: {
            ...(sessionCookies ? { Cookie: sessionCookies } : {}),
            Referer: `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
            Origin: 'https://www.terabox.app',
          },
        });
        if (data && data.errno === 0 && Array.isArray(data.list)) {
          fileList = data.list;
          shareId = String(data.shareid || data.share_id || '');
          uk = String(data.uk || '');
          sign = data.sign;
          timestamp = data.timestamp;
        }
      } catch {}

      if (fileList.length === 0) {
        const shareListUrl = `${this.UNOFFICIAL_API_BASE}/share/list`;
        try {
          const shareListData = await this.safeFetch(shareListUrl, {
            method: 'GET',
            params: {
              app_id: '250528',
              shorturl: shareCode,
              root: '1',
              ...(jsToken ? { jsToken } : {}),
            },
            headers: {
              ...(sessionCookies ? { Cookie: sessionCookies } : {}),
              Referer: `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
              Origin: 'https://www.terabox.app',
            },
          });
          if (shareListData && shareListData.errno === 0 && Array.isArray(shareListData.list)) {
            fileList = shareListData.list;
            shareId = String(shareListData.share_id || shareListData.shareid || '');
            uk = String(shareListData.uk || '');
            sign = shareListData.sign || sign;
            timestamp = shareListData.timestamp || timestamp;
          }
        } catch {}
      }
    }

    if (fileList.length === 0) {
      throw new NotFoundError('❌ File is unavailable or private');
    }

    logger.info(`[TeraBox] Number of files found: ${fileList.length}`);
    const firstFile = fileList[0];
    logger.info(`[TeraBox] File identified: "${firstFile.server_filename || firstFile.filename}" (Expected size: ${firstFile.size || 'unknown'})`);

    const metadata: TeraBoxShareMetadata = {
      surl: shareCode,
      shareId,
      uk,
      sign,
      timestamp,
      jsToken,
      cookies: sessionCookies,
      fileList,
    };

    try {
      // TTL = 300s: dlinks from TeraBox expire quickly; don't cache stale URLs for too long
      await redis.setex(cacheKey, 300, JSON.stringify(metadata));
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

    logger.info(`[TeraBox Debug] Selected fs_id: ${file.fs_id}`);
    logger.info(`[TeraBox Debug] selected file keys: ${Object.keys(file).join(', ')}`);
    describeCandidate('file.dlink', (file as any).dlink);
    describeCandidate('file.download_url', (file as any).download_url);
    describeCandidate('file.downloadUrl', (file as any).downloadUrl);
    describeCandidate('shareMetadata.sign', shareMetadata.sign);
    describeCandidate('shareMetadata.timestamp', shareMetadata.timestamp);

    const shareCode = shareMetadata.surl;
    const fileName = file.server_filename || file.filename || `terabox_${shareCode}.file`;
    const fileSize = Number(file.size || 0);
    const mimeType = this.categoryToMime(file.category);

    logger.info(`[TeraBox] Resolving direct download URL for fs_id ${file.fs_id}`);

    let gwRes: any = null;
    if (config.TERABOX_GATEWAY_URL) {
      try {
        gwRes = await this.safeFetch(`${config.TERABOX_GATEWAY_URL}/api/get-info?shorturl=${shareCode}&fs_id=${file.fs_id}`);
        describeProviderResponse('gatewayResponse', gwRes);
      } catch (gwErr: any) {
        logger.warn(`[TeraBox] Gateway request failed: ${gwErr.message}`);
      }
    }

    const candidateSources = [
      { source: 'file object', data: file },
      { source: 'configured gateway', data: gwRes },
      { source: 'configured gateway.data', data: gwRes?.data },
      { source: 'configured gateway.list', data: gwRes?.list },
    ];

    let downloadUrl: string | null = null;
    let selectedSource = 'none';
    let lastProviderErrno: number | undefined;
    let lastProviderErrMsg: string | undefined;

    for (const c of candidateSources) {
      const extracted = extractTeraBoxDownloadUrl(c.data);
      if (extracted) {
        downloadUrl = extracted;
        selectedSource = c.source;
        break;
      }
    }

    const activeJsToken = shareMetadata.jsToken;
    const activeCookies = shareMetadata.cookies;

    // Dynamic HTML jsToken + session cookie RPC
    if (!downloadUrl && shareMetadata.shareId && shareMetadata.uk) {
      try {
        logger.info(`[TeraBox Debug] jsToken present: ${activeJsToken ? 'YES' : 'NO'}`);
        logger.info(`[TeraBox] Requesting actual download link`);

        const downloadUrlObj = new URL(`${this.UNOFFICIAL_API_BASE}/share/download`);
        downloadUrlObj.searchParams.set('app_id', '250528');
        downloadUrlObj.searchParams.set('web', '1');
        downloadUrlObj.searchParams.set('channel', 'dubox');
        downloadUrlObj.searchParams.set('clienttype', '0');
        if (activeJsToken) {
          downloadUrlObj.searchParams.set('jsToken', activeJsToken);
        }
        if (shareMetadata.shareId) {
          downloadUrlObj.searchParams.set('shareid', String(shareMetadata.shareId));
        }
        if (shareMetadata.sign) {
          downloadUrlObj.searchParams.set('sign', String(shareMetadata.sign));
        }
        if (shareMetadata.timestamp) {
          downloadUrlObj.searchParams.set('timestamp', String(shareMetadata.timestamp));
        }

        const downloadRes = await this.safeFetch(downloadUrlObj.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
            'Origin': 'https://www.terabox.app',
            ...(activeCookies ? { 'Cookie': activeCookies } : {}),
          },
          data: new URLSearchParams({
            product: 'share',
            nozip: '0',
            fid_list: `[${file.fs_id}]`,
            uk: String(shareMetadata.uk),
            primaryid: String(shareMetadata.shareId),
            shareid: String(shareMetadata.shareId),
            sign: String(shareMetadata.sign || ''),
            timestamp: String(shareMetadata.timestamp || Math.floor(Date.now() / 1000)),
          }).toString(),
        });

        describeProviderResponse('dynamicDownloadRes', downloadRes);

        if (downloadRes && (downloadRes.errno === 0 || downloadRes.errno === undefined)) {
          const extracted = extractTeraBoxDownloadUrl(downloadRes);
          if (extracted) {
            downloadUrl = extracted;
            selectedSource = 'dynamic /share/download with jsToken';
          }
        } else if (downloadRes && downloadRes.errno !== undefined) {
          lastProviderErrno = downloadRes.errno;
          lastProviderErrMsg = downloadRes.errmsg;
          logger.warn(`[TeraBox] Dynamic download request rejected: errno=${downloadRes.errno}, errmsg=${downloadRes.errmsg || 'none'}`);
        }
      } catch (err: any) {
        logger.warn(`[TeraBox] Dynamic jsToken resolution failed: ${err.message}`);
      }
    }

    if (!downloadUrl && shareMetadata.shareId && shareMetadata.uk) {
      try {
        const downloadRes = await this.safeFetch(`${this.UNOFFICIAL_API_BASE}/share/download?app_id=250528`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': 'https://www.terabox.app/',
            ...(config.TERABOX_NDUS ? { 'Cookie': `ndus=${config.TERABOX_NDUS}` } : {})
          },
          data: new URLSearchParams({
            product: 'share',
            nozip: '0',
            fid_list: `[${file.fs_id}]`,
            share_id: String(shareMetadata.shareId),
            uk: String(shareMetadata.uk),
            sign: String(shareMetadata.sign || ''),
            timestamp: String(shareMetadata.timestamp || Math.floor(Date.now() / 1000)),
            primaryid: String(shareMetadata.shareId),
          }).toString()
        });
        describeProviderResponse('unofficialDownloadRes', downloadRes);
        if (downloadRes && (downloadRes.errno === 0 || downloadRes.errno === undefined)) {
          const extracted = extractTeraBoxDownloadUrl(downloadRes);
          if (extracted) {
            downloadUrl = extracted;
            selectedSource = 'unofficial /share/download';
          }
        } else if (downloadRes && downloadRes.errno !== undefined) {
          lastProviderErrno = downloadRes.errno;
          lastProviderErrMsg = downloadRes.errmsg;
        }
      } catch {}
    }

    if (!downloadUrl && hasTeraBoxCredentials()) {
      try {
        const officialDlink = await this.getOfficialDownloadUrl(config.TERABOX_ACCESS_TOKEN!, String(file.fs_id), shareCode);
        describeProviderResponse('officialDlink', officialDlink);
        const extracted = extractTeraBoxDownloadUrl(officialDlink);
        if (extracted) {
          downloadUrl = extracted;
          selectedSource = 'official API';
        }
      } catch {}
    }

    if (!downloadUrl) {
      const errDetail = lastProviderErrno !== undefined ? ` (errno=${lastProviderErrno}${lastProviderErrMsg ? `, errmsg=${lastProviderErrMsg}` : ''})` : '';
      logger.error(`[TeraBox] Failed to extract valid direct download URL for fs_id ${file.fs_id}${errDetail}`);
      throw new ProviderUnavailableError(
        `TeraBox download request rejected${errDetail}.`
      );
    }

    logger.info(`[TeraBox] Candidate URL extracted successfully (Source: ${selectedSource})`);

    try {
      const parsed = new URL(downloadUrl);
      logger.info(
        `[TeraBox] Valid download URL resolved: ` +
          JSON.stringify({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            pathname: parsed.pathname.slice(0, 80),
            queryKeys: [...parsed.searchParams.keys()],
          })
      );
    } catch {}

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

/**
 * Clears the Redis share-metadata cache for a given share code.
 * Call this before each retry so a fresh dlink is fetched from TeraBox.
 */
export async function clearTeraBoxShareCache(shareCode: string): Promise<void> {
  try {
    const cacheKey = `terabox:meta_list:${shareCode}`;
    await redis.del(cacheKey);
    logger.info(`[TeraBox] Share metadata cache cleared for ${shareCode}`);
  } catch (e: any) {
    logger.warn(`[TeraBox] Could not clear share metadata cache: ${e.message}`);
  }
}
