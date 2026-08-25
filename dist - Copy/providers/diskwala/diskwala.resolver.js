"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiskwalaResolver = void 0;
exports.hasDiskwalaCredentials = hasDiskwalaCredentials;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../../config");
const errors_1 = require("../errors");
const logger_1 = require("../../utils/logger");
/**
 * Checks whether Diskwala official API credentials are configured.
 */
function hasDiskwalaCredentials() {
    return !!config_1.config.DISKWALA_API_KEY;
}
class DiskwalaResolver {
    DISKWALA_API_BASE = 'https://api.diskwala.com/v1';
    /**
     * Resolves a public Diskwala link using legitimate public access or official API credentials.
     * Throws ProviderAccessError if official access is required but credentials are absent.
     * Throws ProviderUnavailableError / NotFoundError on resolution failure.
     */
    async resolvePublicLink(url) {
        logger_1.logger.info(`[Diskwala] Resolving link: ${url}`);
        // If official credentials are configured, use the official API endpoint flow
        if (hasDiskwalaCredentials()) {
            return this.resolveWithOfficialApi(url);
        }
        // Attempt public page metadata resolution without bypassing security controls
        try {
            const response = await axios_1.default.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                maxRedirects: 5
            });
            const html = response.data || '';
            // Check if page indicates file not found / deleted
            if (html.includes('File Not Found') || html.includes('404 Not Found') || html.includes('File Deleted')) {
                throw new errors_1.NotFoundError('This Diskwala file was not found or has been deleted.');
            }
            // Check if page requires user login or private permission
            if (html.includes('Access Denied') || html.includes('Login Required') || html.includes('Private File')) {
                throw new errors_1.ProviderAccessError('Diskwala', 'This Diskwala file is private or requires login authorization.');
            }
            // Extract public metadata if exposed in standard meta tags or open attributes
            const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                html.match(/<title>([^<]+)<\/title>/i);
            const downloadLinkMatch = html.match(/<a\s+[^>]*href=["'](https?:\/\/[^"']+\/(?:download|direct|files)\/[^"']+)["']/i);
            if (titleMatch && downloadLinkMatch) {
                const fileName = titleMatch[1].replace(/ - Diskwala$/i, '').trim();
                const downloadUrl = downloadLinkMatch[1];
                logger_1.logger.info(`[Diskwala] Resolved via public page: ${fileName}`);
                return {
                    fileName: fileName || 'diskwala_file',
                    fileSize: 0, // Unknown size from meta tag
                    mimeType: 'application/octet-stream',
                    downloadUrl
                };
            }
            // If page is accessible but does not expose a direct public download link without auth/API
            throw new errors_1.ProviderAccessError('Diskwala');
        }
        catch (err) {
            if (err instanceof errors_1.ProviderAccessError || err instanceof errors_1.NotFoundError || err instanceof errors_1.ProviderUnavailableError) {
                throw err;
            }
            const axiosErr = err;
            if (axiosErr.response?.status === 404) {
                throw new errors_1.NotFoundError('This Diskwala link was not found or has expired.');
            }
            // Default: Report requiring official API access rather than crashing
            throw new errors_1.ProviderAccessError('Diskwala');
        }
    }
    /**
     * Resolves link via Diskwala's official API when DISKWALA_API_KEY is present.
     */
    async resolveWithOfficialApi(url) {
        try {
            const response = await axios_1.default.get(`${this.DISKWALA_API_BASE}/file/info`, {
                params: {
                    key: config_1.config.DISKWALA_API_KEY,
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
                    throw new errors_1.NotFoundError('This Diskwala file was not found.');
                }
                throw new errors_1.ProviderUnavailableError('Diskwala API returned an invalid response.');
            }
            const file = data.result;
            return {
                fileName: file.filename || 'diskwala_file',
                fileSize: Number(file.size || 0),
                mimeType: file.mimetype || 'application/octet-stream',
                downloadUrl: file.download_url
            };
        }
        catch (err) {
            if (err instanceof errors_1.NotFoundError || err instanceof errors_1.ProviderUnavailableError) {
                throw err;
            }
            logger_1.logger.error(`[Diskwala] Official API error: ${err?.message}`);
            throw new errors_1.ProviderUnavailableError('Failed to access Diskwala API. Please try again later.');
        }
    }
}
exports.DiskwalaResolver = DiskwalaResolver;
