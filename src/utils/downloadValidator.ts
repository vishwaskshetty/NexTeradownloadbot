import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface ValidationResult {
  valid: boolean;
  actualSize: number;
  reason?: string;
}

// ── Size tolerance constants ───────────────────────────────────────────────────
const SIZE_TOLERANCE_LOWER = 0.90; // actual must be >= 90% of expected
const SMALL_FILE_ABSOLUTE_MIN = 1024; // 1 KB absolute floor for media/archive files
const SUSPICIOUS_THRESHOLD = 1024 * 1024; // If expected > 1 MB, actual < 1 MB is auto-reject

/**
 * Content signatures that indicate an HTML/JSON/XML error page
 * rather than a valid binary download. Checked against the first 256 bytes.
 */
const TEXT_ERROR_SIGNATURES = [
  '{"errno"', '{"error"', '{"status"', '{"msg"', '{"code"',
  '{"errmsg"', '{"ret"', '{"result"',
  '<?xml', '<?XML', '<!doctype', '<!DOCTYPE',
  '<html', '<HTML', '<body', '<BODY', '<head', '<HEAD',
  'Access Denied', 'Unauthorized', 'Forbidden',
  '400 Bad Request', '401 Unauthorized', '403 Forbidden',
  '404 Not Found', '500 Internal',
];

/** Extensions expected to be text-based — skip binary checks for these */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.json', '.html', '.htm', '.xml', '.csv',
  '.log', '.md', '.srt', '.vtt', '.ass', '.ssa',
]);

