import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { config } from '../../config';
import { redis } from '../../redis';
import {
  InvalidUrlError,
  NotFoundError,
  ProviderAccessError,
  ProviderUnavailableError,
  ProviderError,
  TeraBoxResolverError,
  TeraBoxSessionError,
  TeraBoxMetadataError,
  TeraBoxMissingContextError,
  TeraBoxProviderError,
  TeraBoxDownloadUrlError,
  TeraBoxVerificationRequiredError,
  TeraBoxAuthRequiredError,
  TeraBoxAuthRejectedError,
  TeraBoxLinkResolutionFailedError,
} from '../errors';
import { logger } from '../../utils/logger';

/**
 * Normalizes raw TERABOX_NDUS value so that both `xyz` and `ndus=xyz` or `Cookie: ndus=xyz`
 * are correctly formatted as the clean token value.
 */
export function normalizeNdus(rawNdus?: string): string | null {
  if (!rawNdus) return null;
  const trimmed = rawNdus.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(?:^|;\s*|\b)ndus=([^;\s]+)/i);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

export interface NdusDiagnostic {
  configured: boolean;
  length: number;
  format: 'raw-token' | 'ndus-prefix' | 'cookie-prefix' | 'empty';
}

/**
 * Safe diagnostic inspector that returns format and length without revealing the token.
 */
export function inspectNdusConfiguration(rawNdus?: string): NdusDiagnostic {
  if (!rawNdus || typeof rawNdus !== 'string' || rawNdus.trim().length === 0) {
    return { configured: false, length: 0, format: 'empty' };
  }
  const trimmed = rawNdus.trim();
  let format: NdusDiagnostic['format'] = 'raw-token';
  if (/^Cookie:\s*ndus=/i.test(trimmed)) {
    format = 'cookie-prefix';
  } else if (/^ndus=/i.test(trimmed)) {
    format = 'ndus-prefix';
  }
  const normalized = normalizeNdus(trimmed);
  return {
    configured: Boolean(normalized && normalized.length > 0),
    length: normalized ? normalized.length : 0,
    format,
  };
}

const isNdusAvailable = Boolean(normalizeNdus(config.TERABOX_NDUS));
if (process.env.NODE_ENV !== 'test') {
  const isProcessEnvNdus = typeof process.env.TERABOX_NDUS === 'string' && process.env.TERABOX_NDUS.trim().length > 0;
  const isConfigNdus = typeof config.TERABOX_NDUS === 'string' && config.TERABOX_NDUS.trim().length > 0;
  const ndusLen = isConfigNdus ? config.TERABOX_NDUS!.trim().length : 0;
  logger.info(`[TeraBox Auth] Resolver version: 1.0.0`);
  logger.info(`[TeraBox Auth] Git commit: ${process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'a362d01'}`);
  logger.info(`[TeraBox Auth] process.env TERABOX_NDUS: ${isProcessEnvNdus ? 'YES' : 'NO'}${isProcessEnvNdus ? ` (length=${ndusLen})` : ''}`);
  logger.info(`[TeraBox Auth] config.TERABOX_NDUS: ${isConfigNdus ? 'YES' : 'NO'}${isConfigNdus ? ` (length=${ndusLen})` : ''}`);
  logger.info(`[TeraBox Auth] Resolver NDUS: ${isNdusAvailable ? 'YES' : 'NO'}`);
  logger.info(`[TeraBox Auth] Authenticated request enabled: ${isNdusAvailable ? 'YES' : 'NO'}`);
  const diag = inspectNdusConfiguration(config.TERABOX_NDUS);
  logger.info(`[TeraBox Auth] NDUS format: ${diag.format}, length: ${diag.length}`);
}


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
  shareId: string;
  shareCode?: string;
  surl: string;
  uk: string;
  timestamp: number | string;
  sign: string;
  jsToken?: string;
  cookies?: string;
  fileList: TeraBoxFileItem[];
}

export interface TeraBoxDownloadResult {
  fileName: string;
  size?: number;
  downloadUrl: string;
  source: string;
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
  const isNonEmpty =
    value !== undefined &&
    value !== null &&
    (typeof value !== 'string' || value.trim().length > 0);

