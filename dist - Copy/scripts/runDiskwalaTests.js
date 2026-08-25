"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const diskwalaTest_1 = require("../utils/diskwalaTest");
async function main() {
    const result = await (0, diskwalaTest_1.runDiskwalaTests)();
    result.log.forEach(line => console.log(line));
    if (result.failed > 0) {
        process.exit(1);
    }
}
main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
