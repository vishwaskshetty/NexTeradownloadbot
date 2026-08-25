"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeraBoxDownloader = void 0;
class TeraBoxDownloader {
    canHandle(url) {
        const teraboxDomains = [
            'terabox.com', 'teraboxapp.com', 'teraboxlink.com', 'nephobox.com',
            '4funbox.com', 'mirrobox.com', 'momerybox.com', 'terabox.app',
            'gibox.app', 'freeterabox.com', '1024tera.com', 'terasharelink.com', 'terabox.fun'
        ];
        try {
            const parsedUrl = new URL(url);
            return teraboxDomains.some(domain => parsedUrl.hostname.includes(domain));
        }
        catch {
            return false;
        }
    }
    async getMetadata(url) {
        // Official TeraBox API implementation pending
        // Requires TERABOX_CLIENT_ID and TERABOX_CLIENT_SECRET for OAuth
        throw new Error('TeraBox integration pending: Official API credentials required.');
    }
    async download(url, options) {
        // Official TeraBox API implementation pending
        return {
            success: false,
            error: 'TeraBox integration pending: Official API credentials required.'
        };
    }
}
exports.TeraBoxDownloader = TeraBoxDownloader;
