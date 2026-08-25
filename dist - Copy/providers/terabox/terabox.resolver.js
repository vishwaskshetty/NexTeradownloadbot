"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.teraBoxResolver = exports.TeraBoxResolver = exports.TERABOX_DOMAINS = void 0;
exports.isSafeTeraBoxUrl = isSafeTeraBoxUrl;
exports.extractShareCode = extractShareCode;
exports.hasTeraBoxCredentials = hasTeraBoxCredentials;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../../config");
const redis_1 = require("../../redis");
const errors_1 = require("../errors");
const logger_1 = require("../../utils/logger");
/**
 * Official & supported TeraBox public share domains.
 */
exports.TERABOX_DOMAINS = [
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
function isSafeTeraBoxUrl(inputUrl) {
    try {
        const parsed = new URL(inputUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        const hostname = parsed.hostname.toLowerCase();
        // 1. SSRF Guard: Block localhost, loopback, private IPv4 & IPv6 addresses
        if (hostname === 'localhost' ||
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
            hostname.endsWith('.internal')) {
            return false;
        }
        // 2. Domain Whitelist Check
        return exports.TERABOX_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    }
    catch {
        return false;
    }
}
/**
 * Extract share code (surl) from TeraBox share link
 */
function extractShareCode(url) {
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
    }
    catch {
        return null;
    }
}
/**
 * Checks whether official TeraBox API credentials are fully configured in environment
 */
function hasTeraBoxCredentials() {
    return !!(config_1.config.TERABOX_CLIENT_ID &&
        config_1.config.TERABOX_CLIENT_SECRET &&
        config_1.config.TERABOX_ACCESS_TOKEN);
}
class TeraBoxResolver {
    OFFICIAL_API_BASE = 'https://openapi.terabox.com';
    UNOFFICIAL_API_BASE = 'https://www.terabox.app';
    REQUEST_TIMEOUT_MS = 15000;
    MAX_RETRIES = 2;
    /**
     * Safe HTTP fetcher with AbortController timeout & limited retries for temporary network errors
     */
    async safeFetch(url, options = {}) {
        let attempt = 0;
        while (attempt <= this.MAX_RETRIES) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.terabox.app/',
                ...(options.headers || {}),
            };
            if (config_1.config.TERABOX_NDUS && !requestHeaders['Cookie']) {
                requestHeaders['Cookie'] = `ndus=${config_1.config.TERABOX_NDUS}`;
            }
            try {
                const response = await (0, axios_1.default)({
                    ...options,
                    url,
                    signal: controller.signal,
                    timeout: this.REQUEST_TIMEOUT_MS,
                    headers: requestHeaders,
                    maxRedirects: 5,
                });
                clearTimeout(timer);
                return response.data;
            }
            catch (err) {
                clearTimeout(timer);
                attempt++;
                const isAxiosErr = axios_1.default.isAxiosError(err);
                const status = isAxiosErr ? err.response?.status : undefined;
                // Do NOT retry 4xx errors
                if (status && status >= 400 && status < 500) {
                    throw err;
                }
                if (attempt <= this.MAX_RETRIES) {
                    const delay = attempt * 1500;
                    logger_1.logger.warn(`[TeraBoxResolver] Network attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                }
                else {
                    throw err;
                }
            }
        }
    }
    /**
     * Retrieve file metadata array for a TeraBox share (supports both single and multi-file shares)
     */
    async getShareMetadata(url) {
        if (!isSafeTeraBoxUrl(url)) {
            throw new errors_1.InvalidUrlError('❌ Invalid TeraBox link');
        }
        const shareCode = extractShareCode(url);
        if (!shareCode) {
            throw new errors_1.InvalidUrlError('❌ Unsupported TeraBox link');
        }
        logger_1.logger.info(`[TeraBox] Resolving share URL code: ${shareCode}`);
        // Check cache
        const cacheKey = `terabox:meta_list:${shareCode}`;
        try {
            const cached = await redis_1.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        }
        catch { }
        let fileList = [];
        // Strategy 1: Configured Gateway Service (if set)
        if (config_1.config.TERABOX_GATEWAY_URL) {
            try {
                const gwRes = await this.safeFetch(`${config_1.config.TERABOX_GATEWAY_URL}/api/get-info?shorturl=${shareCode}`);
                if (gwRes && Array.isArray(gwRes.list) && gwRes.list.length > 0) {
                    fileList = gwRes.list;
                }
            }
            catch (e) {
                logger_1.logger.warn(`[TeraBox] Configured gateway resolution failed: ${e.message}`);
            }
        }
        // Strategy 2: Official API
        if (fileList.length === 0 && hasTeraBoxCredentials()) {
            const accessToken = config_1.config.TERABOX_ACCESS_TOKEN;
            try {
                const data = await this.safeFetch(`${this.OFFICIAL_API_BASE}/rest/2.0/xpan/share/sharepage/query`, {
                    method: 'GET',
                    params: { access_token: accessToken, shorturl: shareCode, root: 1 },
                });
                if (data && data.errno === 0 && Array.isArray(data.list)) {
                    fileList = data.list;
                }
            }
            catch { }
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
            }
            catch { }
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
                }
                catch { }
            }
        }
        if (fileList.length === 0) {
            throw new errors_1.NotFoundError('❌ File is unavailable or private');
        }
        const firstFile = fileList[0];
        logger_1.logger.info(`[TeraBox] File identified: "${firstFile.server_filename || firstFile.filename}" (Expected size: ${firstFile.size || 'unknown'})`);
        const metadata = {
            surl: shareCode,
            fileList,
        };
        try {
            await redis_1.redis.setex(cacheKey, 600, JSON.stringify(metadata));
        }
        catch { }
        return metadata;
    }
    /**
     * Resolve direct download URL for a specific selected file (or first file if fsId omitted)
     */
    async resolveSelectedFile(url, fsId) {
        const shareMetadata = await this.getShareMetadata(url);
        const fileList = shareMetadata.fileList;
        let file;
        if (fsId !== undefined && fsId !== null) {
            file = fileList.find(f => String(f.fs_id) === String(fsId));
        }
        if (!file) {
            file = fileList[0];
        }
        if (!file) {
            throw new errors_1.NotFoundError('❌ File is unavailable or private');
        }
        const shareCode = shareMetadata.surl;
        const fileName = file.server_filename || file.filename || `terabox_${shareCode}.file`;
        const fileSize = Number(file.size || 0);
        const mimeType = this.categoryToMime(file.category);
        let downloadUrl = file.dlink;
        if (!downloadUrl && config_1.config.TERABOX_GATEWAY_URL) {
            try {
                const gwRes = await this.safeFetch(`${config_1.config.TERABOX_GATEWAY_URL}/api/get-info?shorturl=${shareCode}&fs_id=${file.fs_id}`);
                if (gwRes?.downloadUrl) {
                    downloadUrl = gwRes.downloadUrl;
                }
            }
            catch { }
        }
        if (!downloadUrl && hasTeraBoxCredentials()) {
            try {
                downloadUrl = await this.getOfficialDownloadUrl(config_1.config.TERABOX_ACCESS_TOKEN, String(file.fs_id), shareCode);
            }
            catch { }
        }
        if (!downloadUrl) {
            downloadUrl = `${this.UNOFFICIAL_API_BASE}/share/download?surl=${shareCode}&fs_id=${file.fs_id}`;
        }
        logger_1.logger.info(`[TeraBox] Direct download URL obtained for "${fileName}" (${fileSize} bytes)`);
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': 'https://www.terabox.app/',
            'Accept': '*/*',
        };
        if (config_1.config.TERABOX_NDUS) {
            headers['Cookie'] = `ndus=${config_1.config.TERABOX_NDUS}`;
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
    async resolvePublicLink(url) {
        return this.resolveSelectedFile(url);
    }
    /**
     * Official Download URL getter
     */
    async getOfficialDownloadUrl(accessToken, fsId, shareCode) {
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
            throw new errors_1.ProviderUnavailableError('❌ Temporary TeraBox service error. Please try again.');
        }
        return downloadList[0].dlink;
    }
    /**
     * Map TeraBox file categories to standard MIME types
     */
    categoryToMime(category) {
        const map = {
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
exports.TeraBoxResolver = TeraBoxResolver;
exports.teraBoxResolver = new TeraBoxResolver();
