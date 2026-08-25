"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiskwalaAdapter = void 0;
const diskwala_provider_1 = require("../providers/diskwala/diskwala.provider");
class DiskwalaAdapter {
    providerName = 'DISKWALA';
    provider = new diskwala_provider_1.DiskwalaProvider();
    canHandle(url) {
        return this.provider.canHandle(url);
    }
    async processLink(url, jobId, onProgress) {
        await onProgress('⏳ Resolving Diskwala link...');
        await this.provider.resolve(url);
    }
}
exports.DiskwalaAdapter = DiskwalaAdapter;
