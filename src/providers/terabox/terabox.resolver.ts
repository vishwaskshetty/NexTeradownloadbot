import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
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
  TeraBoxGatewayNotConfiguredError,
  TeraBoxGatewayUnreachableError,
  TeraBoxGatewayAuthFailedError,
  TeraBoxGatewayProviderFailedError,
  TeraBoxGatewayLinkNotFoundError,
  TeraBoxGatewayInvalidResponseError,
  TeraBoxGatewayVerificationSessionError,
  TeraBoxGatewaySessionExpiredError,
  TeraBoxGatewayVerificationFailedError,
} from '../errors';
import { logger } from '../../utils/logger';

// ── Cookie & Session Management ──────────────────────────────────────────────

/**
 * Normalizes raw TERABOX_NDUS value so that `xyz`, `ndus=xyz`, `Cookie: ndus=xyz`,
 * quoted values `"ndus=xyz"`, and formatted headers are cleanly parsed to the raw token.
 */
export function normalizeNdus(rawNdus?: string): string | null {
  if (!rawNdus) return null;
  let trimmed = rawNdus.trim();
  if (!trimmed) return null;

  // Strip wrapping outer quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // If passed as full header "Cookie: ndus=..." or "cookie: ndus=..."
  if (/^cookie:\s*/i.test(trimmed)) {
    trimmed = trimmed.replace(/^cookie:\s*/i, '').trim();
  }

  // If passed as key=value format "ndus=..."
  const ndusMatch = trimmed.match(/(?:^|;\s*|)ndus\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s]+))/i);
  if (ndusMatch) {
    let val = (ndusMatch[1] ?? ndusMatch[2] ?? ndusMatch[3] ?? '').trim();
    val = val.replace(/^["']+|["']+$/g, '').trim();
    return val.length > 0 ? val : null;
  }

  // If bare token
  const bareToken = trimmed.replace(/^["']+|["']+$/g, '').trim();
  if (/^[a-zA-Z0-9_-]{5,}$/.test(bareToken)) {
    return bareToken;
  }

  return null;
}

export function normalizeGatewayUrl(rawUrl?: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    let host = parsed.host;
    if (parsed.hostname.endsWith('.railway.internal') && !parsed.port) {
      host = `${parsed.hostname}:8080`;
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${host}${pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function isInternalHostname(urlStr?: string): boolean {
  if (!urlStr) return true;
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return (
      host.endsWith('.railway.internal') ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1'
    );
  } catch {
    return false;
  }
}

export function buildPublicVerificationUrl(sessionId: string, verificationUrlPathOrUrl?: string): string {
  const envPublic = process.env.TERABOX_GATEWAY_PUBLIC_URL || (config as any).TERABOX_GATEWAY_PUBLIC_URL;
  let publicBase = normalizeGatewayUrl(envPublic);
  if (publicBase && isInternalHostname(publicBase)) {
    publicBase = null;
  }

  if (!publicBase) {
    const envInternal = process.env.TERABOX_GATEWAY_URL || config.TERABOX_GATEWAY_URL;
    const normalizedGw = normalizeGatewayUrl(envInternal);
    if (normalizedGw && !isInternalHostname(normalizedGw)) {
      publicBase = normalizedGw;
    }
  }

  if (!publicBase) {
    publicBase = 'https://terabox-gateway-nex-production.up.railway.app';
  }

  if (verificationUrlPathOrUrl) {
    if (verificationUrlPathOrUrl.startsWith('http://') || verificationUrlPathOrUrl.startsWith('https://')) {
      if (!isInternalHostname(verificationUrlPathOrUrl)) {
        return verificationUrlPathOrUrl;
      }
      try {
        const u = new URL(verificationUrlPathOrUrl);
        return `${publicBase}${u.pathname}${u.search}`;
      } catch {}
    } else if (verificationUrlPathOrUrl.startsWith('/')) {
      return `${publicBase}${verificationUrlPathOrUrl}`;
    }
  }

  return `${publicBase}/verification/${encodeURIComponent(sessionId)}`;
}

export interface TeraBoxVerificationSessionInfo {
  sessionId: string;
  verificationUrl: string;
  shareCode?: string;
  fsId?: string;
}

export interface NdusDiagnostic {
  configured: boolean;
  length: number;
  format: 'raw-token' | 'ndus-cookie' | 'cookie-header' | 'invalid' | 'empty';
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
    format = 'cookie-header';
  } else if (/^ndus=/i.test(trimmed)) {
    format = 'ndus-cookie';
  }
  const normalized = normalizeNdus(trimmed);
  if (!normalized) {
    format = 'invalid';
  }
  return {
    configured: Boolean(normalized && normalized.length > 0),
    length: normalized ? normalized.length : 0,
    format,
  };
}

/**
 * Merges existing cookie header with newly received Set-Cookie headers into a single cookie string.
 */
export function mergeCookies(existingCookies?: string, setCookieHeader?: string[] | string): string {
  const cookieMap = new Map<string, string>();

  if (existingCookies) {
    existingCookies.split(';').forEach(c => {
      const idx = c.indexOf('=');
      if (idx > 0) {
        const k = c.substring(0, idx).trim();
        const v = c.substring(idx + 1).trim();
        if (k && v) cookieMap.set(k, v);
      }
    });
  }

  if (setCookieHeader) {
    const rawList = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    rawList.forEach(c => {
      const firstPart = c.split(';')[0];
      const idx = firstPart.indexOf('=');
      if (idx > 0) {
        const k = firstPart.substring(0, idx).trim();
        const v = firstPart.substring(idx + 1).trim();
        if (k && v) cookieMap.set(k, v);
      }
    });
  }

  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Lightweight cookie jar for preserving session continuity across requests.
 */
export class SessionCookieJar {
  private cookies = new Map<string, string>();

  constructor(initialCookies?: string) {
    if (initialCookies) {
      this.merge(initialCookies);
    }
  }

  set(name: string, value: string): void {
    if (name && value) {
      this.cookies.set(name.trim(), value.trim());
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  getCookieNames(): string[] {
    return Array.from(this.cookies.keys());
  }

  merge(cookieHeader?: string | string[]): void {
    if (!cookieHeader) return;
    const merged = mergeCookies(this.toCookieHeader(), cookieHeader);
    merged.split(';').forEach(c => {
      const idx = c.indexOf('=');
      if (idx > 0) {
        const k = c.substring(0, idx).trim();
        const v = c.substring(idx + 1).trim();
        if (k && v) this.cookies.set(k, v);
      }
    });
  }

  toCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  clone(): SessionCookieJar {
    const jar = new SessionCookieJar();
    for (const [k, v] of this.cookies.entries()) {
      jar.set(k, v);
    }
    return jar;
  }
}

// ── Token & Signature Extraction Helpers ─────────────────────────────────────

/**
 * Extracts dynamic jsToken from TeraBox HTML page.
 */
export function extractJsToken(html: string): string | undefined {
  if (!html) return undefined;
  const match =
    html.match(/fn%28%22([^%"]+)%22%29/i) ||
    html.match(/fn%28%27([^%']+)%27%29/i) ||
    html.match(/fn\("([^"]+)"\)/i) ||
    html.match(/fn\('([^']+)'\)/i) ||
    html.match(/"jsToken"\s*:\s*"([^"]+)"/i) ||
    html.match(/'jsToken'\s*:\s*'([^']+)'/i);
  return match ? match[1] : undefined;
}

/**
 * Extracts dynamic dp-logid / dplogid from TeraBox response headers or HTML page.
 */
export function extractDpLogId(html?: string, headers?: Record<string, any>): string | undefined {
  if (headers) {
    const hdr = headers['dp-logid'] || headers['dplogid'] || headers['x-dp-logid'];
    if (typeof hdr === 'string' && hdr.trim().length > 0) return hdr.trim();
  }
  if (!html) return undefined;
  const match =
    html.match(/["']?dp-logid["']?\s*[:=]\s*["']?([0-9a-zA-Z_-]+)["']?/i) ||
    html.match(/["']?dplogid["']?\s*[:=]\s*["']?([0-9a-zA-Z_-]+)["']?/i) ||
    html.match(/["']?dp_logid["']?\s*[:=]\s*["']?([0-9a-zA-Z_-]+)["']?/i);
  return match ? match[1] : undefined;
}

export interface HomeSigningContext {
  sign1?: string;
  sign3?: string;
  sign?: string;
  timestamp?: number;
  bdstoken?: string;
  csrfToken?: string;
  jsToken?: string;
  dpLogId?: string;
}

/**
 * Robust extractor for sign1, sign3, timestamp, and security tokens from HTML / JS / script state.
 */
export function extractHomeSigningContext(content: string): HomeSigningContext {
  if (!content || typeof content !== 'string') return {};
  const result: HomeSigningContext = {};

  const sign1Match =
    content.match(/["']?sign1["']?\s*[:=]\s*["']([^"']+)["']/i) ||
    content.match(/sign1\s*=\s*["']([^"']+)["']/i);
  if (sign1Match) result.sign1 = sign1Match[1];

  const sign3Match =
    content.match(/["']?sign3["']?\s*[:=]\s*["']([^"']+)["']/i) ||
    content.match(/sign3\s*=\s*["']([^"']+)["']/i);
  if (sign3Match) result.sign3 = sign3Match[1];

  const signMatch =
    content.match(/["']?sign["']?\s*[:=]\s*["']([A-Za-z0-9+/=]{16,})["']/i) ||
    content.match(/sign\s*=\s*["']([^"']+)["']/i);
  if (signMatch) result.sign = signMatch[1];

  const tsMatch =
    content.match(/["']?timestamp["']?\s*[:=]\s*["']?([0-9]{10,13})["']?/i) ||
    content.match(/["']?server_time["']?\s*[:=]\s*["']?([0-9]{10,13})["']?/i);
  if (tsMatch) result.timestamp = Number(tsMatch[1]);

  const bdsMatch = content.match(/["']?bdstoken["']?\s*[:=]\s*["']([0-9a-zA-Z_-]+)["']/i);
  if (bdsMatch) result.bdstoken = bdsMatch[1];

  const csrfMatch =
    content.match(/["']?csrfToken["']?\s*[:=]\s*["']([0-9a-zA-Z_-]+)["']/i) ||
    content.match(/["']?csrf["']?\s*[:=]\s*["']([0-9a-zA-Z_-]+)["']/i);
  if (csrfMatch) result.csrfToken = csrfMatch[1];

  const jsToken = extractJsToken(content);
  if (jsToken) result.jsToken = jsToken;

  const dpLogId = extractDpLogId(content);
  if (dpLogId) result.dpLogId = dpLogId;

  return result;
}

/**
 * Exact SignDownload (RC4 stream cipher) algorithm from TeraBox/Baidu reference package.
 * Generates signb signature from sign3 (key) and sign1 (payload).
 */
export function signDownload(sign3: string, sign1: string): string {
  if (!sign3 || !sign1) return '';
  const p: number[] = new Array(256);
  const a: number[] = new Array(256);
  const s3Len = sign3.length;
  const s1Len = sign1.length;

  for (let i = 0; i < 256; i++) {
    p[i] = i;
    a[i] = sign3.charCodeAt(i % s3Len);
  }

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + p[i] + a[i]) % 256;
    const temp = p[i];
    p[i] = p[j];
    p[j] = temp;
  }

  let i = 0;
  j = 0;
  const res: string[] = [];

  for (let q = 0; q < s1Len; q++) {
    i = (i + 1) % 256;
    j = (j + p[i]) % 256;
    const temp = p[i];
    p[i] = p[j];
    p[j] = temp;
    const k = p[(p[i] + p[j]) % 256];
    res.push(String.fromCharCode(sign1.charCodeAt(q) ^ k));
  }

  return Buffer.from(res.join(''), 'latin1').toString('base64');
}

export const SignDownload = signDownload;

// ── Startup Diagnostics ──────────────────────────────────────────────────────

const isNdusAvailable = Boolean(normalizeNdus(config.TERABOX_NDUS));
if (process.env.NODE_ENV !== 'test') {
  const isProcessEnvNdus = typeof process.env.TERABOX_NDUS === 'string' && process.env.TERABOX_NDUS.trim().length > 0;
  const isConfigNdus = typeof config.TERABOX_NDUS === 'string' && config.TERABOX_NDUS.trim().length > 0;
  const diag = inspectNdusConfiguration(config.TERABOX_NDUS);
  logger.info(`[TeraBox Auth] Resolver version: 2.3.0 (Robust HomeInfo & SignDownload Pipeline)`);
  logger.info(`[TeraBox Auth] Git commit: ${process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'prod'}`);
  logger.info(`[TeraBox Auth] TERABOX_NDUS configured: ${isConfigNdus ? 'YES' : 'NO'}`);
  logger.info(`[TeraBox Auth] Environment variable length: ${diag.length}`);
  logger.info(`[TeraBox Auth] Credential format: ${diag.format.toUpperCase()}`);
  logger.info(`[TeraBox Auth] process.env TERABOX_NDUS: ${isProcessEnvNdus ? 'YES' : 'NO'}`);
  logger.info(`[TeraBox Auth] config.TERABOX_NDUS: ${isConfigNdus ? 'YES' : 'NO'}`);
  logger.info(`[TeraBox Auth] Resolver NDUS: ${isNdusAvailable ? 'YES' : 'NO'}`);
  logger.info(`[TeraBox Auth] Authenticated request enabled: ${isNdusAvailable ? 'YES' : 'NO'}`);
}

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface TeraBoxFileItem {
  fs_id: string | number;
  server_filename?: string;
  filename?: string;
  size?: number | string;
  category?: number;
  dlink?: string;
  download_url?: string;
  downloadUrl?: string;
  direct_link?: string;
  url?: string;
  isdir?: number | boolean;
  children?: TeraBoxFileItem[];
}

export interface TeraBoxHomeInfoData {
  sign1?: string;
  sign3?: string;
  signb?: string;
  sign?: string;
  timestamp?: number;
  [key: string]: any;
}

export interface TeraBoxHomeInfoResponse {
  errno: number;
  errmsg?: string;
  data?: TeraBoxHomeInfoData;
  [key: string]: any;
}

export interface TeraBoxShareMetadata {
  shareId: string;
  shareCode?: string;
  surl: string;
  uk: string;
  timestamp: number | string;
  sign: string;
  jsToken?: string;
  dpLogId?: string;
  cookies?: string;
  cookieJar?: SessionCookieJar;
  fileList: TeraBoxFileItem[];
  rawHtml?: string;
  sourceUrl?: string;
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
  fsId: string;
  downloadUrl: string;
  source: string;
  sourceUrl?: string;
  headers?: Record<string, string>;
  isUnofficial?: boolean;
}

export type StrategyResultStatus =
  | 'SUCCESS'
  | 'AUTH_MISSING'
  | 'AUTH_REJECTED'
  | 'PROVIDER_VERIFICATION_REQUIRED'
  | 'LINK_RESOLUTION_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'NOT_CONFIGURED'
  | 'FAILED';

export interface StrategyExecutionRecord {
  strategyName: string;
  status: StrategyResultStatus;
  errno?: number;
  errmsg?: string;
  message?: string;
}

// ── Whitelist & Candidate Helpers ────────────────────────────────────────────

export const TERABOX_DOMAINS = [
  'terabox.com',
  'www.terabox.com',
  'teraboxapp.com',
  'www.teraboxapp.com',
  '1024terabox.com',
  'www.1024terabox.com',
  '1024tera.com',
  'www.1024tera.com',
  'teraboxlink.com',
  'nephobox.com',
  '4funbox.com',
  'mirrobox.com',
  'terabox.app',
  'www.terabox.app',
  'freeterabox.com',
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
        const pathLower = parsed.pathname.toLowerCase();
        const hostLower = parsed.hostname.toLowerCase();

        // Reject share URLs
        if (pathLower.startsWith('/s/') || pathLower.startsWith('/sharing/link')) {
          return null;
        }
        // Reject verification URLs & challenge paths
        if (
          pathLower.includes('/verify') ||
          pathLower.includes('/verification') ||
          pathLower.includes('verify_v2') ||
          pathLower.includes('/checkcaptcha')
        ) {
          return null;
        }
        // Reject login & passport pages
        if (
          pathLower.includes('/login') ||
          pathLower.includes('/signin') ||
          pathLower.includes('/signup') ||
          hostLower.includes('passport.terabox') ||
          hostLower.includes('passport.baidu')
        ) {
          return null;
        }

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
      'download_link',
      'downloadUrl',
      'direct_link',
      'url',
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

// ── Multi-tier Resolver Engine ───────────────────────────────────────────────

export class TeraBoxResolver {
  private readonly OFFICIAL_API_BASE = 'https://openapi.terabox.com';
  private readonly UNOFFICIAL_API_BASE = 'https://www.terabox.app';
  private readonly REQUEST_TIMEOUT_MS = 15000;
  private readonly MAX_RETRIES = 2;

  /**
   * Safe HTTP fetcher with session cookie preservation & strict safe logging (never leaks secrets).
   */
  async safeFetch(
    url: string,
    options: AxiosRequestConfig = {},
    cookieJar?: SessionCookieJar
  ): Promise<any> {
    let attempt = 0;
    while (attempt <= this.MAX_RETRIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      const requestHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.terabox.app/',
        ...((options.headers as Record<string, string>) || {}),
      };

      // Merge cookies from jar if provided
      if (cookieJar) {
        const jarCookies = cookieJar.toCookieHeader();
        if (jarCookies) {
          requestHeaders['Cookie'] = mergeCookies(requestHeaders['Cookie'], jarCookies);
        }
      }

      // If NDUS configured and Cookie header is empty, attach normalized NDUS
      const normalizedNdus = normalizeNdus(config.TERABOX_NDUS);
      if (normalizedNdus && !requestHeaders['Cookie']) {
        requestHeaders['Cookie'] = `ndus=${normalizedNdus}`;
      }

      // Safe HTTP request logging
      const parsedUrl = new URL(url);
      const queryParamNames = Array.from(parsedUrl.searchParams.keys());
      let bodyParamNames: string[] = [];
      if (options.data) {
        if (typeof options.data === 'string') {
          try {
            const bodyParams = new URLSearchParams(options.data);
            bodyParamNames = Array.from(bodyParams.keys());
          } catch {}
        } else if (typeof options.data === 'object' && !Array.isArray(options.data)) {
          bodyParamNames = Object.keys(options.data);
        }
      }
      const attachedCookieNames = requestHeaders['Cookie']
        ? requestHeaders['Cookie'].split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
        : [];

      try {
        const response: AxiosResponse = await axios({
          ...options,
          url,
          signal: controller.signal,
          timeout: this.REQUEST_TIMEOUT_MS,
          headers: requestHeaders,
          maxRedirects: 5,
        });
        clearTimeout(timer);

        // Update cookie jar with received Set-Cookie headers
        if (cookieJar && response.headers['set-cookie']) {
          cookieJar.merge(response.headers['set-cookie']);
        }

        const resData = response.data;
        const resKeys = resData && typeof resData === 'object' ? Object.keys(resData) : [];
        const resErrno = resData?.errno ?? resData?.data?.errno;
        const resErrmsg = typeof resData?.errmsg === 'string' ? resData.errmsg : (typeof resData?.data?.errmsg === 'string' ? resData.data.errmsg : undefined);

        logger.info(
          `[TeraBox HTTP] method=${options.method || 'GET'} host=${parsedUrl.hostname} path=${parsedUrl.pathname} ` +
          `queryParams=[${queryParamNames.join(', ')}] bodyParams=[${bodyParamNames.join(', ')}] ` +
          `cookies=[${attachedCookieNames.join(', ')}] status=${response.status} ` +
          `contentType="${response.headers['content-type'] || 'unknown'}" keys=[${resKeys.join(', ')}] ` +
          `errno=${resErrno ?? 'NONE'} errmsg="${resErrmsg || ''}"`
        );

        return response.data;
      } catch (err: any) {
        clearTimeout(timer);
        attempt++;

        const isAxiosErr = axios.isAxiosError(err);
        const status = isAxiosErr ? err.response?.status : undefined;
        const resData = isAxiosErr ? err.response?.data : undefined;
        const resErrno = resData?.errno ?? resData?.data?.errno;

        logger.warn(
          `[TeraBox HTTP] Error: method=${options.method || 'GET'} host=${parsedUrl.hostname} path=${parsedUrl.pathname} ` +
          `status=${status ?? 'NETWORK_ERROR'} errno=${resErrno ?? 'NONE'} message="${err.message}"`
        );

        // Do NOT retry deterministic client errors or provider verification errors
        if (
          (status && status >= 400 && status < 500) ||
          resErrno === 400310 ||
          resErrno === 400210 ||
          err instanceof TeraBoxVerificationRequiredError ||
          err instanceof TeraBoxAuthRejectedError ||
          err instanceof TeraBoxAuthRequiredError
        ) {
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
   * Performs HEAD request against candidate dlink using the same session cookies
   * to resolve redirects and retrieve final target direct URL.
   */
  async resolveDlinkRedirect(
    dlink: string,
    cookieJar?: SessionCookieJar
  ): Promise<{ finalUrl: string; redirectStatus: number | string; finalHostname: string }> {
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.1024tera.com/',
        'Accept': '*/*',
      };
      if (cookieJar) {
        const jarCookies = cookieJar.toCookieHeader();
        if (jarCookies) {
          headers['Cookie'] = jarCookies;
        }
      }

      const res = await axios({
        method: 'HEAD',
        url: dlink,
        headers,
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400,
        timeout: 10000,
      });

      const redirectLocation = res.headers['location'];
      if (
        redirectLocation &&
        (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308)
      ) {
        const parsed = new URL(redirectLocation);
        return {
          finalUrl: redirectLocation,
          redirectStatus: res.status,
          finalHostname: parsed.hostname,
        };
      }

      const parsed = new URL(dlink);
      return {
        finalUrl: dlink,
        redirectStatus: res.status,
        finalHostname: parsed.hostname,
      };
    } catch (err: any) {
      if (axios.isAxiosError(err) && err.response) {
        const loc = err.response.headers['location'];
        if (loc) {
          try {
            const parsed = new URL(loc);
            return {
              finalUrl: loc,
              redirectStatus: err.response.status,
              finalHostname: parsed.hostname,
            };
          } catch {}
        }
      }
      try {
        const parsed = new URL(dlink);
        return {
          finalUrl: dlink,
          redirectStatus: 'DIRECT_FALLBACK',
          finalHostname: parsed.hostname,
        };
      } catch {
        return {
          finalUrl: dlink,
          redirectStatus: 'ERROR',
          finalHostname: 'unknown',
        };
      }
    }
  }

  /**
   * Adapts updateAppData() from reference repositories (seiya-npm, Hrishi, Itz-Ashlynn).
   * Requests /main with persistent session cookies, updates cookies, and parses embedded signing context.
   */
  async updateAppData(sessionJar: SessionCookieJar): Promise<{ success: boolean; signingContext?: HomeSigningContext }> {
    try {
      const mainUrl = `${this.UNOFFICIAL_API_BASE}/main`;
      const res = await axios.get(mainUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(sessionJar.toCookieHeader() ? { Cookie: sessionJar.toCookieHeader() } : {}),
        },
        timeout: 10000,
        maxRedirects: 5,
      });

      if (res.headers['set-cookie']) {
        sessionJar.merge(res.headers['set-cookie']);
      }

      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
      const signingContext = extractHomeSigningContext(html);

      return {
        success: Boolean(res.data),
        signingContext,
      };
    } catch {
      return { success: false };
    }
  }

  /**
   * Fetches account home information (/api/home/info) and computes signb = SignDownload(sign3, sign1).
   * Supports both JSON endpoints and HTML embedded signing contexts.
   */
  async getHomeInfo(
    sessionJar: SessionCookieJar,
    fallbackContext?: HomeSigningContext
  ): Promise<TeraBoxHomeInfoResponse> {
    const homeInfoUrl = `${this.UNOFFICIAL_API_BASE}/api/home/info`;
    let res: any;
    let contentType = 'unknown';
    let rawBody = '';
    let headerNames: string[] = [];

    try {
      const axiosRes = await axios({
        method: 'GET',
        url: homeInfoUrl,
        params: {
          app_id: '250528',
          web: '1',
          channel: 'dubox',
          clienttype: '0',
          t: Date.now(),
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.terabox.app/main',
          'Origin': 'https://www.terabox.app',
          ...(sessionJar.toCookieHeader() ? { Cookie: sessionJar.toCookieHeader() } : {}),
        },
        timeout: this.REQUEST_TIMEOUT_MS,
      });

      if (axiosRes.headers['set-cookie']) {
        sessionJar.merge(axiosRes.headers['set-cookie']);
      }

      contentType = String(axiosRes.headers['content-type'] || 'unknown');
      headerNames = Object.keys(axiosRes.headers || {});
      res = axiosRes.data;
      rawBody = typeof res === 'string' ? res : JSON.stringify(res || '');
    } catch (err: any) {
      rawBody = err.message || '';
    }

    const isJson = contentType.toLowerCase().includes('application/json') || (typeof res === 'object' && res !== null && !Array.isArray(res));
    const isHtml = contentType.toLowerCase().includes('text/html') || typeof res === 'string';

    if (isHtml) {
      logger.warn(
        `[TeraBox HomeInfo Mismatch] /api/home/info returned HTML (content-type="${contentType}") instead of JSON API response. Recording API mismatch.`
      );
    }

    let errno = isJson && typeof res?.errno === 'number' ? res.errno : -1;
    let data: TeraBoxHomeInfoData = (res && typeof res === 'object' && res.data) ? { ...res.data } : {};

    // If response was HTML or missing sign fields, extract from HTML body
    const extractedHtmlCtx = extractHomeSigningContext(rawBody);

    let sign1 = data.sign1 || extractedHtmlCtx.sign1 || fallbackContext?.sign1;
    let sign3 = data.sign3 || extractedHtmlCtx.sign3 || fallbackContext?.sign3;
    let timestamp = data.timestamp || extractedHtmlCtx.timestamp || fallbackContext?.timestamp;
    let signb: string | undefined;

    if (sign1 && sign3) {
      signb = signDownload(sign3, sign1);
      data.sign1 = sign1;
      data.sign3 = sign3;
      data.signb = signb;
      data.timestamp = timestamp;
    }

    // Safe 150 characters snippet of body (never contains tokens)
    const safeSnippet = rawBody.slice(0, 150).replace(/ndus=[^;&\s]+/gi, 'ndus=***').replace(/\s+/g, ' ');
    const cookieNames = sessionJar.getCookieNames();

    logger.info(
      `[TeraBox HomeInfo Diagnostics] ` +
      `finalUrl=${homeInfoUrl} ` +
      `httpStatus=${res ? 200 : 'ERROR'} ` +
      `contentType="${contentType}" ` +
      `responseLength=${rawBody.length} ` +
      `bodySnippet="${safeSnippet}" ` +
      `headerNames=[${headerNames.join(', ')}] ` +
      `cookieNames=[${cookieNames.join(', ')}] ` +
      `sign1Present=${Boolean(sign1) ? 'YES' : 'NO'} ` +
      `sign3Present=${Boolean(sign3) ? 'YES' : 'NO'} ` +
      `signbGenerated=${Boolean(signb) ? 'YES' : 'NO'} ` +
      `timestampPresent=${Boolean(timestamp) ? 'YES' : 'NO'} ` +
      `csrfPresent=${sessionJar.has('csrfToken') || Boolean(extractedHtmlCtx.csrfToken) ? 'YES' : 'NO'} ` +
      `bdussPresent=${sessionJar.has('bduss') || sessionJar.has('BDUSS') ? 'YES' : 'NO'} ` +
      `ndusPresent=${sessionJar.has('ndus') ? 'YES' : 'NO'}`
    );

    return {
      errno: isJson && typeof res?.errno === 'number' ? res.errno : (isHtml ? 400210 : errno),
      errmsg: res?.errmsg || (isHtml ? 'API returned HTML page instead of JSON API response' : undefined),
      data,
      isHtmlFallback: isHtml,
    };
  }

  /**
   * Retrieve file metadata array for a TeraBox share (supports both single and multi-file shares).
   * Initialises and preserves session context across all calls.
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
        const parsed = JSON.parse(cached) as TeraBoxShareMetadata;
        parsed.cookieJar = new SessionCookieJar(parsed.cookies);
        return parsed;
      }
    } catch {}

    const sessionJar = new SessionCookieJar();
    const normalizedNdusVal = normalizeNdus(config.TERABOX_NDUS);
    if (normalizedNdusVal) {
      sessionJar.set('ndus', normalizedNdusVal);
    }

    let fileList: TeraBoxFileItem[] = [];
    let shareId: string | undefined;
    let uk: string | undefined;
    let sign: string | undefined;
    let timestamp: number | string | undefined;
    let jsToken: string | undefined;
    let dpLogId: string | undefined;
    let rawHtml: string | undefined;

    logger.info(`[TeraBox] Stage 2: Creating share session`);
    // Scrape share page to extract active jsToken, dp-logid, and session cookies
    try {
      const pageRes = await axios.get(`https://dm.terabox.app/sharing/link?surl=1${shareCode}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(sessionJar.toCookieHeader() ? { Cookie: sessionJar.toCookieHeader() } : {}),
        },
        timeout: 10000,
      });

      rawHtml = String(pageRes.data || '');
      jsToken = extractJsToken(rawHtml);
      dpLogId = extractDpLogId(rawHtml, pageRes.headers);

      if (pageRes.headers['set-cookie']) {
        sessionJar.merge(pageRes.headers['set-cookie']);
      }
      logger.info(`[TeraBox] Stage 3: Extracting jsToken -> ${jsToken ? 'YES' : 'NO'}, dpLogId -> ${dpLogId ? 'YES' : 'NO'}`);
    } catch (e: any) {
      logger.warn(`[TeraBox] Stage 2/3 session creation warning: ${e.message}`);
    }

    // Strategy 1: Configured Gateway Service (if set)
    if (config.TERABOX_GATEWAY_URL) {
      try {
        const normalizedGwUrl = normalizeGatewayUrl(config.TERABOX_GATEWAY_URL);
        if (normalizedGwUrl) {
          const gwParsed = new URL(normalizedGwUrl);
          const cleanPath = gwParsed.pathname.replace(/\/+$/, '');
          const gwEndpoint = `${gwParsed.origin}${cleanPath === '/api' ? '/api' : `${cleanPath}/api`}`;
          const cleanCode = shareCode.startsWith('1') ? shareCode : `1${shareCode}`;
          const shareUrl = `https://1024terabox.com/s/${cleanCode}`;

          const gwRes = await this.safeFetch(gwEndpoint, {
            method: 'GET',
            params: {
              url: shareUrl,
              resolve: '1',
            },
          });
          if (gwRes && gwRes.status === 'success' && Array.isArray(gwRes.files) && gwRes.files.length > 0) {
            fileList = gwRes.files;
          } else if (gwRes && Array.isArray(gwRes.list) && gwRes.list.length > 0) {
            fileList = gwRes.list;
          }
        }
      } catch (e: any) {
        logger.warn(`[TeraBox] Configured gateway metadata resolution failed: ${e.message}`);
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
        const data = await this.safeFetch(
          infoUrl,
          {
            method: 'GET',
            params: {
              app_id: '250528',
              shorturl: `1${shareCode}`,
              root: '1',
              ...(jsToken ? { jsToken } : {}),
            },
            headers: {
              Referer: `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
              Origin: 'https://www.terabox.app',
            },
          },
          sessionJar
        );
        if (data && data.errno === 0 && Array.isArray(data.list)) {
          fileList = data.list;
          shareId = String(data.shareid || data.share_id || '');
          uk = String(data.uk || '');
          sign = data.sign;
          timestamp = data.timestamp;
        }
      } catch {}

      // Fallback refresh once if needed
      if (fileList.length === 0) {
        try {
          const refreshRes = await axios.get(`https://www.terabox.app/sharing/link?surl=${shareCode}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,*/*',
              ...(sessionJar.toCookieHeader() ? { Cookie: sessionJar.toCookieHeader() } : {}),
            },
            timeout: 10000,
          });
          const refreshHtml = String(refreshRes.data || '');
          const refreshedToken = extractJsToken(refreshHtml);
          if (refreshedToken) jsToken = refreshedToken;
          const refreshedDpLogId = extractDpLogId(refreshHtml, refreshRes.headers);
          if (refreshedDpLogId) dpLogId = refreshedDpLogId;

          if (refreshRes.headers['set-cookie']) {
            sessionJar.merge(refreshRes.headers['set-cookie']);
          }

          const retryData = await this.safeFetch(
            infoUrl,
            {
              method: 'GET',
              params: {
                app_id: '250528',
                shorturl: `1${shareCode}`,
                root: '1',
                ...(jsToken ? { jsToken } : {}),
              },
              headers: {
                Referer: `https://www.terabox.app/sharing/link?surl=${shareCode}`,
                Origin: 'https://www.terabox.app',
              },
            },
            sessionJar
          );
          if (retryData && retryData.errno === 0 && Array.isArray(retryData.list)) {
            fileList = retryData.list;
            shareId = String(retryData.shareid || retryData.share_id || '');
            uk = String(retryData.uk || '');
            sign = retryData.sign;
            timestamp = retryData.timestamp;
          }
        } catch {}
      }

      // Fallback share/list for file discovery
      if (fileList.length === 0) {
        const shareListUrl = `${this.UNOFFICIAL_API_BASE}/share/list`;
        try {
          const shareListData = await this.safeFetch(
            shareListUrl,
            {
              method: 'GET',
              params: {
                app_id: '250528',
                shorturl: shareCode,
                root: '1',
                ...(jsToken ? { jsToken } : {}),
              },
              headers: {
                Referer: `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
                Origin: 'https://www.terabox.app',
              },
            },
            sessionJar
          );
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
      dpLogId,
      cookies: sessionJar.toCookieHeader(),
      cookieJar: sessionJar,
      fileList,
      rawHtml,
    };

    logger.info(
      `[TeraBox] Stage 5: Validating share context: ` +
        JSON.stringify({
          shareId: metadata.shareId ? 'YES' : 'NO',
          uk: metadata.uk ? 'YES' : 'NO',
          sign: metadata.sign ? 'YES' : 'NO',
          timestamp: metadata.timestamp ? 'YES' : 'NO',
          jsToken: metadata.jsToken ? 'YES' : 'NO',
          dpLogId: metadata.dpLogId ? 'YES' : 'NO',
          cookies: metadata.cookies ? 'YES' : 'NO',
        })
    );

    try {
      // TTL = 300s
      await redis.setex(cacheKey, 300, JSON.stringify({
        ...metadata,
        cookieJar: undefined, // don't serialize class instance
      }));
    } catch {}

    return metadata;
  }

  // ── Strategy Adapters ──────────────────────────────────────────────────────

  /**
   * Strategy 1: Authenticated Reference Package Download Flow (seiya-npm/terabox-api)
   * Flow: updateAppData -> getHomeInfo -> signb = SignDownload(sign3, sign1) -> POST /api/download -> dlink
   */
  async resolveWithAuthenticatedDownloadFlow(
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

    const sessionJar = shareContext.cookieJar || new SessionCookieJar(shareContext.cookies);
    let normalizedNdusVal: string | null = null;
    if (sessionJar.has('ndus')) {
      normalizedNdusVal = sessionJar.get('ndus') || null;
    } else if (config.TERABOX_NDUS) {
      normalizedNdusVal = normalizeNdus(config.TERABOX_NDUS);
      if (normalizedNdusVal) {
        sessionJar.set('ndus', normalizedNdusVal);
      }
    }

    const isNdusConfigured = Boolean(normalizedNdusVal && normalizedNdusVal.length > 0);
    if (!isNdusConfigured) {
      throw new TeraBoxAuthRequiredError(
        'TeraBox authentication is not configured. Required: TERABOX_NDUS',
        'authentication',
        400310
      );
    }

    // Step 1: updateAppData
    const updateRes = await this.updateAppData(sessionJar);

    logger.info(
      `[TeraBox Auth Flow] ` +
      `ndusConfigured=YES ` +
      `sessionCreated=YES ` +
      `updateAppData=${updateRes.success ? 'SUCCESS' : 'FAILED'} ` +
      `jsTokenPresent=${Boolean(shareContext.jsToken) ? 'YES' : 'NO'}`
    );

    // Step 2: getHomeInfo & SignDownload
    const homeInfo = await this.getHomeInfo(sessionJar, updateRes.signingContext);
    const signb = homeInfo.data?.signb;
    const timestamp = homeInfo.data?.timestamp || Math.floor(Date.now() / 1000);

    if (!signb) {
      if (homeInfo.errno === 400310 || String(homeInfo.errmsg).includes('verify_v2')) {
        throw new TeraBoxAuthRejectedError(
          'TeraBox rejected the configured account session in /api/home/info (TERABOX_NDUS expired or invalid).',
          'home_info',
          homeInfo.errno
        );
      }
      throw new TeraBoxLinkResolutionFailedError(
        `Failed to retrieve valid home signing context (errno=${homeInfo.errno})`
      );
    }

    // Step 3: POST /api/download
    const downloadEndpoint = `${this.UNOFFICIAL_API_BASE}/api/download`;
    const fidlistParam = JSON.stringify([String(file.fs_id)]);

    logger.info(
      `[TeraBox Authenticated Download Request] ` +
      `finalUrl=${downloadEndpoint} ` +
      `httpMethod=POST ` +
      `queryParams=[app_id, web, channel, clienttype] ` +
      `bodyParams=[fidlist, type, vip, sign, timestamp, need_speed] ` +
      `contentType="application/x-www-form-urlencoded" ` +
      `cookieNames=[${sessionJar.getCookieNames().join(', ')}] ` +
      `refererHost="www.terabox.app" ` +
      `originHost="https://www.terabox.app"`
    );

    const postData = new URLSearchParams({
      fidlist: fidlistParam,
      type: 'dlink',
      vip: '2',
      sign: signb,
      timestamp: String(timestamp),
      need_speed: '1',
      ...(shareContext.jsToken ? { jsToken: shareContext.jsToken } : {}),
      ...(shareContext.dpLogId ? { 'dp-logid': shareContext.dpLogId } : {}),
    }).toString();

    let downloadRes: any;
    try {
      downloadRes = await this.safeFetch(
        downloadEndpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.terabox.app/main',
            'Origin': 'https://www.terabox.app',
          },
          data: postData,
        },
        sessionJar
      );
    } catch (postErr: any) {
      if (postErr.response?.data) {
        downloadRes = postErr.response.data;
      } else {
        throw postErr;
      }
    }

    const resErrno = downloadRes?.errno;
    const resKeys = downloadRes && typeof downloadRes === 'object' ? Object.keys(downloadRes) : [];
    const safeMsg = typeof downloadRes?.errmsg === 'string' ? downloadRes.errmsg : 'parameter error';

    logger.info(
      `[TeraBox Authenticated Download Response] ` +
      `endpoint=/api/download ` +
      `httpStatus=${downloadRes ? 200 : 'ERROR'} ` +
      `providerErrno=${resErrno ?? 'NONE'} ` +
      `providerMessage="${safeMsg}" ` +
      `responseKeys=[${resKeys.join(', ')}]`
    );

    if (downloadRes && resErrno !== undefined && Number(resErrno) !== 0) {
      if (Number(resErrno) === 400310 || safeMsg.includes('verify_v2') || safeMsg.includes('need verify')) {
        throw new TeraBoxAuthRejectedError(
          'TeraBox rejected authenticated /api/download request (TERABOX_NDUS expired or invalid).',
          'api_download',
          Number(resErrno)
        );
      }
      throw new TeraBoxProviderError(
        `TeraBox authenticated /api/download rejected: errno=${resErrno}, errmsg=${safeMsg}`,
        'api_download',
        Number(resErrno)
      );
    }

    const rawDlink = extractTeraBoxDownloadUrl(downloadRes);
    let finalDownloadUrl: string | null = null;
    let finalHostname = 'none';

    if (rawDlink) {
      const redirectRes = await this.resolveDlinkRedirect(rawDlink, sessionJar);
      finalDownloadUrl = redirectRes.finalUrl;
      finalHostname = redirectRes.finalHostname;
    }

    logger.info(
      `[TeraBox URL] ` +
      `dlinkPresent=${Boolean(rawDlink) ? 'YES' : 'NO'} ` +
      `dlinkValid=${Boolean(finalDownloadUrl) ? 'YES' : 'NO'} ` +
      `hostname=${finalHostname}`
    );

    if (!finalDownloadUrl) {
      throw new TeraBoxLinkResolutionFailedError(
        'TeraBox /api/download succeeded but no direct download URL was extracted.'
      );
    }

    return {
      fileName,
      size: fileSize,
      downloadUrl: finalDownloadUrl,
      source: 'seiya-authenticated-download',
    };
  }

  /**
   * Strategy 2: Uploaded Terabox-API Reference Flow (/share/list -> file.dlink -> redirect resolution)
   */
  async resolveWithTeraboxApiReference(
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
    const activeDpLogId = shareContext.dpLogId;
    const sessionJar = shareContext.cookieJar || new SessionCookieJar(shareContext.cookies);
    const normalizedNdusVal = normalizeNdus(config.TERABOX_NDUS);
    if (normalizedNdusVal) {
      sessionJar.set('ndus', normalizedNdusVal);
    }

    const shareListUrl = 'https://www.1024tera.com/share/list';
    const siteReferer = `https://1024terabox.com/s/1${shareCode}`;

    const queryParams: Record<string, string> = {
      app_id: '250528',
      web: '1',
      channel: 'dubox',
      clienttype: '0',
      page: '1',
      num: '20',
      order: 'time',
      desc: '1',
      site_referer: siteReferer,
      shorturl: shareCode,
      root: '1',
    };
    if (activeJsToken) {
      queryParams['jsToken'] = activeJsToken;
    }
    if (activeDpLogId) {
      queryParams['dplogid'] = activeDpLogId;
    }

    let listRes: any;
    try {
      listRes = await this.safeFetch(
        shareListUrl,
        {
          method: 'GET',
          params: queryParams,
          headers: {
            Referer: siteReferer,
            Origin: 'https://www.1024tera.com',
          },
        },
        sessionJar
      );
    } catch {
      listRes = await this.safeFetch(
        `${this.UNOFFICIAL_API_BASE}/share/list`,
        {
          method: 'GET',
          params: queryParams,
          headers: {
            Referer: siteReferer,
            Origin: 'https://www.terabox.app',
          },
        },
        sessionJar
      );
    }

    const resErrno = listRes?.errno;
    const resList = listRes?.list || listRes?.data?.list || [];
    const targetFile = Array.isArray(resList)
      ? (resList.find((f: any) => String(f.fs_id) === String(fsId)) || resList[0])
      : undefined;

    const rawDlink = targetFile ? (targetFile.dlink || targetFile.download_url || targetFile.downloadUrl) : undefined;
    const validatedDlink = extractTeraBoxDownloadUrl(rawDlink);

    let redirectStatus: number | string = 'NONE';
    let finalHostname = 'none';
    let finalDownloadUrl: string | null = null;

    if (validatedDlink) {
      const redirectRes = await this.resolveDlinkRedirect(validatedDlink, sessionJar);
      finalDownloadUrl = redirectRes.finalUrl;
      redirectStatus = redirectRes.redirectStatus;
      finalHostname = redirectRes.finalHostname;
    }

    logger.info(
      `[TeraBox Reference API] ` +
      `strategy=terabox-api-reference ` +
      `sessionCreated=${sessionJar ? 'YES' : 'NO'} ` +
      `jsToken=${activeJsToken ? 'YES' : 'NO'} ` +
      `dpLogId=${activeDpLogId ? 'YES' : 'NO'} ` +
      `ndusConfigured=${Boolean(config.TERABOX_NDUS) ? 'YES' : 'NO'} ` +
      `shareListStatus=${listRes ? 'SUCCESS' : 'FAILED'} ` +
      `shareListErrno=${resErrno ?? 'NONE'} ` +
      `fileCount=${Array.isArray(resList) ? resList.length : 0} ` +
      `dlinkPresent=${Boolean(rawDlink) ? 'YES' : 'NO'} ` +
      `dlinkValid=${Boolean(validatedDlink) ? 'YES' : 'NO'} ` +
      `redirectStatus=${redirectStatus} ` +
      `finalHostname=${finalHostname}`
    );

    if (resErrno !== undefined && resErrno !== 0) {
      const safeMsg = typeof listRes?.errmsg === 'string' ? listRes.errmsg : 'share/list error';
      if (resErrno === 400310 || safeMsg.includes('verify_v2') || safeMsg.includes('need verify')) {
        throw new TeraBoxVerificationRequiredError(
          `Terabox-API reference flow required verification (errno=${resErrno})`,
          'share_list',
          resErrno
        );
      }
      throw new TeraBoxProviderError(
        `Terabox-API reference share/list returned errno=${resErrno}`,
        'share_list',
        resErrno
      );
    }

    if (!finalDownloadUrl) {
      throw new TeraBoxLinkResolutionFailedError('Terabox-API reference flow returned no valid dlink in share/list');
    }

    return {
      fileName,
      size: fileSize,
      downloadUrl: finalDownloadUrl,
      source: 'terabox-api-reference',
    };
  }

  /**
   * Strategy 3: Pahadi10 Authenticated Reference Download Flow
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
    const sessionJar = shareContext.cookieJar || new SessionCookieJar(shareContext.cookies);
    let normalizedNdusVal: string | null = null;
    if (sessionJar.has('ndus')) {
      normalizedNdusVal = sessionJar.get('ndus') || null;
    } else if (shareContext.cookies && shareContext.cookies.includes('ndus=')) {
      normalizedNdusVal = normalizeNdus(shareContext.cookies);
    } else if (!shareContext.cookies && !shareContext.cookieJar && config.TERABOX_NDUS) {
      normalizedNdusVal = normalizeNdus(config.TERABOX_NDUS);
      if (normalizedNdusVal) {
        sessionJar.set('ndus', normalizedNdusVal);
      }
    }

    const isNdusConfigured = Boolean(config.TERABOX_NDUS && config.TERABOX_NDUS.trim().length > 0);
    const isNdusNormalized = Boolean(normalizedNdusVal && normalizedNdusVal.length > 0);
    const isCookieContainsNdus = sessionJar.has('ndus');
    const sessionCookieNames = sessionJar.getCookieNames();

    logger.info(`[TeraBox Auth] ndusConfigured: ${isNdusConfigured ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] ndusNormalized: ${isNdusNormalized ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] ndusAttached: ${isCookieContainsNdus ? 'YES' : 'NO'}`);
    logger.info(`[TeraBox Auth] sessionCookieNames: [${sessionCookieNames.join(', ')}]`);
    logger.info(`[TeraBox Auth] sameHttpSession: YES`);
    logger.info(`[TeraBox Auth] sameCookieJar: YES`);

    const downloadEndpoint = `${this.UNOFFICIAL_API_BASE}/share/download?app_id=250528`;

    validateDownloadContext({
      shareId: shareContext.shareId,
      uk: shareContext.uk,
      sign: shareContext.sign,
      timestamp: shareContext.timestamp,
      fsId: file.fs_id,
    });

    const downloadRes = await this.safeFetch(
      downloadEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `https://dm.terabox.app/sharing/link?surl=1${shareCode}`,
          'Origin': 'https://www.terabox.app',
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
          ...(activeJsToken ? { jsToken: activeJsToken } : {}),
        }).toString(),
      },
      sessionJar
    );

    const resErrno = downloadRes?.errno;
    const safeMsg = typeof downloadRes?.errmsg === 'string' ? downloadRes.errmsg : 'parameter error';
    const requestId = downloadRes?.request_id ?? downloadRes?.request_id_string ?? '';

    if (downloadRes && resErrno !== undefined && Number(resErrno) !== 0) {
      logger.warn(`[TeraBox Auth] Reference API returned error: errno=${resErrno}, errmsg="${safeMsg}", request_id=${requestId}`);

      if (Number(resErrno) === 400310 || safeMsg.includes('verify_v2') || safeMsg.includes('need verify')) {
        if (normalizedNdusVal) {
          throw new TeraBoxAuthRejectedError(
            'TeraBox rejected the configured account session (TERABOX_NDUS expired or invalid).',
            'authentication',
            Number(resErrno),
            String(requestId)
          );
        } else {
          throw new TeraBoxAuthRequiredError(
            'TeraBox authentication is not configured. Required: TERABOX_NDUS',
            'authentication',
            Number(resErrno),
            String(requestId)
          );
        }
      }

      throw new TeraBoxProviderError(
        `TeraBox download request rejected: errno=${resErrno}, errmsg=${safeMsg}`,
        'download',
        Number(resErrno),
        String(requestId)
      );
    }

    const extracted = extractTeraBoxDownloadUrl(downloadRes);
    if (!extracted) {
      throw new TeraBoxLinkResolutionFailedError(
        'TeraBox authentication succeeded but no direct download URL was returned.',
        'extraction',
        resErrno,
        String(requestId)
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
   * Strategy 4: Hrishi2861 Reference Flow
   */
  async resolveWithHrishiFlow(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);
    const sessionJar = shareContext.cookieJar || new SessionCookieJar(shareContext.cookies);

    const directDlink = extractTeraBoxDownloadUrl(file);
    if (directDlink) {
      return { fileName, size: fileSize, downloadUrl: directDlink, source: 'hrishi-reference' };
    }

    const shareCode = shareContext.shareCode || shareContext.surl || '';
    const infoRes = await this.safeFetch(
      `${this.UNOFFICIAL_API_BASE}/api/shorturlinfo?app_id=250528&shorturl=1${shareCode}&root=1`,
      {
        method: 'GET',
        headers: {
          Referer: `https://www.terabox.app/sharing/link?surl=${shareCode}`,
          Origin: 'https://www.terabox.app',
        },
      },
      sessionJar
    );

    const extracted = extractTeraBoxDownloadUrl(infoRes);
    if (extracted) {
      return { fileName, size: fileSize, downloadUrl: extracted, source: 'hrishi-reference' };
    }

    const errno = infoRes?.errno;
    const errmsg = infoRes?.errmsg || '';
    if (errno === 400310 || String(errmsg).includes('verify_v2')) {
      throw new TeraBoxVerificationRequiredError('Hrishi flow requires verification', 'hrishi', errno);
    }

    throw new TeraBoxLinkResolutionFailedError('Hrishi reference flow failed to extract direct URL');
  }

  /**
   * Strategy 5: Itz-Ashlynn Reference Flow
   */
  async resolveWithItzFlow(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);

    const candidateKeys = [
      (file as any).dlink,
      (file as any).download_url,
      (file as any).downloadUrl,
      (file as any).direct_link,
      (file as any).url,
    ];
    for (const cand of candidateKeys) {
      const extracted = extractTeraBoxDownloadUrl(cand);
      if (extracted) {
        return { fileName, size: fileSize, downloadUrl: extracted, source: 'itz-reference' };
      }
    }

    throw new TeraBoxLinkResolutionFailedError('Itz-Ashlynn flow did not find embedded direct URL');
  }

  /**
   * Polls the gateway verification session until completed, failed, or expired.
   */
  async pollGatewayVerificationSession(
    sessionId: string,
    timeoutMs = 600000, // 10 minutes
    pollIntervalMs = 2500,
    onStatusUpdate?: (status: string) => Promise<void>
  ): Promise<{ status: string; data?: any }> {
    const normalizedGwUrl = normalizeGatewayUrl(config.TERABOX_GATEWAY_URL);
    if (!normalizedGwUrl) {
      throw new TeraBoxGatewayNotConfiguredError();
    }

    const startTime = Date.now();
    logger.info(`[TeraBox Verification] session_created`);
    logger.info(`[TeraBox Verification] waiting_for_user`);

    while (Date.now() - startTime < timeoutMs) {
      logger.info(`[TeraBox Verification] polling_status`);

      try {
        const resp = await axios.get(
          `${normalizedGwUrl}/api/verification/session/${encodeURIComponent(sessionId)}`,
          {
            timeout: 10000,
            headers: {
              Accept: 'application/json',
              'User-Agent': 'NexTeraDownloadBot/2.3.0',
            },
            validateStatus: () => true,
          }
        );

        const httpStatus = resp.status;
        const data = resp.data || {};
        const sessionStatus = data.status || (httpStatus === 200 ? 'verification_completed' : undefined);

        if (onStatusUpdate && sessionStatus) {
          try {
            await onStatusUpdate(sessionStatus);
          } catch {}
        }

        if (httpStatus === 410 || sessionStatus === 'verification_expired') {
          logger.error(`[TeraBox Verification] session_expired`);
          throw new TeraBoxGatewaySessionExpiredError();
        }

        if (sessionStatus === 'verification_failed') {
          logger.error(`[TeraBox Verification] session_failed`);
          throw new TeraBoxGatewayVerificationFailedError(data.message || data.error || 'Verification failed on gateway.');
        }

        if (
          httpStatus === 200 &&
          (sessionStatus === 'verification_completed' ||
            data.download_link ||
            data.direct_link ||
            data.dlink ||
            data.files)
        ) {
          logger.info(`[TeraBox Verification] completed`);
          return { status: 'verification_completed', data };
        }

        if (
          httpStatus === 409 ||
          sessionStatus === 'verification_pending' ||
          sessionStatus === 'verification_in_progress'
        ) {
          // Still in pending verification state — wait for user
        }
      } catch (err: any) {
        if (
          err instanceof TeraBoxGatewaySessionExpiredError ||
          err instanceof TeraBoxGatewayVerificationFailedError
        ) {
          throw err;
        }
        logger.warn(`[TeraBox Verification] polling transient error: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    logger.error(`[TeraBox Verification] session timed out after ${timeoutMs}ms`);
    throw new TeraBoxGatewaySessionExpiredError('Verification session timed out after 10 minutes.');
  }

  /**
   * Completes verification and obtains the final download result from the gateway.
   */
  async completeGatewayVerification(sessionId: string): Promise<any> {
    const normalizedGwUrl = normalizeGatewayUrl(config.TERABOX_GATEWAY_URL);
    if (!normalizedGwUrl) {
      throw new TeraBoxGatewayNotConfiguredError();
    }

    logger.info(`[TeraBox Verification] completing_session`);
    const resp = await axios.post(
      `${normalizedGwUrl}/api/verification/complete`,
      { session_id: sessionId },
      {
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'NexTeraDownloadBot/2.3.0',
        },
        validateStatus: () => true,
      }
    );

    if (resp.status === 410) {
      logger.error(`[TeraBox Verification] session_expired on complete`);
      throw new TeraBoxGatewaySessionExpiredError();
    }

    if (resp.status === 409) {
      logger.warn(`[TeraBox Verification] completion still requires verification (HTTP 409)`);
      throw new TeraBoxGatewayVerificationSessionError(sessionId, '', 'Verification still pending.');
    }

    if (resp.status >= 400) {
      throw new TeraBoxGatewayProviderFailedError(`Verification completion returned HTTP ${resp.status}`);
    }

    return resp.data;
  }

  /**
   * Primary Gateway Strategy: saahiyo/terabox-gateway integration
   */
  async resolveViaTeraBoxGateway(
    shareCode: string,
    fsId: string | number,
    shareMetadata?: TeraBoxShareMetadata,
    options?: { onVerificationRequired?: (info: TeraBoxVerificationSessionInfo) => Promise<void> }
  ): Promise<TeraBoxDownloadResult | null> {
    const normalizedGwUrl = normalizeGatewayUrl(config.TERABOX_GATEWAY_URL);
    if (!normalizedGwUrl) {
      logger.info(
        `[TeraBox Gateway] gatewayConfigured=NO gatewayHost=none gatewayEndpoint=none gatewayStatus=NONE gatewaySuccess=NO`
      );
      throw new TeraBoxGatewayNotConfiguredError();
    }

    const gwParsed = new URL(normalizedGwUrl);
    const gatewayHost = gwParsed.hostname;
    const cleanPath = gwParsed.pathname.replace(/\/+$/, '');
    const endpoint = `${gwParsed.origin}${cleanPath === '/api' ? '/api' : `${cleanPath}/api`}`;

    const file = shareMetadata?.fileList?.find(f => String(f.fs_id) === String(fsId)) || shareMetadata?.fileList?.[0];
    const fileName = file?.server_filename || file?.filename || 'terabox.file';
    const fileSize = Number(file?.size || 0);
    const targetFsId = String(fsId || file?.fs_id || '');

    let shareUrl = shareMetadata?.sourceUrl;
    if (!shareUrl) {
      if (shareCode.startsWith('http://') || shareCode.startsWith('https://')) {
        shareUrl = shareCode;
      } else {
        const cleanCode = shareCode.startsWith('1') ? shareCode : `1${shareCode}`;
        shareUrl = `https://1024terabox.com/s/${cleanCode}`;
      }
    }

    const params: Record<string, string> = {
      url: shareUrl,
      resolve: '1',
    };

    let gwRes: any;
    let httpStatus = 200;
    let responseContentType = 'application/json';

    try {
      logger.info(
        `[TeraBox Gateway] gatewayConfigured=YES gatewayHost=${gatewayHost} gatewayEndpoint=${endpoint} requestStarted=YES`
      );

      const timeoutMs = config.TERABOX_GATEWAY_TIMEOUT_MS || 15000;
      const resp = await axios.get(endpoint, {
        params,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'NexTeraDownloadBot/2.3.0',
        },
        validateStatus: () => true, // inspect all status codes
      });

      httpStatus = resp.status;
      responseContentType = String(resp.headers['content-type'] || 'unknown');
      gwRes = resp.data;

      const sessionId = gwRes?.session_id || resp.data?.session_id;
      let verificationUrl = gwRes?.verification_url || resp.data?.verification_url;

      const isVerification =
        httpStatus === 409 ||
        gwRes?.error === 'provider_verification_required' ||
        gwRes?.status === 'verification_required' ||
        gwRes?.requires_verification === true ||
        gwRes?.errno === 400210 ||
        gwRes?.errno === 400310 ||
        String(gwRes?.message || gwRes?.errmsg || '').includes('verify_v2');

      if (isVerification) {
        if (sessionId) {
          const publicUrl = buildPublicVerificationUrl(sessionId, verificationUrl);
          logger.info(`[TeraBox Resolver] PROVIDER_VERIFICATION_REQUIRED sessionId=${String(sessionId).substring(0, 8)}***`);
          throw new TeraBoxGatewayVerificationSessionError(
            sessionId,
            publicUrl,
            `TeraBox requires manual browser verification. session_id=${sessionId}`,
            'verification',
            gwRes?.errno || 400210
          );
        }
        throw new TeraBoxGatewayAuthFailedError(`Gateway provider requires verification (no session_id)`, 'gateway', gwRes?.errno || 400210);
      }

      if (httpStatus >= 500) {
        throw new TeraBoxGatewayUnreachableError(`Gateway server error HTTP ${httpStatus}`);
      }
      if (httpStatus === 401 || httpStatus === 403) {
        throw new TeraBoxGatewayAuthFailedError(`Gateway returned unauthorized HTTP ${httpStatus}`);
      }
      if (httpStatus >= 400) {
        throw new TeraBoxGatewayProviderFailedError(
          `Gateway returned HTTP ${httpStatus}: ${gwRes?.message || gwRes?.error || ''}`
        );
      }
    } catch (err: any) {
      if (
        err instanceof TeraBoxGatewayVerificationSessionError ||
        err instanceof TeraBoxGatewaySessionExpiredError ||
        err instanceof TeraBoxGatewayVerificationFailedError ||
        err instanceof TeraBoxGatewayAuthFailedError ||
        err instanceof TeraBoxGatewayUnreachableError ||
        err instanceof TeraBoxGatewayProviderFailedError
      ) {
        throw err;
      }
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
        throw new TeraBoxGatewayUnreachableError(`Gateway connection failed: ${err.message}`);
      }
      throw new TeraBoxGatewayUnreachableError(`Gateway request failed: ${err.message}`);
    }

    const responseKeys = gwRes && typeof gwRes === 'object' ? Object.keys(gwRes) : [];
    const errno = gwRes?.errno ?? gwRes?.code;
    const errorMessage = gwRes?.error || gwRes?.message || gwRes?.errmsg || '';
    const filesList = Array.isArray(gwRes?.files) ? gwRes.files : Array.isArray(gwRes?.list) ? gwRes.list : [];
    const fileCount = filesList.length > 0 ? filesList.length : gwRes?.file_name || gwRes?.filename ? 1 : 0;

    const matchingFile =
      filesList.length > 0
        ? (targetFsId ? filesList.find((f: any) => String(f.fs_id) === String(targetFsId)) : null) || filesList[0]
        : gwRes;

    const dlinkPresent = Boolean(matchingFile?.dlink || gwRes?.dlink || filesList[0]?.dlink);
    const downloadLinkPresent = Boolean(
      matchingFile?.download_link || gwRes?.download_link || filesList[0]?.download_link
    );
    const directLinkPresent = Boolean(
      matchingFile?.direct_link || gwRes?.direct_link || filesList[0]?.direct_link
    );
    const proxyUrlPresent = Boolean(matchingFile?.proxy_url || gwRes?.proxy_url || filesList[0]?.proxy_url);

    const rawCandidate =
      matchingFile?.direct_link ||
      matchingFile?.download_link ||
      matchingFile?.dlink ||
      matchingFile?.url ||
      gwRes?.direct_link ||
      gwRes?.download_link ||
      gwRes?.dlink ||
      extractTeraBoxDownloadUrl(matchingFile) ||
      extractTeraBoxDownloadUrl(gwRes);

    const extractedCandidate = extractTeraBoxDownloadUrl(rawCandidate);
    const urlValid = Boolean(extractedCandidate);

    let redirectStatus = 'NONE';
    let finalHostname = 'none';
    let finalDownloadUrl = extractedCandidate;

    if (extractedCandidate) {
      try {
        const redirectRes = await this.resolveDlinkRedirect(extractedCandidate);
        finalDownloadUrl = redirectRes.finalUrl;
        redirectStatus = String(redirectRes.redirectStatus);
        finalHostname = redirectRes.finalHostname;
      } catch {
        try {
          const parsed = new URL(extractedCandidate);
          finalHostname = parsed.hostname;
        } catch {}
      }
    }

    const gatewaySuccess = httpStatus === 200 && Boolean(finalDownloadUrl) && (!errno || errno === 0);

    logger.info(
      `[TeraBox Gateway] gatewayConfigured=YES gatewayHost=${gatewayHost} gatewayEndpoint=${endpoint} gatewayStatus=${httpStatus} gatewaySuccess=${
        gatewaySuccess ? 'YES' : 'NO'
      } responseContentType="${responseContentType}" responseKeys=[${responseKeys.join(
        ', '
      )}] errno=${errno ?? 'NONE'} errorMessage="${errorMessage ? String(errorMessage).slice(0, 50) : ''}" fileCount=${fileCount} dlinkPresent=${
        dlinkPresent ? 'YES' : 'NO'
      } downloadLinkPresent=${downloadLinkPresent ? 'YES' : 'NO'} directLinkPresent=${
        directLinkPresent ? 'YES' : 'NO'
      } proxyUrlPresent=${proxyUrlPresent ? 'YES' : 'NO'} urlValid=${
        urlValid ? 'YES' : 'NO'
      } redirectStatus=${redirectStatus} finalHostname=${finalHostname}`
    );

    if (gwRes?.status === 'error' || (errno !== undefined && errno !== 0 && errno !== 200)) {
      if (
        errno === 400310 ||
        errno === 400141 ||
        errno === 4000020 ||
        String(errorMessage).includes('verify') ||
        gwRes?.requires_password
      ) {
        throw new TeraBoxGatewayAuthFailedError(`Gateway provider requires verification`, 'gateway', Number(errno));
      }
      throw new TeraBoxGatewayProviderFailedError(
        `Gateway provider error: ${errorMessage || errno}`,
        'gateway',
        Number(errno)
      );
    }

    if (!finalDownloadUrl) {
      throw new TeraBoxGatewayLinkNotFoundError();
    }

    const resolvedFileName =
      matchingFile?.filename ||
      matchingFile?.server_filename ||
      gwRes?.file_name ||
      gwRes?.filename ||
      gwRes?.title ||
      fileName;
    const resolvedSize =
      Number(matchingFile?.size_bytes || matchingFile?.size || gwRes?.file_size || gwRes?.size || fileSize) ||
      fileSize;

    return {
      fileName: resolvedFileName,
      size: resolvedSize > 0 ? resolvedSize : undefined,
      downloadUrl: finalDownloadUrl,
      source: 'terabox-gateway',
    };
  }

  async resolveWithGateway(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata,
    options?: { onVerificationRequired?: (info: TeraBoxVerificationSessionInfo) => Promise<void> }
  ): Promise<TeraBoxDownloadResult> {
    const shareCode = shareContext.shareCode || shareContext.surl || '';
    const res = await this.resolveViaTeraBoxGateway(shareCode, String(fsId), shareContext, options);
    if (!res) {
      throw new TeraBoxGatewayLinkNotFoundError();
    }
    return res;
  }

  /**
   * Strategy 2: Official Open Platform API
   */
  async resolveWithOfficialApi(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    if (!hasTeraBoxCredentials()) {
      throw new ProviderAccessError('official-api', 'Official credentials not configured');
    }

    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);
    const shareCode = shareContext.shareCode || shareContext.surl || '';

    const dlink = await this.getOfficialDownloadUrl(config.TERABOX_ACCESS_TOKEN!, String(file.fs_id), shareCode);
    return {
      fileName,
      size: fileSize,
      downloadUrl: dlink,
      source: 'official-api',
    };
  }

  /**
   * Strategy 3: Seiya-NPM Public Share List Flow
   */
  async resolveWithSeiyaFlow(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);
    const sessionJar = shareContext.cookieJar || new SessionCookieJar(shareContext.cookies);
    const shareCode = shareContext.shareCode || shareContext.surl || '';

    const listRes = await this.safeFetch(
      `${this.UNOFFICIAL_API_BASE}/share/list?app_id=250528&shorturl=${shareCode}&root=1`,
      {
        method: 'GET',
        headers: {
          Referer: `https://www.terabox.app/sharing/link?surl=${shareCode}`,
          Origin: 'https://www.terabox.app',
        },
      },
      sessionJar
    );

    const extracted = extractTeraBoxDownloadUrl(listRes);
    if (extracted) {
      return { fileName, size: fileSize, downloadUrl: extracted, source: 'seiya-reference' };
    }

    const errno = listRes?.errno;
    const errmsg = listRes?.errmsg || '';
    if (errno === 400310 || String(errmsg).includes('verify_v2')) {
      throw new TeraBoxVerificationRequiredError('Seiya flow requires verification', 'seiya', errno);
    }

    throw new TeraBoxLinkResolutionFailedError('Seiya reference flow returned no download URL');
  }

  /**
   * Strategy 4: SudoR2spr Compatible Resolution Flow
   */
  async resolveWithSudoFlow(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);
    const sessionJar = shareContext.cookieJar || new SessionCookieJar(shareContext.cookies);

    validateDownloadContext({
      shareId: shareContext.shareId,
      uk: shareContext.uk,
      sign: shareContext.sign,
      timestamp: shareContext.timestamp,
      fsId: file.fs_id,
    });

    const endpoint = `${this.UNOFFICIAL_API_BASE}/share/download?app_id=250528&web=1&channel=dubox&clienttype=0`;
    const res = await this.safeFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://www.terabox.app/',
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
      },
      sessionJar
    );

    const extracted = extractTeraBoxDownloadUrl(res);
    if (extracted) {
      return { fileName, size: fileSize, downloadUrl: extracted, source: 'sudo-reference' };
    }

    const errno = res?.errno;
    const errmsg = res?.errmsg || '';
    if (errno === 400310 || String(errmsg).includes('verify_v2')) {
      throw new TeraBoxVerificationRequiredError('Sudo flow requires verification', 'sudo', errno);
    }

    throw new TeraBoxLinkResolutionFailedError('Sudo reference flow returned no download URL');
  }

  /**
   * Strategy 5: Codex67cm Compatible Resolution Flow
   */
  async resolveWithCodexFlow(
    fsId: string | number,
    shareContext: TeraBoxShareMetadata
  ): Promise<TeraBoxDownloadResult> {
    const file = shareContext.fileList.find(f => String(f.fs_id) === String(fsId)) || shareContext.fileList[0];
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);

    if (shareContext.rawHtml) {
      const dlinkMatch = shareContext.rawHtml.match(/"dlink"\s*:\s*"([^"]+)"/);
      if (dlinkMatch && dlinkMatch[1]) {
        const extracted = extractTeraBoxDownloadUrl(dlinkMatch[1]);
        if (extracted) {
          return { fileName, size: fileSize, downloadUrl: extracted, source: 'codex-reference' };
        }
      }
    }

    throw new TeraBoxLinkResolutionFailedError('Codex flow found no embedded HTML dlink');
  }

  // ── Multi-Tier Fallback Resolver Pipeline ──────────────────────────────────

  /**
   * Resolve direct download URL for a specific selected file across the multi-tier pipeline.
   */
  async resolveSelectedFile(
    url: string,
    fsId?: string | number,
    options?: { onVerificationRequired?: (info: TeraBoxVerificationSessionInfo) => Promise<void> }
  ): Promise<TeraBoxResolvedFile> {
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

    const targetFsId = String(file.fs_id);
    const fileName = file.server_filename || file.filename || 'terabox.file';
    const fileSize = Number(file.size || 0);
    const mimeType = this.categoryToMime(file.category);

    const diagnostics: StrategyExecutionRecord[] = [];
    let resolvedResult: TeraBoxDownloadResult | null = null;

    // Multi-tier strategy order starting with primary Gateway strategy
    const strategies = [
      { name: 'gateway', fn: () => this.resolveWithGateway(targetFsId, shareMetadata, options) },
      { name: 'seiya-authenticated-download', fn: () => this.resolveWithAuthenticatedDownloadFlow(targetFsId, shareMetadata) },
      { name: 'terabox-api-reference', fn: () => this.resolveWithTeraboxApiReference(targetFsId, shareMetadata) },
      { name: 'pahadi10-reference', fn: () => this.resolveWithPahadi10Flow(targetFsId, shareMetadata) },
      { name: 'hrishi-reference', fn: () => this.resolveWithHrishiFlow(targetFsId, shareMetadata) },
      { name: 'itz-reference', fn: () => this.resolveWithItzFlow(targetFsId, shareMetadata) },
      { name: 'sudo-reference', fn: () => this.resolveWithSudoFlow(targetFsId, shareMetadata) },
      { name: 'codex-reference', fn: () => this.resolveWithCodexFlow(targetFsId, shareMetadata) },
      { name: 'official-api', fn: () => this.resolveWithOfficialApi(targetFsId, shareMetadata) },
    ];

    for (const strategy of strategies) {
      try {
        const res = await strategy.fn();
        if (res && res.downloadUrl) {
          diagnostics.push({ strategyName: strategy.name, status: 'SUCCESS' });
          resolvedResult = res;
          logger.info(`[TeraBox Resolver] Strategy "${strategy.name}" SUCCEEDED.`);
          break;
        }
      } catch (err: any) {
        // CRITICAL: Gateway verification required — stop the cascade immediately.
        // The worker must handle the user verification flow.
        const isVerificationError =
          err instanceof TeraBoxGatewayVerificationSessionError ||
          err?.code === 'TERABOX_GATEWAY_VERIFICATION_REQUIRED' ||
          err?.name === 'TeraBoxGatewayVerificationSessionError' ||
          (typeof err === 'object' && err !== null && Boolean(err.sessionId) && Boolean(err.verificationUrl));

        if (isVerificationError) {
          logger.info(`[TeraBox Resolver] PROVIDER_VERIFICATION_REQUIRED sessionId=${err.sessionId || 'unknown'} — stopping cascade`);
          throw err; // re-throw immediately, do not fall through to other strategies
        }

        let status: StrategyResultStatus = 'FAILED';
        const errno = err.errno ?? err.code;
        const msg = err.message || '';

        if (
          err instanceof ProviderAccessError ||
          err instanceof TeraBoxGatewayNotConfiguredError ||
          err.code === 'ACCESS_REQUIRED' ||
          err.code === 'TERABOX_GATEWAY_NOT_CONFIGURED'
        ) {
          status = 'NOT_CONFIGURED';
        } else if (err instanceof TeraBoxAuthRequiredError || err.code === 'TERABOX_AUTH_REQUIRED') {
          status = 'AUTH_MISSING';
        } else if (
          err instanceof TeraBoxAuthRejectedError ||
          err instanceof TeraBoxGatewayAuthFailedError ||
          err.code === 'TERABOX_AUTH_REJECTED' ||
          err.code === 'TERABOX_GATEWAY_AUTH_FAILED'
        ) {
          status = 'AUTH_REJECTED';
        } else if (
          err instanceof TeraBoxVerificationRequiredError ||
          err.code === 'TERABOX_VERIFICATION_REQUIRED' ||
          errno === 400310 ||
          errno === 400210 ||
          msg.includes('verify_v2')
        ) {
          status = 'PROVIDER_VERIFICATION_REQUIRED';
        } else if (
          err instanceof TeraBoxLinkResolutionFailedError ||
          err instanceof TeraBoxGatewayLinkNotFoundError ||
          err.code === 'TERABOX_LINK_RESOLUTION_FAILED' ||
          err.code === 'TERABOX_GATEWAY_LINK_NOT_FOUND'
        ) {
          status = 'LINK_RESOLUTION_FAILED';
        }

        diagnostics.push({
          strategyName: strategy.name,
          status,
          errno: typeof errno === 'number' ? errno : undefined,
          errmsg: msg,
          message: msg,
        });
      }
    }

    // Log complete diagnostics summary
    logger.info('========================================');
    logger.info('[TeraBox Resolver] Execution Summary:');
    for (const rec of diagnostics) {
      const errDetail = rec.errno !== undefined ? ` (errno=${rec.errno})` : (rec.status === 'NOT_CONFIGURED' ? ' (Not configured)' : '');
      logger.info(`[TeraBox Resolver] ${rec.strategyName}: ${rec.status}${errDetail}`);
    }
    logger.info('========================================');

    if (!resolvedResult || !resolvedResult.downloadUrl) {
      const isVerificationRequired = diagnostics.some(
        d => d.status === 'PROVIDER_VERIFICATION_REQUIRED' || d.status === 'AUTH_REJECTED'
      );
      const isAuthMissing = diagnostics.every(
        d => d.status === 'AUTH_MISSING' || d.status === 'NOT_CONFIGURED'
      );

      if (isAuthMissing) {
        throw new TeraBoxAuthRequiredError(
          'TeraBox authentication is not configured. Required: TERABOX_NDUS',
          'authentication',
          400310
        );
      }

      if (isVerificationRequired) {
        throw new TeraBoxAuthRejectedError(
          'All available legitimate resolver strategies were attempted and the provider still requires interactive verification.',
          'authentication',
          400310
        );
      }

      throw new TeraBoxLinkResolutionFailedError(
        'All available legitimate resolver strategies failed to return a valid direct download URL.'
      );
    }

    logger.info(`[TeraBox] Direct URL obtained successfully (Source: ${resolvedResult.source})`);

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://www.terabox.app/',
      'Accept': '*/*',
    };

    const normalizedNdusVal = normalizeNdus(config.TERABOX_NDUS);
    if (normalizedNdusVal) {
      headers['Cookie'] = `ndus=${normalizedNdusVal}`;
    }

    return {
      fileName: resolvedResult.fileName || fileName,
      fileSize: resolvedResult.size || fileSize,
      mimeType,
      fsId: targetFsId,
      downloadUrl: resolvedResult.downloadUrl,
      source: resolvedResult.source,
      sourceUrl: url,
      headers,
      isUnofficial: resolvedResult.source !== 'official-api',
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
      source: resolved.source,
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
    const res = await teraBoxResolver.resolveSelectedFile(shareUrl, meta.fileList[0].fs_id);
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
