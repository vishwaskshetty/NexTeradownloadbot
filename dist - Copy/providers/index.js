"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAdapter = exports.providerRegistry = exports.ProviderRegistry = void 0;
const terabox_provider_1 = require("./terabox/terabox.provider");
const diskwala_provider_1 = require("./diskwala/diskwala.provider");
class ProviderRegistry {
    providers = [];
    constructor() {
        this.registerProvider(new terabox_provider_1.TeraBoxProvider());
        this.registerProvider(new diskwala_provider_1.DiskwalaProvider());
    }
    registerProvider(provider) {
        this.providers.push(provider);
    }
    getProviderForUrl(url) {
        return this.providers.find(p => p.canHandle(url));
    }
    detectAdapter(url) {
        const provider = this.getProviderForUrl(url);
        if (!provider)
            return null;
        return {
            providerName: provider.name,
            adapter: provider
        };
    }
}
exports.ProviderRegistry = ProviderRegistry;
exports.providerRegistry = new ProviderRegistry();
// Keep backward compatible export for message.ts
const detectAdapter = (url) => exports.providerRegistry.detectAdapter(url);
exports.detectAdapter = detectAdapter;
