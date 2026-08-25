"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAdapter = void 0;
const terabox_1 = require("./terabox");
const diskwala_1 = require("./diskwala");
const downloaders = {
    'TeraBox': new terabox_1.TeraBoxDownloader(),
    'Diskwala': new diskwala_1.DiskwalaDownloader()
};
const detectAdapter = (url) => {
    for (const [providerName, adapter] of Object.entries(downloaders)) {
        if (adapter.canHandle(url)) {
            return { providerName, adapter };
        }
    }
    return null;
};
exports.detectAdapter = detectAdapter;
