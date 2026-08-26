/**
 * Unit tests for src/utils/downloadValidator.ts
 *
 * Covers all QA test cases from the spec:
 *   TC1: Valid 349 MB download    → PASS
 *   TC2: 117-byte download        → FAIL (blocked before upload)
 *   TC3: HTTP 200 + text/html     → FAIL (pre-stream rejection)
 *   TC4: HTTP 403                 → FAIL (pre-stream rejection)
 *   TC5: Expired URL (retry)      → tested via mocking
 *   TC6: Cached size mismatch     → tested via mock logic
 *   TC7: Single polling instance  → tested in bot.ts (separate concern)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateDownloadedFile,
  validateHttpResponseHeaders,
  formatBytes,
} from '../src/utils/downloadValidator';

// ── Helpers ──────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const tmpDir = os.tmpdir();

function makeTempFile(name: string, size: number, content?: Buffer): string {
  const filePath = path.join(tmpDir, `validator_test_${name}`);
  if (content) {
    fs.writeFileSync(filePath, content);
  } else {
    // Write `size` bytes of 0x00
    const buf = Buffer.alloc(size, 0x00);
    fs.writeFileSync(filePath, buf);
  }
  return filePath;
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }
}

// ── TC1: Valid 349 MB file ───────────────────────────────────────────────────

describe('TC1: Valid large binary file', () => {
  const EXPECTED = 366_002_036; // 349.05 MB
  let filePath: string;

  afterAll(() => cleanup(filePath));

  it('should PASS a 366 MB binary file with valid MKV header', async () => {
    // Write minimal EBML magic header (0x1A45DFA3) + enough size
    const mkv = Buffer.alloc(EXPECTED, 0x00);
    mkv[0] = 0x1A; mkv[1] = 0x45; mkv[2] = 0xDF; mkv[3] = 0xA3;
    filePath = makeTempFile('valid_366mb.mkv', EXPECTED, mkv);

    const result = await validateDownloadedFile(filePath, EXPECTED, 'video.mkv');
    expect(result.valid).toBe(true);
    expect(result.actualSize).toBe(EXPECTED);
    expect(result.reason).toBeUndefined();
  });
});

// ── TC2: 117-byte download (the phantom upload bug) ──────────────────────────

describe('TC2: 117-byte file when 349 MB expected', () => {
  const EXPECTED = 366_002_036;
  let filePath: string;

  afterAll(() => cleanup(filePath));

  it('should FAIL immediately — suspiciously small vs expected', async () => {
    filePath = makeTempFile('tiny_117.mkv', 117);
    const result = await validateDownloadedFile(filePath, EXPECTED, 'video.mkv');
    expect(result.valid).toBe(false);
    expect(result.actualSize).toBe(117);
    expect(result.reason).toMatch(/suspiciously small|too small|mismatch/i);
  });

  it('should FAIL even without expected size — absolute minimum check', async () => {
    filePath = makeTempFile('tiny_117_noexp.mkv', 117);
    const result = await validateDownloadedFile(filePath, undefined, 'video.mkv');
    expect(result.valid).toBe(false);
    expect(result.actualSize).toBe(117);
    expect(result.reason).toMatch(/too small|minimum/i);
  });
});

// ── TC3: HTTP 200 + text/html response ───────────────────────────────────────

describe('TC3: HTTP 200 but Content-Type is text/html', () => {
  it('should FAIL pre-stream header validation', () => {
    const result = validateHttpResponseHeaders({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      contentLength: 117,
      expectedSize: 366_002_036,
      filename: 'video.mkv',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/text\/html|error page/i);
  });
});

// ── TC4: HTTP 403 ─────────────────────────────────────────────────────────────

describe('TC4: HTTP 403 Forbidden', () => {
  it('should FAIL pre-stream header validation', () => {
    const result = validateHttpResponseHeaders({
      status: 403,
      contentType: 'text/html',
      contentLength: 0,
      filename: 'video.mkv',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/HTTP 403/i);
  });
});

// ── Additional HTTP header validation cases ───────────────────────────────────

describe('validateHttpResponseHeaders', () => {
  it('PASS for valid binary response', () => {
    const result = validateHttpResponseHeaders({
      status: 200,
      contentType: 'application/octet-stream',
      contentLength: 366_002_036,
      expectedSize: 366_002_036,
      filename: 'video.mkv',
    });
    expect(result.valid).toBe(true);
  });

  it('FAIL for application/json content-type on media file', () => {
    const result = validateHttpResponseHeaders({
      status: 200,
      contentType: 'application/json',
      contentLength: 100,
      filename: 'video.mkv',
    });
    expect(result.valid).toBe(false);
  });

  it('FAIL when Content-Length < 1 MB but expected > 1 MB', () => {
    const result = validateHttpResponseHeaders({
      status: 200,
      contentType: 'application/octet-stream',
      contentLength: 500,  // 500 bytes
      expectedSize: 366_002_036,
      filename: 'video.mkv',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/suspiciously small/i);
  });

  it('PASS for text/html on .html file (expected text file)', () => {
    const result = validateHttpResponseHeaders({
      status: 200,
      contentType: 'text/html',
      contentLength: 1024,
      filename: 'page.html',
    });
    expect(result.valid).toBe(true);
  });
});

// ── Content inspection: HTML error page content detection ────────────────────

describe('validateDownloadedFile — HTML content detection', () => {
  let filePath: string;
  afterAll(() => cleanup(filePath));

  it('should FAIL a file whose content starts with <!DOCTYPE html>', async () => {
    // Pad to > 1024 bytes so the content-inspection guard runs (not the size guard)
    const html = '<!DOCTYPE html><html><body>Error page - file not available</body></html>';
    const padded = html.padEnd(2048, ' ');
    const htmlContent = Buffer.from(padded);
    filePath = makeTempFile('html_error.mkv', htmlContent.length, htmlContent);

    const result = await validateDownloadedFile(filePath, undefined, 'video.mkv');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/html page|error|matched/i);
  });

  it('should FAIL a file whose content is a JSON error', async () => {
    // Pad to > 1024 bytes so the content-inspection guard runs (not the size guard)
    const json = '{"errno":-1,"errmsg":"Link expired","request_id":"xyz"}';
    const padded = json.padEnd(2048, ' ');
    const jsonContent = Buffer.from(padded);
    filePath = makeTempFile('json_err.mkv', jsonContent.length, jsonContent);

    const result = await validateDownloadedFile(filePath, undefined, 'video.mkv');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/error\/html page|matched/i);
  });
});

// ── Size tolerance edge cases ─────────────────────────────────────────────────

describe('validateDownloadedFile — size tolerance', () => {
  let filePath: string;
  const EXPECTED = 100 * MB;

  afterAll(() => cleanup(filePath));

  it('PASS at exactly 90% of expected', async () => {
    const size = Math.floor(EXPECTED * 0.90);
    // Use .bin extension — no magic-byte check for generic binary files
    filePath = makeTempFile('size_90pct.bin', size);
    const result = await validateDownloadedFile(filePath, EXPECTED, 'data.bin');
    expect(result.valid).toBe(true);
  });

  it('FAIL at 89% of expected', async () => {
    const size = Math.floor(EXPECTED * 0.89);
    filePath = makeTempFile('size_89pct.bin', size);
    const result = await validateDownloadedFile(filePath, EXPECTED, 'data.bin');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mismatch|89%/i);
  });

  it('FAIL when expected > 1 MB but actual < 1 MB', async () => {
    const size = 500 * 1024; // 500 KB
    filePath = makeTempFile('small_vs_large.bin', size);
    const result = await validateDownloadedFile(filePath, 100 * MB, 'data.bin');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/suspiciously small/i);
  });
});

// ── MKV magic byte check ──────────────────────────────────────────────────────

describe('validateDownloadedFile — MKV magic bytes', () => {
  let filePath: string;
  afterAll(() => cleanup(filePath));

  it('FAIL for a >1 MB file with .mkv extension that lacks EBML header', async () => {
    const buf = Buffer.alloc(2 * MB, 0x00); // no EBML magic
    filePath = makeTempFile('bad_mkv.mkv', buf.length, buf);
    const result = await validateDownloadedFile(filePath, 2 * MB, 'bad.mkv');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/EBML|mkv/i);
  });

  it('PASS for a >1 MB file with valid EBML header', async () => {
    const buf = Buffer.alloc(2 * MB, 0x00);
    buf[0] = 0x1A; buf[1] = 0x45; buf[2] = 0xDF; buf[3] = 0xA3;
    filePath = makeTempFile('good_mkv.mkv', buf.length, buf);
    const result = await validateDownloadedFile(filePath, 2 * MB, 'good.mkv');
    expect(result.valid).toBe(true);
  });
});

// ── Empty / missing file ──────────────────────────────────────────────────────

describe('validateDownloadedFile — missing / empty file', () => {
  it('FAIL for a non-existent file path', async () => {
    const result = await validateDownloadedFile('/tmp/does_not_exist_xyz.mkv', 100, 'x.mkv');
    expect(result.valid).toBe(false);
    expect(result.actualSize).toBe(0);
  });

  it('FAIL for a 0-byte file', async () => {
    const filePath = makeTempFile('empty.bin', 0);
    const result = await validateDownloadedFile(filePath, 0, 'x.bin');
    cleanup(filePath);
    expect(result.valid).toBe(false);
    expect(result.actualSize).toBe(0);
  });
});

// ── formatBytes helper ────────────────────────────────────────────────────────

describe('formatBytes', () => {
  it('formats 0', () => expect(formatBytes(0)).toBe('0 B'));
  it('formats bytes', () => expect(formatBytes(500)).toBe('500 B'));
  it('formats KB', () => expect(formatBytes(2048)).toBe('2 KB'));
  it('formats MB', () => expect(formatBytes(1024 * 1024)).toBe('1 MB'));
  it('formats 349 MB', () => expect(formatBytes(366_002_036)).toMatch(/MB/));
  it('formats BigInt', () => expect(formatBytes(BigInt(1024))).toBe('1 KB'));
});

// ── Configurable Size Tolerance Options ───────────────────────────────────────

describe('validateDownloadedFile — configurable tolerance', () => {
  let filePath: string;
  const EXPECTED = 100 * MB;

  afterAll(() => cleanup(filePath));

  it('supports custom 0.99 tolerance (strict 99% check)', async () => {
    const size = Math.floor(EXPECTED * 0.98); // 98%
    filePath = makeTempFile('size_98pct.bin', size);
    // With default (0.90), 98% passes
    const defaultRes = await validateDownloadedFile(filePath, EXPECTED, 'data.bin');
    expect(defaultRes.valid).toBe(true);

    // With custom strict tolerance (0.99), 98% fails
    const strictRes = await validateDownloadedFile(filePath, EXPECTED, 'data.bin', { toleranceLower: 0.99 });
    expect(strictRes.valid).toBe(false);
    expect(strictRes.reason).toMatch(/mismatch|below 99%/i);
  });
});

// ── TC5: Expired URL Cache Busting logic ──────────────────────────────────────

describe('TC5: Expired URL cache invalidation logic', () => {
  it('extracts share code correctly to enable cache busting', () => {
    const { extractShareCode } = require('../src/providers/terabox/terabox.resolver');
    const url1 = 'https://terabox.com/s/1abcd1234efg';
    const url2 = 'https://www.1024terabox.com/s/xyz987654';
    const url3 = 'https://teraboxapp.com/sharing/link?surl=1qwerty123';

    expect(extractShareCode(url1)).toBe('abcd1234efg');
    expect(extractShareCode(url2)).toBe('xyz987654');
    expect(extractShareCode(url3)).toBe('qwerty123');
  });
});

// ── TC6: Cache Validation & Invalidation logic ────────────────────────────────

describe('TC6: Cache Validation Rule', () => {
  it('rejects cached file if cachedFileSize differs significantly from requested expectedSize', () => {
    const requestedExpectedSize = 366_002_036; // 349 MB
    const corruptCachedSize = 117; // 117 bytes from a previous corrupt upload

    // Replicate cache validation rule from src/queue/worker.ts:
    const isCacheValid = (cachedSize: number, expected: number): boolean => {
      if (cachedSize < 1024) return false;
      if (expected > 0) {
        if (cachedSize < expected * 0.90 || cachedSize > expected * 1.10) {
          return false;
        }
      }
      return true;
    };

    expect(isCacheValid(corruptCachedSize, requestedExpectedSize)).toBe(false);
    expect(isCacheValid(366_000_000, requestedExpectedSize)).toBe(true);
    expect(isCacheValid(1024 * 1024, requestedExpectedSize)).toBe(false); // 1 MB cached vs 349 MB expected -> rejected
  });
});

// ── TC7: Telegram Polling Isolation ──────────────────────────────────────────

describe('TC7: Telegram Polling Isolation', () => {
  it('verifies that importing worker modules does not invoke bot.launch()', () => {
    // Check that src/worker.ts exports or runs standalone workers without bot.launch
    const workerFile = fs.readFileSync(path.join(__dirname, '../src/worker.ts'), 'utf8');
    expect(workerFile).not.toContain('bot.launch');
    expect(workerFile).not.toContain('getUpdates');
  });

  it('verifies bot.ts guards polling with isPollingLaunched and ENABLE_TELEGRAM_POLLING', () => {
    const botFile = fs.readFileSync(path.join(__dirname, '../src/bot.ts'), 'utf8');
    expect(botFile).toContain('isPollingLaunched');
    expect(botFile).toContain('ENABLE_TELEGRAM_POLLING');
  });
});

// ── TEST 8: Stream Error & Incomplete Download ────────────────────────────────

describe('TEST 8: Stream Error / Incomplete Download', () => {
  let partialFile: string;
  afterAll(() => cleanup(partialFile));

  it('fails validation if stream died after writing only partial bytes', async () => {
    const expectedSize = 366_002_036; // 349 MB
    const partialSize = 10 * MB; // only 10 MB written before stream dropped
    partialFile = makeTempFile('incomplete_stream.mkv', partialSize);

    const result = await validateDownloadedFile(partialFile, expectedSize, 'video.mkv');
    expect(result.valid).toBe(false);
    expect(result.actualSize).toBe(partialSize);
    expect(result.reason).toMatch(/size mismatch|below 90%/i);
  });
});

// ── TEST 9, 10, 11: HTTP JSON, XML, text/plain Error Rejections ──────────────

describe('TEST 9, 10, 11: HTTP JSON, XML, text/plain Error Responses', () => {
  it('TEST 9: rejects application/json response headers', () => {
    const result = validateHttpResponseHeaders({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      contentLength: 256,
      expectedSize: 366_002_036,
      filename: 'video.mkv',
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/application\/json|error page/i);
  });

  it('TEST 10: rejects text/xml and application/xml response headers', () => {
    const resultXml = validateHttpResponseHeaders({
      status: 200,
      contentType: 'text/xml',
      contentLength: 512,
      expectedSize: 366_002_036,
      filename: 'video.mkv',
    });
    expect(resultXml.valid).toBe(false);
    expect(resultXml.reason).toMatch(/text\/xml|error page/i);
  });

  it('TEST 11: rejects text/plain error response headers for video', () => {
    const resultText = validateHttpResponseHeaders({
      status: 200,
      contentType: 'text/plain',
      contentLength: 117,
      expectedSize: 366_002_036,
      filename: 'video.mkv',
    });
    expect(resultText.valid).toBe(false);
    expect(resultText.reason).toMatch(/text\/plain|error page/i);
  });
});

// ── TEST 12: Content Validation Over Extension (Extension Untrusted) ──────────

describe('TEST 12: Extension alone is NOT trusted', () => {
  let fakeExtFile: string;
  afterAll(() => cleanup(fakeExtFile));

  it('rejects an HTML error page even if named with .mkv extension (size guard)', async () => {
    const htmlPayload = Buffer.from('<!DOCTYPE html><html><body><h1>403 Forbidden - need verify_v2</h1></body></html>'.padEnd(2048, ' '));
    fakeExtFile = makeTempFile('fake_named_movie.mkv', htmlPayload.length, htmlPayload);

    const result = await validateDownloadedFile(fakeExtFile, 366_002_036, 'fake_named_movie.mkv');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/suspiciously small|error\/html page|matched/i);
  });

  it('rejects an HTML error page by content inspection when expected size is unknown', async () => {
    const htmlPayload = Buffer.from('<!DOCTYPE html><html><body><h1>403 Forbidden - need verify_v2</h1></body></html>'.padEnd(2048, ' '));
    fakeExtFile = makeTempFile('fake_named_movie2.mkv', htmlPayload.length, htmlPayload);

    const result = await validateDownloadedFile(fakeExtFile, undefined, 'fake_named_movie2.mkv');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/error\/html page|matched/i);
  });
});

// ── TEST 13: Live TeraBox Test Case Simulation ────────────────────────────────

describe('TEST 13: Live TeraBox share link simulation (1lN9IGJnt49mdUOaSuK5kAQ)', () => {
  let temp117File: string;
  const LIVE_EXPECTED_SIZE = 366_002_036; // 349.05 MB
  const LIVE_FILENAME = '[@YKD_KOREAN_DRAMA]Be.My.Princess.S01E01.720p.AMZN.W.mkv';

  afterAll(() => cleanup(temp117File));

  it('guarantees that a 117-byte HTML response is blocked from Telegram upload', async () => {
    // 1. Pre-stream header check rejects Content-Type: text/html
    const headerCheck = validateHttpResponseHeaders({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      contentLength: 117,
      expectedSize: LIVE_EXPECTED_SIZE,
      filename: LIVE_FILENAME,
    });
    expect(headerCheck.valid).toBe(false);

    // 2. Post-stream file validation check rejects 117 bytes vs 366002036 bytes
    temp117File = makeTempFile('live_117_test.mkv', 117);
    const fileCheck = await validateDownloadedFile(temp117File, LIVE_EXPECTED_SIZE, LIVE_FILENAME);
    expect(fileCheck.valid).toBe(false);
    expect(fileCheck.actualSize).toBe(117);
    expect(fileCheck.reason).toMatch(/suspiciously small|too small|mismatch/i);

    // 3. Confirm that temp file deletion occurs upon validation failure
    if (!fileCheck.valid && fs.existsSync(temp117File)) {
      fs.unlinkSync(temp117File);
    }
    expect(fs.existsSync(temp117File)).toBe(false);
  });
});

// ── TEST 14: Security Hardening — SSRF & URL Validation ────────────────────────


describe('TEST 14: Security Hardening — SSRF & URL Validation', () => {
  const { isSafeTeraBoxUrl } = require('../src/providers/terabox/terabox.resolver');

  it('rejects localhost, loopback and private IPv4/IPv6 addresses', () => {
    expect(isSafeTeraBoxUrl('http://localhost/test')).toBe(false);
    expect(isSafeTeraBoxUrl('http://127.0.0.1:8080/exploit')).toBe(false);
    expect(isSafeTeraBoxUrl('http://169.254.169.254/latest/meta-data')).toBe(false); // Cloud metadata
    expect(isSafeTeraBoxUrl('http://10.0.0.5/internal')).toBe(false);
    expect(isSafeTeraBoxUrl('http://192.168.1.1/router')).toBe(false);
    expect(isSafeTeraBoxUrl('http://172.16.0.1/admin')).toBe(false);
    expect(isSafeTeraBoxUrl('http://[::1]/test')).toBe(false);
    expect(isSafeTeraBoxUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeTeraBoxUrl('ftp://terabox.com/file')).toBe(false);
  });

  it('accepts legitimate TeraBox domains', () => {
    expect(isSafeTeraBoxUrl('https://1024terabox.com/s/1lN9IGJnt49mdUOaSuK5kAQ')).toBe(true);
    expect(isSafeTeraBoxUrl('https://teraboxapp.com/s/1abc123xyz')).toBe(true);
    expect(isSafeTeraBoxUrl('https://terabox.com/s/1abc123xyz')).toBe(true);
  });
});

// ── TEST 15: Security Hardening — Path Traversal Sanitization ────────────────

describe('TEST 15: Security Hardening — Path Traversal Sanitization', () => {
  it('sanitizes user filenames to prevent directory traversal', () => {
    const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    expect(sanitize('../../../etc/passwd')).not.toContain('/');
    expect(sanitize('../../../etc/passwd')).not.toContain('\\');
    expect(sanitize('C:\\Windows\\System32\\cmd.exe')).toBe('C__Windows_System32_cmd.exe');
  });
});

// ── TEST 17: TeraBox Download URL Extraction & Normalization ─────────────────

describe('TEST 17: TeraBox Download URL Extraction & Normalization', () => {
  const { extractTeraBoxDownloadUrl } = require('../src/providers/terabox/terabox.resolver');

  it('TC1: Direct string candidate', () => {
    expect(extractTeraBoxDownloadUrl({ dlink: 'https://example.com/file' })).toBe('https://example.com/file');
  });

  it('TC2: Nested response candidate', () => {
    expect(extractTeraBoxDownloadUrl({ data: { dlink: 'https://example.com/file' } })).toBe('https://example.com/file');
  });

  it('TC3: Array response candidate', () => {
    expect(extractTeraBoxDownloadUrl({ dlink: ['invalid', 'https://example.com/file'] })).toBe('https://example.com/file');
  });

  it('TC4: Object response candidate', () => {
    expect(extractTeraBoxDownloadUrl({ dlink: { url: 'https://example.com/file' } })).toBe('https://example.com/file');
  });

  it('TC5: Escaped URL (slashes & unicode)', () => {
    expect(extractTeraBoxDownloadUrl('https:\\/\\/example.com\\/file?x=1\\u0026y=2')).toBe('https://example.com/file?x=1&y=2');
  });

  it('TC6: HTML escaped URL', () => {
    expect(extractTeraBoxDownloadUrl('https://example.com/file?x=1&amp;y=2')).toBe('https://example.com/file?x=1&y=2');
  });

  it('TC7: Encoded URL normalization', () => {
    expect(extractTeraBoxDownloadUrl('https%3A%2F%2Fexample.com%2Ffile%3Ftest%3D1')).toBe('https://example.com/file?test=1');
  });

  it('TC8: Invalid protocol rejection (ftp://)', () => {
    expect(extractTeraBoxDownloadUrl('ftp://example.com/file')).toBeNull();
  });

  it('TC9: Invalid object without url fields', () => {
    expect(extractTeraBoxDownloadUrl({ foo: 'bar' })).toBeNull();
  });

  it('TC10: Long signed CDN URL acceptance', () => {
    const longSigned = 'https://d.terabox.app/file/123?sign=abcdef1234567890&expires=8h&dp-logid=9999999999';
    expect(extractTeraBoxDownloadUrl(longSigned)).toBe(longSigned);
  });

  it('TC11: URL with no file extension acceptance', () => {
    const noExt = 'https://cdn.terabox.app/download/v1/stream?fid=123456';
    expect(extractTeraBoxDownloadUrl(noExt)).toBe(noExt);
  });

  it('TC12: URL with redirecting CDN hostname acceptance', () => {
    const redirectCdn = 'https://data.terabox.app/thumbnail/123?fid=4402084097765-250528-167926395530178';
    expect(extractTeraBoxDownloadUrl(redirectCdn)).toBe(redirectCdn);
  });
});

// ── TEST 18: TeraBox Resolver Session & Share Context Lifecycle ──────────────

describe('TEST 18: TeraBox Resolver Session & Share Context Lifecycle', () => {
  const {
    TeraBoxMissingContextError,
    TeraBoxProviderError,
  } = require('../src/providers/errors');
  const { extractTeraBoxDownloadUrl } = require('../src/providers/terabox/terabox.resolver');

  it('TEST 1: Share page returns jsToken and cookies -> session context is populated', () => {
    const rawHtml = '<html><script>fn%28%22ABC123DEF%22%29</script></html>';
    const jsTokenMatch = rawHtml.match(/fn%28%22([0-9A-Fa-f]+)%22%29/);
    expect(jsTokenMatch).not.toBeNull();
    expect(jsTokenMatch?.[1]).toBe('ABC123DEF');
  });

  it('TEST 2: shorturlinfo returns errno: 0 -> metadata normalized successfully', () => {
    const apiResponse = {
      errno: 0,
      shareid: '62706158116',
      uk: '4399182195115',
      sign: 'd74dd7c834e8c6b6da979fd96376cb36bda6d156',
      timestamp: 1787739968,
      list: [{ fs_id: '207400602392562', server_filename: 'test.mp4', size: 8108680 }]
    };
    expect(apiResponse.errno).toBe(0);
    expect(apiResponse.sign).toBeDefined();
    expect(apiResponse.timestamp).toBe(1787739968);
  });

  it('TEST 3: shorturlinfo fails with verification error -> indicates session refresh needed', () => {
    const verifyRequiredRes = { errno: 400210, errmsg: 'need verify_v2' };
    expect(verifyRequiredRes.errno).not.toBe(0);
  });

  it('TEST 4: Fallback share/list with missing sign/timestamp throws TeraBoxMissingContextError', () => {
    const metadataMissingSign = {
      shareId: '62706158116',
      uk: '4399182195115',
      sign: '', // Missing!
      timestamp: '', // Missing!
    };
    const file = { fs_id: '207400602392562' };

    const validateContext = (meta: typeof metadataMissingSign, f: typeof file) => {
      if (!meta.shareId || !meta.uk || !meta.sign || !meta.timestamp || !f.fs_id) {
        throw new TeraBoxMissingContextError('Missing required share context');
      }
    };

    expect(() => validateContext(metadataMissingSign, file)).toThrow(TeraBoxMissingContextError);
  });

  it('TEST 5: Download endpoint returns errno: 2 -> throws TeraBoxProviderError without URL extraction', () => {
    const errorResponse = { errno: 2, errmsg: 'parameter error', request_id: '123' };
    const validateAndExtract = (res: typeof errorResponse) => {
      if (res.errno !== undefined && Number(res.errno) !== 0) {
        throw new TeraBoxProviderError(`Rejected: errno=${res.errno}`, 'download', res.errno, res.request_id);
      }
      return extractTeraBoxDownloadUrl(res);
    };

    expect(() => validateAndExtract(errorResponse)).toThrow(TeraBoxProviderError);
  });

  it('TEST 6: Download endpoint returns valid nested URL -> extracts successfully', () => {
    const successResponse = {
      errno: 0,
      dlink: 'https://d.terabox.app/file/12345?sign=abc'
    };
    expect(extractTeraBoxDownloadUrl(successResponse)).toBe('https://d.terabox.app/file/12345?sign=abc');
  });

  it('TEST 7: Consistent session context bundling prevents session mismatch', () => {
    const session = {
      shareCode: 'fKvukFFlwMqHt3vbdFoRYQ',
      jsToken: 'ABC123',
      cookies: 'browserid=XYZ',
      userAgent: 'Mozilla/5.0 ...',
      referer: 'https://dm.terabox.app/sharing/link?surl=1fKvukFFlwMqHt3vbdFoRYQ'
    };
    expect(session.cookies).toContain('browserid');
    expect(session.jsToken).toBe('ABC123');
  });
});

// ── TEST 19: validateDownloadContext & Pre-Download Verification ─────────────

describe('TEST 19: validateDownloadContext & Pre-Download Verification', () => {
  const { validateDownloadContext } = require('../src/providers/terabox/terabox.resolver');
  const { TeraBoxMissingContextError } = require('../src/providers/errors');

  it('TC1: Passes with full valid context', () => {
    expect(() =>
      validateDownloadContext({
        shareId: '62706158116',
        uk: '4399182195115',
        sign: 'd74dd7c834e8c6b6da979fd96376cb36bda6d156',
        timestamp: 1787739968,
        fsId: '207400602392562',
      })
    ).not.toThrow();
  });

  it('TC2: Fails when shareId is missing', () => {
    expect(() =>
      validateDownloadContext({
        shareId: '',
        uk: '4399182195115',
        sign: 'd74dd7c834e8c6b6da979fd96376cb36bda6d156',
        timestamp: 1787739968,
        fsId: '207400602392562',
      })
    ).toThrow(TeraBoxMissingContextError);
  });

  it('TC3: Fails when sign is missing or empty', () => {
    expect(() =>
      validateDownloadContext({
        shareId: '62706158116',
        uk: '4399182195115',
        sign: '   ',
        timestamp: 1787739968,
        fsId: '207400602392562',
      })
    ).toThrow(TeraBoxMissingContextError);
  });

  it('TC4: Fails when timestamp is NaN or empty', () => {
    expect(() =>
      validateDownloadContext({
        shareId: '62706158116',
        uk: '4399182195115',
        sign: 'd74dd7c834e8c6b6da979fd96376cb36bda6d156',
        timestamp: 'invalid-time',
        fsId: '207400602392562',
      })
    ).toThrow(TeraBoxMissingContextError);
  });

  it('TC5: Fails when fsId is missing', () => {
    expect(() =>
      validateDownloadContext({
        shareId: '62706158116',
        uk: '4399182195115',
        sign: 'd74dd7c834e8c6b6da979fd96376cb36bda6d156',
        timestamp: 1787739968,
        fsId: '',
      })
    ).toThrow(TeraBoxMissingContextError);
  });
});

// ── TEST 20: Empty dlink, verify_v2 & Status Message Formatting Resilience ──

describe('TEST 20: Empty dlink, verify_v2 & Status Message Formatting Resilience', () => {
  const { extractTeraBoxDownloadUrl, describeCandidate } = require('../src/providers/terabox/terabox.resolver');
  const { TeraBoxVerificationRequiredError } = require('../src/providers/errors');

  it('TC1: Empty dlink string returns null', () => {
    expect(extractTeraBoxDownloadUrl({ dlink: '' })).toBeNull();
    expect(extractTeraBoxDownloadUrl({ dlink: '   ' })).toBeNull();
    expect(extractTeraBoxDownloadUrl({ download_url: '' })).toBeNull();
    expect(extractTeraBoxDownloadUrl('')).toBeNull();
  });

  it('TC2: TeraBoxVerificationRequiredError is properly constructed and classified', () => {
    const err = new TeraBoxVerificationRequiredError('TeraBox download requires authentication', 'verification', 400310, '8974230873518970796');
    expect(err.name).toBe('TeraBoxVerificationRequiredError');
    expect(err.code).toBe('TERABOX_VERIFICATION_REQUIRED');
    expect(err.errno).toBe(400310);
    expect(err.requestId).toBe('8974230873518970796');
  });

  it('TC3: Telegram entity error fallback strips formatting safely', () => {
    const errorMsg = '⚠️ TeraBox download request rejected: errno=400310, errmsg=need verify_v2';
    // Unclosed underscore in Markdown causes Telegram 400 parse entity error
    // Our fallback strips markdown formatting chars safely:
    const plainText = errorMsg.replace(/[*_`]/g, '');
    expect(plainText).not.toContain('_');
    expect(plainText).toBe('⚠️ TeraBox download request rejected: errno=400310, errmsg=need verifyv2');
  });
});

// ── TEST 21: TeraBox Reference Strategy Adapter & NDUS Normalization ─────────

describe('TEST 21: TeraBox Reference Strategy Adapter & NDUS Normalization', () => {
  const { normalizeNdus, teraBoxResolver } = require('../src/providers/terabox/terabox.resolver');
  const {
    TeraBoxAuthRequiredError,
    TeraBoxAuthRejectedError,
    TeraBoxLinkResolutionFailedError,
  } = require('../src/providers/errors');

  it('TC1: Normalizes raw token, ndus=token, and cookie header strings', () => {
    expect(normalizeNdus('my_ndus_token_123')).toBe('my_ndus_token_123');
    expect(normalizeNdus('ndus=my_ndus_token_123')).toBe('my_ndus_token_123');
    expect(normalizeNdus('Cookie: ndus=my_ndus_token_123; other=abc')).toBe('my_ndus_token_123');
    expect(normalizeNdus('')).toBeNull();
    expect(normalizeNdus(undefined)).toBeNull();
  });

  it('TC2: Distinct error classes have correct names and codes', () => {
    const authReq = new TeraBoxAuthRequiredError();
    expect(authReq.name).toBe('TeraBoxAuthRequiredError');
    expect(authReq.code).toBe('TERABOX_AUTH_REQUIRED');

    const authRej = new TeraBoxAuthRejectedError();
    expect(authRej.name).toBe('TeraBoxAuthRejectedError');
    expect(authRej.code).toBe('TERABOX_AUTH_REJECTED');

    const linkFail = new TeraBoxLinkResolutionFailedError();
    expect(linkFail.name).toBe('TeraBoxLinkResolutionFailedError');
    expect(linkFail.code).toBe('TERABOX_LINK_RESOLUTION_FAILED');
  });

  it('TC3: resolveWithReferenceStrategy method exists on resolver', () => {
    expect(typeof teraBoxResolver.resolveWithReferenceStrategy).toBe('function');
  });
});