  logger.info(
    `[TeraBox Debug] ${name}: ` +
      JSON.stringify({
        exists: isNonEmpty,
        type: Array.isArray(value) ? 'array' : typeof value,
        preview: typeof value === 'string' && value.trim().length > 0 ? value.slice(0, 120) : undefined,
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

  const obj = response as Record<string, any>;
  const dataObj = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data) ? obj.data : undefined;

  logger.info(
    `[TeraBox Debug] ${name}: ` +
      JSON.stringify({
        keys: Object.keys(obj),
        dataKeys: dataObj ? Object.keys(dataObj) : undefined,
        errno: obj.errno ?? dataObj?.errno,
        errmsg:
          typeof obj.errmsg === 'string'
            ? obj.errmsg.slice(0, 300)
            : typeof dataObj?.errmsg === 'string'
            ? dataObj.errmsg.slice(0, 300)
            : undefined,
        requestId:
          obj.request_id ??
          obj.request_id_string ??
          dataObj?.request_id ??
          dataObj?.request_id_string,
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

/**
 * Validates that all required cryptographic and session parameters
 * are present and well-formed before calling /share/download
 */
export function validateDownloadContext(context: {
  shareId?: string;
  uk?: string;
  sign?: string;
  timestamp?: number | string;
  fsId?: string | number;
}): void {
  const missing: string[] = [];
  if (!context.shareId || context.shareId.trim() === '') missing.push('shareId');
  if (!context.uk || context.uk.trim() === '') missing.push('uk');
  if (!context.sign || context.sign.trim() === '') missing.push('sign');
  if (!context.timestamp || String(context.timestamp).trim() === '' || Number.isNaN(Number(context.timestamp))) missing.push('timestamp');
  if (!context.fsId || String(context.fsId).trim() === '') missing.push('fsId');

  if (missing.length > 0) {
    throw new TeraBoxMissingContextError(
      `TeraBox download context validation failed. Missing required fields: ${missing.join(', ')}`
    );
  }
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

    logger.info(`[TeraBox] Stage 1: Resolving share code -> ${shareCode}`);

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
    let timestamp: number | string | undefined;
    let jsToken: string | undefined;
    let sessionCookies: string | undefined;

    logger.info(`[TeraBox] Stage 2: Creating share session`);
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
      logger.info(`[TeraBox] Stage 3: Extracting jsToken -> ${jsToken ? 'YES' : 'NO'}`);
    } catch (e: any) {
      logger.warn(`[TeraBox] Stage 2/3 session creation warning: ${e.message}`);
    }

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

    // Strategy 3: Authenticated shorturlinfo with session context
    if (fileList.length === 0) {
      logger.info(`[TeraBox] Stage 4: Requesting authenticated metadata`);
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

      // If shorturlinfo failed or returned verification error, refresh session once
      if (fileList.length === 0) {
        try {
          const refreshRes = await axios.get(`https://www.terabox.app/sharing/link?surl=${shareCode}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,*/*',
            },
            timeout: 10000,
          });
          const refreshHtml = String(refreshRes.data || '');
          const refreshedTokenMatch = refreshHtml.match(/fn%28%22([0-9A-Fa-f]+)%22%29/) || decodeURIComponent(refreshHtml).match(/fn\("([0-9A-Fa-f]+)"\)/);
          if (refreshedTokenMatch) jsToken = refreshedTokenMatch[1];
          if (refreshRes.headers['set-cookie']) {
            sessionCookies = refreshRes.headers['set-cookie'].map((c: string) => c.split(';')[0]).join('; ');
          }

          const retryData = await this.safeFetch(infoUrl, {
            method: 'GET',
            params: {
              app_id: '250528',
              shorturl: `1${shareCode}`,
              root: '1',
              ...(jsToken ? { jsToken } : {}),
            },
            headers: {
              ...(sessionCookies ? { Cookie: sessionCookies } : {}),
              Referer: `https://www.terabox.app/sharing/link?surl=${shareCode}`,
              Origin: 'https://www.terabox.app',
            },
          });
          if (retryData && retryData.errno === 0 && Array.isArray(retryData.list)) {
            fileList = retryData.list;
            shareId = String(retryData.shareid || retryData.share_id || '');
            uk = String(retryData.uk || '');
            sign = retryData.sign;
            timestamp = retryData.timestamp;
          }
        } catch {}
      }

      // Fallback share/list for file discovery only
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
      shareCode,
      surl: shareCode,
      shareId: shareId || '',
      uk: uk || '',
      sign: sign || '',
      timestamp: timestamp || '',
      jsToken,
      cookies: sessionCookies,
      fileList,
    };

    logger.info(
      `[TeraBox] Stage 5: Validating share context: ` +
        JSON.stringify({
          shareId: metadata.shareId ? 'YES' : 'NO',
          uk: metadata.uk ? 'YES' : 'NO',
          sign: metadata.sign ? 'YES' : 'NO',
          timestamp: metadata.timestamp ? 'YES' : 'NO',
          jsToken: metadata.jsToken ? 'YES' : 'NO',
          cookies: metadata.cookies ? 'YES' : 'NO',
        })
    );

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

    const shareCode = shareMetadata.shareCode || shareMetadata.surl || extractShareCode(url) || '';
    const fileName = file.server_filename || file.filename || `terabox_${shareCode}.file`;
    const fileSize = Number(file.size || 0);
    const mimeType = this.categoryToMime(file.category);

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

    // Primary Strategy: Authenticated Pahadi10 reference download flow
    if (!downloadUrl) {
      validateDownloadContext({
        shareId: shareMetadata.shareId,
        uk: shareMetadata.uk,
        sign: shareMetadata.sign,
        timestamp: shareMetadata.timestamp,
        fsId: file.fs_id,
      });

      const pahadiRes = await this.resolveWithPahadi10Flow(file.fs_id, shareMetadata);
      downloadUrl = pahadiRes.downloadUrl;
      selectedSource = pahadiRes.source;
    }

    if (!downloadUrl && shareMetadata.shareId && shareMetadata.uk && shareMetadata.sign && shareMetadata.timestamp) {
      try {
        const downloadRes = await this.safeFetch(`${this.UNOFFICIAL_API_BASE}/share/download?app_id=250528`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': 'https://www.terabox.app/',
            ...(config.TERABOX_NDUS ? { 'Cookie': `ndus=${normalizeNdus(config.TERABOX_NDUS)}` } : {})
          },
          data: new URLSearchParams({
            product: 'share',
            nozip: '0',
            fid_list: `[${file.fs_id}]`,
            share_id: String(shareMetadata.shareId),
            uk: String(shareMetadata.uk),
            sign: String(shareMetadata.sign),
            timestamp: String(shareMetadata.timestamp),
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
          logger.warn(`[TeraBox] Unofficial download request rejected: errno=${downloadRes.errno}`);
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
      logger.error(`[TeraBox] Failed to extract valid direct download URL for fs_id ${file.fs_id}`);
      throw new TeraBoxLinkResolutionFailedError(
        'TeraBox authentication succeeded but no direct download URL was returned.'
      );
    }

    logger.info(`[TeraBox] Candidate URL extracted successfully (Source: ${selectedSource})`);

    try {
      const parsed = new URL(downloadUrl);
      logger.info(
        `[TeraBox] Direct URL: resolved=YES, hostname=${parsed.hostname}, pathPrefix=${parsed.pathname.slice(0, 30)}, queryKeys=[${[...parsed.searchParams.keys()].join(', ')}]`
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
   * Dedicated implementation of the authenticated Pahadi10 reference download flow.
   * Uses authenticated context (ndus, jsToken, appId=250528, shareId, uk, sign, timestamp).
   */
  async resolveWithPahadi10Flow(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    if (!file) {
      throw new NotFoundError('File unavailable in share metadata');
    }

    const shareCode = shareContext.shareCode || shareContext.surl || '';
    const fileName = file.server_filename || file.filename || `terabox_${shareCode}.file`;
    const fileSize = Number(file.size || 0);

    const activeJsToken = shareContext.jsToken;
    const activeCookies = shareContext.cookies;
    const normalizedNdusVal = normalizeNdus(config.TERABOX_NDUS);

    logger.info(`[TeraBox] Authenticated strategy: pahadi10-reference`);
    logger.info(`[TeraBox] NDUS configured: ${normalizedNdusVal ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox] jsToken: ${activeJsToken ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox] appId: 250528`);
    logger.info(`[TeraBox] fs_id: YES`);
    logger.info(`[TeraBox] sign: ${shareContext.sign ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox] timestamp: ${shareContext.timestamp ? 'YES' : 'NO'}`);

    const downloadEndpoint = `${this.UNOFFICIAL_API_BASE}/share/download?app_id=250528`;

    logger.info(`[TeraBox Auth] NDUS header attached: ${normalizedNdusVal ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] jsToken attached: ${activeJsToken ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] sign attached: ${shareContext.sign ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] timestamp attached: ${shareContext.timestamp ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] fs_id attached: YES`);
    logger.info(`[TeraBox Auth] endpoint: ${new URL(downloadEndpoint).hostname}${new URL(downloadEndpoint).pathname}`);
    logger.info(`[TeraBox Auth] method: POST`);

    const combinedCookies = [
      activeCookies,
      normalizedNdusVal ? `ndus=${normalizedNdusVal}` : '',
    ].filter(Boolean).join('; ');

    const downloadRes = await this.safeFetch(downloadEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
        'Origin': 'https://www.terabox.app',
        ...(combinedCookies ? { Cookie: combinedCookies } : {}),
      },
      data: new URLSearchParams({
        product: 'share',
        nozip: '0',
        fid_list: `[${file.fs_id}]`,
        share_id: String(shareContext.shareId),
        uk: String(shareContext.uk),
        sign: String(shareContext.sign),
        timestamp: String(shareContext.timestamp),
        primaryid: String(shareContext.shareId),
      }).toString(),
    });

    const resKeys = downloadRes && typeof downloadRes === 'object' ? Object.keys(downloadRes) : [];
    logger.info(`[TeraBox] Reference API status: ${downloadRes ? 'SUCCESS' : 'EMPTY'}`);
    logger.info(`[TeraBox] Reference API errno: ${downloadRes?.errno ?? 'NONE'}`);
    logger.info(`[TeraBox] Reference API keys: [${resKeys.join(', ')}]`);

    if (downloadRes && downloadRes.errno !== undefined && Number(downloadRes.errno) !== 0) {
      const safeMsg = typeof downloadRes.errmsg === 'string' ? downloadRes.errmsg : 'parameter error';
      const requestId = downloadRes.request_id ?? downloadRes.request_id_string ?? '';

      if (Number(downloadRes.errno) === 400310 || safeMsg.includes('verify_v2') || safeMsg.includes('need verify')) {
        if (normalizedNdusVal) {
          throw new TeraBoxAuthRejectedError(
            'TeraBox rejected the configured account session (TERABOX_NDUS expired or invalid).',
            'authentication',
            Number(downloadRes.errno),
            String(requestId)
          );
        } else {
          throw new TeraBoxAuthRequiredError(
            'TeraBox authentication is not configured. Required: TERABOX_NDUS',
            'authentication',
            Number(downloadRes.errno),
            String(requestId)
          );
        }
      }

      throw new TeraBoxProviderError(
        `TeraBox download request rejected: errno=${downloadRes.errno}, errmsg=${safeMsg}`,
        'download',
        Number(downloadRes.errno),
        String(requestId)
      );
    }

    const extracted = extractTeraBoxDownloadUrl(downloadRes);
    logger.info(`[TeraBox] Direct link present: ${extracted ? 'YES' : 'NO'}`);

    if (!extracted) {
      throw new TeraBoxLinkResolutionFailedError(
        'TeraBox authentication succeeded but no direct download URL was returned.'
      );
    }

    return {
      fileName,
      size: fileSize,
      downloadUrl: extracted,
      source: 'pahadi10-reference',
    };
  }

  /**
   * Resolve public link metadata & download URL safely
   */
  async resolvePublicLink(url: string): Promise<TeraBoxResolvedFile> {
    return this.resolveSelectedFile(url);
  }

  /**
   * Resolves direct download URL using the reference strategy adapter
   */
  async resolveWithReferenceStrategy(url: string, fsId?: string | number): Promise<TeraBoxDownloadResult> {
    const resolved = await this.resolveSelectedFile(url, fsId);
    return {
      fileName: resolved.fileName,
      size: resolved.fileSize,
      downloadUrl: resolved.downloadUrl,
      source: resolved.isUnofficial ? 'pahadi10-reference' : 'official-api',
    };
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

/**
 * Health check that tests whether TERABOX_NDUS is healthy, rejected, not configured, or provider error.
 */
export async function testTeraBoxAuthentication(
  shareUrl = 'https://1024terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ'
): Promise<'HEALTHY' | 'NOT_CONFIGURED' | 'REJECTED' | 'PROVIDER_ERROR'> {
  const normalizedNdus = normalizeNdus(config.TERABOX_NDUS);
  if (!normalizedNdus) {
    return 'NOT_CONFIGURED';
  }
  try {
    const meta = await teraBoxResolver.getShareMetadata(shareUrl);
    if (!meta.fileList.length) {
      return 'PROVIDER_ERROR';
    }
    const res = await teraBoxResolver.resolveWithPahadi10Flow(meta.fileList[0].fs_id, meta);
    return res.downloadUrl ? 'HEALTHY' : 'PROVIDER_ERROR';
  } catch (err: any) {
    if (err instanceof TeraBoxAuthRequiredError || err.code === 'TERABOX_AUTH_REQUIRED') {
      return 'NOT_CONFIGURED';
    }
    if (err instanceof TeraBoxAuthRejectedError || err.code === 'TERABOX_AUTH_REJECTED') {
      return 'REJECTED';
    }
    return 'PROVIDER_ERROR';
  }
}

