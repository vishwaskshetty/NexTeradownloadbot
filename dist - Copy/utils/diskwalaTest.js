"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDiskwalaTests = runDiskwalaTests;
const diskwala_provider_1 = require("../providers/diskwala/diskwala.provider");
const diskwala_resolver_1 = require("../providers/diskwala/diskwala.resolver");
const errors_1 = require("../providers/errors");
async function runDiskwalaTests() {
    const log = [];
    let total = 0;
    let passed = 0;
    let failed = 0;
    const provider = new diskwala_provider_1.DiskwalaProvider();
    const resolver = new diskwala_resolver_1.DiskwalaResolver();
    log.push('==================================================');
    log.push('🧪 TESTING DISKWALA PROVIDER & RESOLVER');
    log.push('==================================================\n');
    // Test 1: URL Detection - Valid URLs
    const validUrls = [
        'https://diskwala.com/file/12345',
        'https://www.diskwala.com/share/abcde',
        'https://diskwalaapp.com/v/999',
        'https://sub.disk.wala/d/xyz'
    ];
    for (const url of validUrls) {
        total++;
        if (provider.canHandle(url)) {
            passed++;
            log.push(`✅ URL Detection (Valid): "${url}" -> Recognized`);
        }
        else {
            failed++;
            log.push(`❌ URL Detection (Valid): "${url}" -> NOT Recognized`);
        }
    }
    // Test 2: URL Detection - Invalid / Unrelated URLs
    const invalidUrls = [
        'https://google.com',
        'https://example.com/diskwala.com',
        'not_a_url',
        'ftp://diskwala.com/file'
    ];
    for (const url of invalidUrls) {
        total++;
        if (!provider.canHandle(url)) {
            passed++;
            log.push(`✅ URL Detection (Invalid): "${url}" -> Correctly Rejected`);
        }
        else {
            failed++;
            log.push(`❌ URL Detection (Invalid): "${url}" -> Unexpectedly Accepted`);
        }
    }
    // Test 3: Resolution - Invalid URL Error
    total++;
    try {
        await provider.resolve('https://invalid-domain.com');
        failed++;
        log.push(`❌ Resolution (Invalid URL): Expected InvalidUrlError, but resolution succeeded.`);
    }
    catch (e) {
        if (e instanceof errors_1.InvalidUrlError) {
            passed++;
            log.push(`✅ Resolution (Invalid URL): Caught InvalidUrlError as expected.`);
        }
        else {
            failed++;
            log.push(`❌ Resolution (Invalid URL): Caught wrong error - ${e.message}`);
        }
    }
    // Test 4: Resolution - Credential Guard / ProviderAccessError
    total++;
    try {
        await provider.resolve('https://diskwala.com/file/test_sample_123');
        // If resolution fails with ProviderAccessError or NotFoundError without crashing:
        passed++;
        log.push(`✅ Resolution (Public Link handling): Handled gracefully without crash.`);
    }
    catch (e) {
        if (e instanceof errors_1.ProviderAccessError || e instanceof errors_1.NotFoundError) {
            passed++;
            log.push(`✅ Resolution (Public Link handling): Cleanly caught expected error [${e.name}: ${e.message}]`);
        }
        else {
            failed++;
            log.push(`❌ Resolution (Public Link handling): Unexpected exception [${e.name}: ${e.message}]`);
        }
    }
    log.push('\n--------------------------------------------------');
    log.push(`SUMMARY: Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
    log.push('--------------------------------------------------');
    return { total, passed, failed, log };
}
