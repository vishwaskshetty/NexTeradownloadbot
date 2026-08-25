"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeraboxAdapter = void 0;
const terabox_provider_1 = require("../providers/terabox/terabox.provider");
class TeraboxAdapter {
    providerName = 'TeraBox';
    provider = new terabox_provider_1.TeraBoxProvider();
    canHandle(url) {
        return this.provider.canHandle(url);
    }
    async resolve(url) {
        return this.provider.resolve(url);
    }
    async getShareMetadata(url) {
        return this.provider.getShareMetadata(url);
    }
    async resolveSelectedFile(url, fsId) {
        return this.provider.resolveSelectedFile(url, fsId);
    }
    async processLink(url, jobId, onProgress) {
        await onProgress('🔎 Validating and resolving TeraBox public share link...');
        await this.provider.resolve(url);
        await onProgress('✅ TeraBox link successfully resolved!');
    }
}
exports.TeraboxAdapter = TeraboxAdapter;
