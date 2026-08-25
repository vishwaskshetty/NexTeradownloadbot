"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAdapter = void 0;
const terabox_1 = require("./terabox");
const diskwala_1 = require("./diskwala");
const adapters = [
    new terabox_1.TeraboxAdapter(),
    new diskwala_1.DiskwalaAdapter(),
];
const detectAdapter = (url) => {
    for (const adapter of adapters) {
        if (adapter.canHandle(url)) {
            return adapter;
        }
    }
    return null;
};
exports.detectAdapter = detectAdapter;