export function formatBytes(bytes: number | bigint): string {
  const num = Number(bytes);
  if (!num || num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.max(num, 1)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Authoritative download file validator.
 *
 * Must be called AFTER the write stream has fully closed and renamed.
 * Returns { valid: false, reason } for ANY of:
 *  - File missing / unreadable
 *  - Actual size = 0
 *  - Actual size < 1 KB for non-text files
 *  - Expected > 1 MB but actual < 1 MB  (suspicious small — error page)
 *  - Actual < 90% of expected size
 *  - First bytes match HTML/JSON/XML error signatures
 *  - Magic-byte mismatch for known formats (files > 1 MB)
 */
export async function validateDownloadedFile(
  filePath: string,
  expectedSize?: number,
  filename?: string,
): Promise<ValidationResult> {

  // Guard 1: File must exist
  if (!fs.existsSync(filePath)) {
    return { valid: false, actualSize: 0, reason: 'Temporary file does not exist after download.' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (e: any) {
    return { valid: false, actualSize: 0, reason: `Cannot stat file: ${e.message}` };
  }

  const actualSize = stat.size;
  const ext = path.extname(filename || filePath).toLowerCase();
  const isTextFile = TEXT_EXTENSIONS.has(ext);

  // Guard 2: Non-zero
  if (actualSize === 0) {
    return { valid: false, actualSize, reason: 'Downloaded file is empty (0 bytes).' };
  }

  // Guard 3: Absolute minimum for non-text files
  if (!isTextFile && actualSize < SMALL_FILE_ABSOLUTE_MIN) {
    return {
      valid: false, actualSize,
      reason: `File too small: ${actualSize} B. Minimum for media/archive is ${SMALL_FILE_ABSOLUTE_MIN} B.`,
    };
  }

  // Guard 4: Size vs expectedSize
  if (expectedSize && expectedSize > 0) {
    if (expectedSize > SUSPICIOUS_THRESHOLD && actualSize < SUSPICIOUS_THRESHOLD) {
      return {
        valid: false, actualSize,
        reason: `Suspiciously small: expected ${formatBytes(expectedSize)} but got ${formatBytes(actualSize)}. Likely an error page, not the real file.`,
      };
    }
    if (actualSize < expectedSize * SIZE_TOLERANCE_LOWER) {
      const pct = Math.round((actualSize / expectedSize) * 100);
      return {
        valid: false, actualSize,
        reason: `Size mismatch: expected ${formatBytes(expectedSize)}, downloaded ${formatBytes(actualSize)} (${pct}% — below 90% threshold).`,
      };
    }
    if (actualSize > expectedSize * 1.10) {
      logger.warn(`[Validation] File larger than expected: ${formatBytes(actualSize)} vs ${formatBytes(expectedSize)}. Proceeding.`);
    }
  }

  // Guard 5: Read first 512 bytes for content inspection
  let headerBuf: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    const raw = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, raw, 0, 512, 0);
    fs.closeSync(fd);
    headerBuf = raw.subarray(0, bytesRead);
  } catch (e: any) {
    return { valid: false, actualSize, reason: `Cannot read file header: ${e.message}` };
  }

  const headerStr = headerBuf.toString('utf8', 0, Math.min(headerBuf.length, 256)).trimStart();

  // Guard 6: Reject HTML/JSON/XML error page content
  if (!isTextFile) {
    for (const sig of TEXT_ERROR_SIGNATURES) {
      if (headerStr.includes(sig)) {
        const preview = headerStr.substring(0, 100).replace(/[\n\r]/g, ' ');
        return {
          valid: false, actualSize,
          reason: `Content is an error/HTML page (matched: "${sig}"). First bytes: "${preview}"`,
        };
      }
    }
  }

  // Guard 7: Magic-byte header checks for specific formats (only > 1 MB)
  if (!isTextFile && actualSize >= SUSPICIOUS_THRESHOLD) {
    const magicErr = checkMagicBytes(headerBuf, ext);
    if (magicErr) return { valid: false, actualSize, reason: magicErr };
  }

  return { valid: true, actualSize };
}

function checkMagicBytes(buf: Buffer, ext: string): string | null {
  if (ext === '.mp4' || ext === '.m4v' || ext === '.m4a') {
    const ftypIdx = buf.indexOf('ftyp');
    if (ftypIdx === -1 || ftypIdx > 32) {
      return `${ext} file missing ftyp box in first 32 bytes (found at index: ${ftypIdx}).`;
    }
  } else if (ext === '.mkv' || ext === '.webm') {
    if (buf[0] !== 0x1A || buf[1] !== 0x45 || buf[2] !== 0xDF || buf[3] !== 0xA3) {
      return `${ext} file missing EBML header. Got: ${buf.slice(0, 4).toString('hex')}`;
    }
  } else if (ext === '.zip') {
    if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
      return `.zip file missing PK header. Got: ${buf.slice(0, 4).toString('hex')}`;
    }
  } else if (ext === '.rar') {
    if (buf[0] !== 0x52 || buf[1] !== 0x61 || buf[2] !== 0x72 || buf[3] !== 0x21) {
      return `.rar file missing Rar! header. Got: ${buf.slice(0, 4).toString('hex')}`;
    }
  } else if (ext === '.7z') {
    if (buf[0] !== 0x37 || buf[1] !== 0x7A || buf[2] !== 0xBC || buf[3] !== 0xAF) {
      return `.7z file missing 7z header. Got: ${buf.slice(0, 4).toString('hex')}`;
    }
  } else if (ext === '.pdf') {
    if (buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46) {
      return `.pdf file missing %PDF header. Got: ${buf.slice(0, 4).toString('hex')}`;
    }
  }
  return null;
}

/**
 * Validates HTTP response headers BEFORE streaming the body.
 * Prevents saving HTML/JSON error pages to disk.
 */
export function validateHttpResponseHeaders(params: {
  status: number;
  contentType: string;
  contentLength: number;
  expectedSize?: number;
  filename?: string;
}): { valid: boolean; reason?: string } {
  const { status, contentType, contentLength, expectedSize, filename } = params;
  const ct = (contentType || '').toLowerCase().trim();
  const ext = path.extname(filename || '').toLowerCase();
  const isTextFile = TEXT_EXTENSIONS.has(ext);

  // HTTP status guard
  if (status < 200 || status >= 400) {
    return { valid: false, reason: `HTTP ${status} — server rejected the download request.` };
  }

  if (!isTextFile) {
    const rejectedTypes = [
      'text/html', 'text/plain', 'application/json',
      'application/xml', 'text/xml', 'text/javascript',
    ];
    for (const bad of rejectedTypes) {
      if (ct.startsWith(bad) || ct.includes(bad)) {
        return {
          valid: false,
          reason: `Server returned Content-Type: ${contentType} for a media file. Likely an error page, not the real file.`,
        };
      }
    }

    // Content-Length suspiciously small vs expected
    if (contentLength > 0 && expectedSize && expectedSize > SUSPICIOUS_THRESHOLD && contentLength < SUSPICIOUS_THRESHOLD) {
      return {
        valid: false,
        reason: `Content-Length ${contentLength} is suspiciously small vs expected ${formatBytes(expectedSize)}. Aborting download.`,
      };
    }
  }

  return { valid: true };
}
