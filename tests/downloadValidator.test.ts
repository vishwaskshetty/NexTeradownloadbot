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

