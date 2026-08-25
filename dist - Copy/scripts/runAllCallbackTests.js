"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const callbackTest_1 = require("../utils/callbackTest");
async function main() {
    console.log('Running complete Telegram Callback & Keyboard audit...');
    const result = await (0, callbackTest_1.runCallbackAudit)();
    result.log.forEach((line) => console.log(line));
    if (result.failed > 0) {
        console.error(`❌ Callback Audit Failed with ${result.failed} errors.`);
        process.exit(1);
    }
}
main().catch(err => {
    console.error('Audit script error:', err);
    process.exit(1);
});
