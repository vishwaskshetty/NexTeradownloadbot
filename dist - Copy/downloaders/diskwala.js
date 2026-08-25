"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiskwalaDownloader = void 0;
class DiskwalaDownloader {
    canHandle(url) {
        try {
            const parsedUrl = new URL(url);
            return parsedUrl.hostname.includes('diskwala.com') || parsedUrl.hostname.includes('disk.wala');
        }
        catch {
            return false;
        }
    }
    async getMetadata(url) {
        throw new Error('Diskwala integration pending: Official API credentials required.');
    }
    async download(url, options) {
        return {
            success: false,
            error: 'Diskwala integration pending: Official API credentials required.'
        };
    }
}
exports.DiskwalaDownloader = DiskwalaDownloader;
