"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeraBoxProvider = void 0;
const terabox_resolver_1 = require("./terabox.resolver");
const errors_1 = require("../errors");
class TeraBoxProvider {
    name = 'TeraBox';
    resolver = new terabox_resolver_1.TeraBoxResolver();
    /**
     * Validate if the given URL is a supported TeraBox public link
     * and passes domain whitelist & SSRF security checks.
     */
    canHandle(url) {
        return (0, terabox_resolver_1.isSafeTeraBoxUrl)(url);
    }
    /**
     * Returns whether official TeraBox Open Platform credentials are configured.
     */
    isConfigured() {
        return (0, terabox_resolver_1.hasTeraBoxCredentials)();
    }
    /**
     * Retrieve basic file metadata without resolving full download payload.
     */
    async getFileInfo(url) {
        const resolved = await this.resolve(url);
        return {
            fileName: resolved.fileName,
            fileSize: resolved.fileSize,
            mimeType: resolved.mimeType,
        };
    }
    /**
     * Get metadata list for single or multi-file TeraBox share.
     */
    async getShareMetadata(url) {
        if (!this.canHandle(url)) {
            throw new errors_1.InvalidUrlError('❌ Invalid TeraBox link');
        }
        return this.resolver.getShareMetadata(url);
    }
    /**
     * Resolve selected file from single or multi-file share.
     */
    async resolveSelectedFile(url, fsId) {
        if (!this.canHandle(url)) {
            throw new errors_1.InvalidUrlError('❌ Invalid TeraBox link');
        }
        const result = await this.resolver.resolveSelectedFile(url, fsId);
        return {
            provider: this.name,
            sourceUrl: url,
            fileName: result.fileName,
            fileSize: result.fileSize,
            mimeType: result.mimeType,
            downloadUrl: result.downloadUrl,
            headers: result.headers,
        };
    }
    /**
     * Complete resolution process returning file details and direct download URL.
     */
    async resolve(url) {
        return this.resolveSelectedFile(url);
    }
}
exports.TeraBoxProvider = TeraBoxProvider;
