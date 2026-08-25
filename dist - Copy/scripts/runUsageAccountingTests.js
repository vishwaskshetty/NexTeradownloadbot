"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const usageAccountingTest_1 = require("../utils/usageAccountingTest");
async function main() {
    const result = await (0, usageAccountingTest_1.runUsageAccountingTests)();
    result.log.forEach(line => console.log(line));
    if (result.failed > 0) {
        process.exit(1);
    }
}
main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
