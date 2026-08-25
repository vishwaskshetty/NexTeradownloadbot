"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getShortenerProvider = exports.ArolinksProvider = exports.DisabledProvider = exports.BitlyProvider = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const AdminService_1 = require("../services/AdminService");
class BitlyProvider {
    getProviderName() {
        return 'bitly';
    }
    async createShortUrl(destinationUrl) {
        if (!config_1.config.SHORTENER_API_KEY) {
            throw new Error('SHORTENER_API_KEY is not configured for Bitly.');
        }
        try {
            const response = await axios_1.default.post('https://api-ssl.bitly.com/v4/shorten', { long_url: destinationUrl }, {
                headers: {
                    'Authorization': `Bearer ${config_1.config.SHORTENER_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            if (response.data?.link) {
                return response.data.link;
            }
            throw new Error('Bitly API returned no link');
        }
        catch (error) {
            logger_1.logger.error(`[BitlyProvider] Bitly API error: ${error?.message}`);
            throw error;
        }
    }
}
exports.BitlyProvider = BitlyProvider;
class DisabledProvider {
    getProviderName() {
        return 'disabled';
    }
    async createShortUrl(destinationUrl) {
        return destinationUrl;
    }
}
exports.DisabledProvider = DisabledProvider;
class ArolinksProvider {
    getProviderName() {
        return 'arolinks';
    }
    async createShortUrl(destinationUrl) {
        if (!config_1.config.SHORTENER_API_KEY || config_1.config.SHORTENER_API_KEY.includes('your_arolinks_api_key')) {
            throw new Error('SHORTENER_API_KEY is not configured in .env for AroLinks.');
        }
        try {
            // AroLinks API endpoint: GET https://arolinks.com/api?api=KEY&url=DESTINATION
            const apiUrl = `https://arolinks.com/api?api=${encodeURIComponent(config_1.config.SHORTENER_API_KEY)}&url=${encodeURIComponent(destinationUrl)}`;
            const response = await axios_1.default.get(apiUrl, { timeout: 10000 });
            const data = response.data;
            const shortUrl = data?.shortenedUrl || data?.shortened_url || data?.url || data?.short_url || data?.link;
            if (shortUrl && typeof shortUrl === 'string' && shortUrl.startsWith('http')) {
                logger_1.logger.info(`[ArolinksProvider] Successfully generated AroLinks URL: ${shortUrl}`);
                return shortUrl;
            }
            if (data?.status === 'error' && Array.isArray(data?.message)) {
                throw new Error(`AroLinks API returned error: ${data.message.join(', ')}`);
            }
            throw new Error(`AroLinks API response format unrecognized`);
        }
        catch (err) {
            // Sanitize secrets in error logging
            const sanitizedErrMsg = (err?.message || '').replace(config_1.config.SHORTENER_API_KEY, '***');
            logger_1.logger.error(`[ArolinksProvider] AroLinks request failed: ${sanitizedErrMsg}`);
            throw new Error(`AroLinks API request failed: ${sanitizedErrMsg}`);
        }
    }
}
exports.ArolinksProvider = ArolinksProvider;
// Factory to select provider based on config/db
const getShortenerProvider = async () => {
    const isEnabled = await AdminService_1.adminService.getShortenerStatus();
    if (!isEnabled) {
        return new DisabledProvider();
    }
    const providerName = (await AdminService_1.adminService.getShortenerProvider()).toLowerCase();
    if (providerName === 'bitly') {
        return new BitlyProvider();
    }
    // Default to AroLinks as requested
    return new ArolinksProvider();
};
exports.getShortenerProvider = getShortenerProvider;
