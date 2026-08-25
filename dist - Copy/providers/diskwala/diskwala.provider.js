"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiskwalaProvider = void 0;
const diskwala_resolver_1 = require("./diskwala.resolver");
const errors_1 = require("../errors");
const DISKWALA_DOMAINS = [
    'diskwala.com',
    'diskwalaapp.com',
    'disk.wala',
];
class DiskwalaProvider {
    name = 'Diskwala';
    resolver = new diskwala_resolver_1.DiskwalaResolver();
    canHandle(url) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                return false;
            return DISKWALA_DOMAINS.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
        }
        catch {
            return false;
        }
    }
    /**
     * Checks whether official Diskwala API credentials are configured.
     */
    isConfigured() {
        return (0, diskwala_resolver_1.hasDiskwalaCredentials)();
    }
    async resolve(url) {
        if (!this.canHandle(url)) {
            throw new errors_1.InvalidUrlError('Invalid or unsupported Diskwala link.');
        }
        const result = await this.resolver.resolvePublicLink(url);
        return {
            provider: this.name,
            sourceUrl: url,
            fileName: result.fileName,
            fileSize: result.fileSize,
            mimeType: result.mimeType,
            downloadUrl: result.downloadUrl
        };
    }
}
exports.DiskwalaProvider = DiskwalaProvider;
