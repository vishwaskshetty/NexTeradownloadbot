import { Worker, Job } from 'bullmq';
import { redis } from '../redis';
import { db } from '../db';
import { jobService } from '../services/JobService';
import { usageService } from '../services/UsageService';
import { providerRegistry } from '../providers';
import {
  ProviderError,
  ProviderAccessError,
  TeraBoxVerificationRequiredError,
  TeraBoxAuthRequiredError,
  TeraBoxAuthRejectedError,
  TeraBoxLinkResolutionFailedError,
  TeraBoxGatewaySessionExpiredError,
  TeraBoxGatewayVerificationFailedError,
  TeraBoxGatewayVerificationSessionError,
} from '../providers/errors';
import { logger } from '../utils/logger';
import {
  validateDownloadedFile,
  validateHttpResponseHeaders,
  formatBytes,
  ValidationResult,
} from '../utils/downloadValidator';
import {
  clearTeraBoxShareCache,
  extractShareCode,
  normalizeGatewayUrl,
  extractTeraBoxDownloadUrl,
  buildPublicVerificationUrl,
} from '../providers/terabox/terabox.resolver';
import { bot } from '../bot';
import { config } from '../config';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let downloadWorker: Worker | null = null;

/**
 * Smart media detection helper:
 * Selects the appropriate Telegram media method (sendVideo, sendAudio, sendPhoto, sendDocument)
 * based on original file extension and MIME type.
 * Automatically falls back to sendDocument if Telegram fails to process as native media.
 */
const sendMediaToTelegram = async (
  telegramId: string,
  mediaSource: string | { source: string; filename: string },
  filename: string,
  caption?: string,
  mimeType?: string
) => {
  const ext = path.extname(filename).toLowerCase();

  const videoExts = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.3gp'];
  const audioExts = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'];
  const photoExts = ['.jpg', '.jpeg', '.png', '.webp'];

  let targetType: 'video' | 'audio' | 'photo' | 'document' = 'document';
  if (videoExts.includes(ext) || (mimeType && mimeType.startsWith('video/'))) {
    targetType = 'video';
  } else if (audioExts.includes(ext) || (mimeType && mimeType.startsWith('audio/'))) {
    targetType = 'audio';
  } else if (photoExts.includes(ext) || (mimeType && mimeType.startsWith('image/'))) {
    targetType = 'photo';
  }

  const extraOptions = {
    caption,
    parse_mode: 'Markdown' as const,
  };

  if (targetType === 'video') {
    try {
      return await bot.telegram.sendVideo(telegramId, mediaSource, extraOptions);
    } catch (videoErr: any) {
      logger.warn(`sendVideo failed for ${filename}, falling back to sendDocument: ${videoErr.message}`);
      return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
    }
  }

  if (targetType === 'audio') {
    try {
      return await bot.telegram.sendAudio(telegramId, mediaSource, extraOptions);
    } catch (audioErr: any) {
      logger.warn(`sendAudio failed for ${filename}, falling back to sendDocument: ${audioErr.message}`);
      return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
    }
  }

  if (targetType === 'photo') {
    try {
      return await bot.telegram.sendPhoto(telegramId, mediaSource, extraOptions);
    } catch (photoErr: any) {
      logger.warn(`sendPhoto failed for ${filename}, falling back to sendDocument: ${photoErr.message}`);
      return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
    }
  }

  return await bot.telegram.sendDocument(telegramId, mediaSource, extraOptions);
};

/**
 * Downloads a direct URL to disk via streaming with pre-stream header validation.
 *
 * Validates BEFORE streaming:
 *   - HTTP status must be 2xx
 *   - Content-Type must not be text/html, application/json, etc. for media files
 *   - Content-Length must not be suspiciously small vs expectedSize
 *
 * Streams to a .part file, renames to final path only on success.
 */
const downloadFileStream = async (
  url: string,
  destPath: string,
  headers?: Record<string, string>,
  expectedSize?: number,
  filename?: string
): Promise<number> => {
  const partPath = `${destPath}.part`;
  const parsedUrl = new URL(url);
  // Log only hostname — never log signed URLs, tokens, or cookies
  logger.info(`[Download] Requested URL hostname: ${parsedUrl.hostname}`);

  const requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.terabox.app/',
    'Accept': '*/*',
    ...(headers || {})
  };

  if (config.TERABOX_NDUS && !requestHeaders['Cookie']) {
    requestHeaders['Cookie'] = `ndus=${config.TERABOX_NDUS}`;
  }

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 120000, // 2 minutes for large files
    headers: requestHeaders,
    maxRedirects: 10,
  });

  const contentType = String(response.headers['content-type'] || '');
  const contentLength = Number(response.headers['content-length'] || 0);
  const finalUrlHost = response.request?.res?.responseUrl
    ? new URL(response.request.res.responseUrl).hostname
    : parsedUrl.hostname;

  // ── Structured pre-stream diagnostic logging ───────────────────────────
  logger.info(`[Download] Final URL hostname: ${finalUrlHost}`);
  logger.info(`[Download] HTTP status: ${response.status}`);
  logger.info(`[Download] Content-Type: ${contentType || '(none)'}`);
  logger.info(`[Download] Content-Length: ${contentLength > 0 ? formatBytes(contentLength) : '(unknown)'}`);
  if (expectedSize) {
    logger.info(`[Download] Expected size: ${formatBytes(expectedSize)}`);
  }

  // ── Pre-stream header validation (blocks before any bytes are written) ─
  const headerCheck = validateHttpResponseHeaders({
    status: response.status,
    contentType,
    contentLength,
    expectedSize,
    filename,
  });

  if (!headerCheck.valid) {
    response.data.destroy?.();
    logger.error(`[Download] Pre-stream validation FAILED: ${headerCheck.reason}`);
    throw new Error(`Download rejected before streaming: ${headerCheck.reason}`);
  }

  // ── Stream to .part file ───────────────────────────────────────────────
  const writer = fs.createWriteStream(partPath);
  let downloadedBytes = 0;
  let lastLoggedMb = 0;

  response.data.on('data', (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    const mb = Math.floor(downloadedBytes / (50 * 1024 * 1024)) * 50;
    if (mb > lastLoggedMb) {
      logger.info(`[Download] Received: ${formatBytes(downloadedBytes)}`);
      lastLoggedMb = mb;
    }
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      logger.info(`[Download] Stream completed. Total received: ${formatBytes(downloadedBytes)}`);
      try {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        fs.renameSync(partPath, destPath);
        resolve(downloadedBytes);
      } catch (renameErr) {
        reject(renameErr);
      }
    });
    writer.on('error', (err) => {
      logger.error(`[Download] Stream error: ${err.message}`);
      if (fs.existsSync(partPath)) {
        try { fs.unlinkSync(partPath); } catch (e) {}
      }
      reject(err);
    });
  });
};

export const initWorker = () => {
  if (downloadWorker) return;
  
  const processJob = async (job: Job) => {
    const { jobId, url, userId, fsId, statusMessageId } = job.data;
    const jobRecord = await jobService.getJobWithUser(jobId);
    const user = jobRecord?.user;
    const telegramId = user?.telegramId?.toString();
    
    let tempFilePath: string | null = null;

    // SINGLE STATUS MESSAGE EDITING HELPER
    const updateStatusMessage = async (text: string, keyboard?: any) => {
      if (!telegramId || !statusMessageId) return;
      try {
        await bot.telegram.editMessageText(telegramId, statusMessageId, undefined, text, {
          parse_mode: 'Markdown',
          ...(keyboard || {})
        });
      } catch (err: any) {
        if (err.message?.includes("can't parse entities") || err.message?.includes('entity')) {
          try {
            // Strip markdown formatting symbols and send as plain text
            const plainText = text.replace(/[*_`]/g, '');
            await bot.telegram.editMessageText(telegramId, statusMessageId, undefined, plainText, {
              ...(keyboard || {})
            });
            return;
          } catch (plainErr) {}
        }
        if (!err.message?.includes('message is not modified') && !err.message?.includes('message to edit not found')) {
          logger.warn(`Could not edit status message ${statusMessageId}: ${err.message}`);
        }
      }
    };

    try {
      if (!user) {
        throw new Error(`User associated with job ${jobId} not found.`);
      }

      // Re-verify daily limit before proceeding to download
      const currentUsage = await usageService.getUsage(user.id);
      const dailyLimit = await usageService.getDailyLimit(user.plan);
      if (currentUsage.dailyRequests >= dailyLimit) {
        await updateStatusMessage(`🚫 *Daily limit reached.*\n\nFree users: ${config.FREE_DAILY_LIMIT} downloads/day.\nPremium users: ${config.PREMIUM_DAILY_LIMIT} downloads/day.\n\nNo usage was consumed.`);
        throw new ProviderError(`🚫 Daily limit reached (${dailyLimit} downloads/day).`);
      }

      // QUEUED -> PROCESSING
      await jobService.updateJobStatus(jobId, 'PROCESSING');
      
      const providerInfo = providerRegistry.detectAdapter(url);
      if (!providerInfo) {
        throw new Error('Provider not found for the given URL.');
      }
      
      const adapter = providerInfo.adapter;
      
      // Update single status message: Resolving
      await updateStatusMessage(
        `🔎 *Resolving link...*\n\n` +
        `🔗 Source: ${adapter.name}\n` +
        `⚡ Extracting file information...`
      );

      logger.info(`[Job] ${jobId} — provider: ${adapter.name} | url: ${url.substring(0, 60)}`);

      // ── Check PostgreSQL StoredFile Cache with strict size validation ──────
      const cacheKeyStr = fsId ? `${url}#fs_${fsId}` : url;
      const urlHash = crypto.createHash('sha256').update(cacheKeyStr).digest('hex');
      const cachedFile = await db.storedFile.findUnique({ where: { urlHash } });
      const cachedFileSize = Number(cachedFile?.fileSize || 0);

      if (cachedFile) {
        // Resolve metadata first so we can validate the cached size
        let metaForCache: any = null;
        try {
          const adapterInstance = adapter as any;
          metaForCache = typeof adapterInstance.resolveSelectedFile === 'function'
            ? await adapterInstance.resolveSelectedFile(url, fsId)
            : await adapter.resolve(url);
        } catch (e: any) {
          logger.warn(`[Cache] Could not resolve metadata for cache validation: ${e.message}`);
        }
        const expectedForCache = Number(metaForCache?.fileSize || 0);

        // Cache is valid only if:
        //  - not expired
        //  - cached size >= 1024 bytes
        //  - telegram file_id is present
        //  - if we know expected size: cached size must be within ±10% of expected
        const CACHE_SIZE_OK =
          cachedFileSize >= 1024 &&
          (
            !expectedForCache ||
            expectedForCache === 0 ||
            (
              cachedFileSize >= expectedForCache * 0.90 &&
              cachedFileSize <= expectedForCache * 1.10
            )
          );

        if (
          cachedFile.expiresAt > new Date() &&
          CACHE_SIZE_OK &&
          cachedFile.telegramFileId &&
          cachedFile.telegramFileId.trim() !== ''
        ) {
          logger.info(`[Cache] Cache hit | Cached=${formatBytes(cachedFileSize)} | Expected=${expectedForCache ? formatBytes(expectedForCache) : '?'}`);

          await updateStatusMessage(
            `📄 *File found*\n` +
            `📁 \`${cachedFile.fileName}\`\n` +
            `📦 ${formatBytes(cachedFile.fileSize || 0n)}\n\n` +
            `⚡ _Sending cached file..._`
          );

          // PROCESSING -> FILE_READY -> SENDING
          await jobService.updateJobStatus(jobId, 'FILE_READY');
          await jobService.updateJobStatus(jobId, 'SENDING');

          // Deliver cached file to user using smart media type helper
          await sendMediaToTelegram(
            telegramId!,
            cachedFile.telegramFileId,
            cachedFile.fileName,
            `✅ Download completed!\n🔗 Provider: ${adapter.name}\n⚡ Fast Cached Delivery`,
            cachedFile.mimeType || undefined
          );

          // ATOMIC COMPLETION: Increments usage ONLY ONCE upon successful delivery
          await jobService.completeJob(jobId, cachedFile.fileSize || 0n);
          const updatedUsage = await usageService.getUsage(user.id);
          const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

          const successMsg =
            `✅ *DOWNLOAD COMPLETE*\n\n` +
            `📁 File: \`${cachedFile.fileName}\`\n` +
            `📦 Size: ${formatBytes(cachedFile.fileSize || 0n)}\n` +
            `⚡ Provider: ${adapter.name}\n\n` +
            `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
            `📥 Remaining: ${remaining}`;

          await updateStatusMessage(successMsg);
          logger.info(`[Job] ${jobId} completed via cache.`);
          logger.info(`[Usage] Daily usage incremented for user ${user.id}.`);
          return; // Job is fully done
        } else {
          // Cache entry is invalid (expired, wrong size, or missing file_id) — delete it
          logger.warn(
            `[Cache] Invalidating cache entry | ` +
            `CachedSize=${formatBytes(cachedFileSize)} | ` +
            `ExpectedSize=${expectedForCache ? formatBytes(expectedForCache) : '?'} | ` +
            `SizeOK=${CACHE_SIZE_OK} | ` +
            `Expired=${cachedFile.expiresAt <= new Date()} | ` +
            `HasFileId=${Boolean(cachedFile.telegramFileId)}`
          );
          await db.storedFile.delete({ where: { id: cachedFile.id } }).catch(() => {});
        }
      } else {
        logger.info(`[Cache] Cache miss — proceeding with fresh download.`);
      }

      // ── Retry Loop: Fresh URL Resolution + Strict File Validation ──────────
      // CRITICAL: Before each attempt, bust the Redis share metadata cache so
      // TeraBox generates a completely fresh dlink (pre-signed URLs expire fast).
      let resolvedFile: any = null;
      let validation: ValidationResult | null = null;
      let validated = false;
      let validatedActualSize = 0;
      const maxRetries = 3;
      const tmpDir = path.join(os.tmpdir(), 'nexterabox');
      if (!fs.existsSync(tmpDir)) {
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
      }

      // Extract share code for cache busting (TeraBox-specific)
      const shareCode = extractShareCode(url);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        logger.info(`[Download] Attempt ${attempt}/${maxRetries}`);

        // Delete invalid temp file from previous failed attempt
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
          tempFilePath = null;
          logger.info(`[Download] Deleted invalid temporary file from attempt ${attempt - 1}`);
        }

        // CRITICAL: Bust the Redis share metadata cache before every attempt.
        // This forces resolveSelectedFile() to request a fresh dlink from TeraBox
        // instead of returning the expired URL from the 10-minute cache.
        if (shareCode) {
          await clearTeraBoxShareCache(shareCode);
        }

        // Resolve a completely fresh direct download URL from TeraBox
        const adapterInstance = adapter as any;
        try {
          resolvedFile = typeof adapterInstance.resolveSelectedFile === 'function'
            ? await adapterInstance.resolveSelectedFile(url, fsId)
            : await adapter.resolve(url);
        } catch (resolveErr: any) {
          // ── Gateway verification required: handle inline, do NOT fail the job ──
          const isVerificationError =
            resolveErr instanceof TeraBoxGatewayVerificationSessionError ||
            resolveErr?.code === 'TERABOX_GATEWAY_VERIFICATION_REQUIRED' ||
            resolveErr?.name === 'TeraBoxGatewayVerificationSessionError' ||
            (typeof resolveErr === 'object' && resolveErr !== null && Boolean(resolveErr.sessionId) && Boolean(resolveErr.verificationUrl));

          if (isVerificationError) {
            logger.info('[TeraBox Timing] worker_verification_started');
            const sessionId = String(resolveErr.sessionId);
            const verificationUrl = buildPublicVerificationUrl(sessionId, resolveErr.verificationUrl);

            logger.info(`[TeraBox Verification] session_received sessionId=${sessionId.substring(0, 8)}***`);

            // Send the verification button to the Telegram user
            const verificationMsg =
              `⚠️ *TeraBox Verification Required*\n\n` +
              `TeraBox requires browser verification before the file can be downloaded.\n\n` +
              `1\. Open the verification link below\n` +
              `2\. Complete the challenge in the browser\n` +
              `3\. The download will resume automatically\n\n` +
              `⏳ _Waiting up to 10 minutes..._`;

            const keyboard = {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🔐 Complete TeraBox Verification', url: verificationUrl },
                  ],
                ],
              },
            };
            await updateStatusMessage(verificationMsg, keyboard);
            logger.info(`[TeraBox Verification] user_prompt_sent`);

            // Poll gateway session until completed/expired, then call /complete
            const normalizedGwUrl = normalizeGatewayUrl(config.TERABOX_GATEWAY_URL);

            if (!normalizedGwUrl) {
              throw new TeraBoxGatewayVerificationSessionError(
                sessionId, verificationUrl,
                'Gateway URL not configured — cannot poll verification session',
                'verification'
              );
            }

            const pollTimeoutMs = 600000; // 10 minutes
            const pollIntervalMs = 5000;
            const pollStart = Date.now();
            let verificationCompleted = false;

            logger.info('[TeraBox Timing] verification_poll_started');
            logger.info(`[TeraBox Verification] polling_started sessionId=${sessionId.substring(0, 8)}***`);

            while (Date.now() - pollStart < pollTimeoutMs) {
              await new Promise(r => setTimeout(r, pollIntervalMs));

              try {
                const statusResp = await axios.get(
                  `${normalizedGwUrl}/api/verification/session/${encodeURIComponent(sessionId)}`,
                  { timeout: 10000, validateStatus: () => true }
                );
                const statusData = statusResp.data || {};
                const sessionStatus: string = statusData.status || '';
                logger.info(`[TeraBox Verification] state=${sessionStatus} sessionId=${sessionId.substring(0, 8)}***`);

                if (statusResp.status === 410 || sessionStatus === 'verification_expired' || (sessionStatus === 'error' && statusData.error === 'verification_expired')) {
                  throw new TeraBoxGatewaySessionExpiredError();
                }
                if (sessionStatus === 'verification_failed') {
                  throw new TeraBoxGatewayVerificationFailedError(statusData.message || 'Verification failed');
                }
                if (sessionStatus === 'verification_completed') {
                  verificationCompleted = true;
                  break;
                }
                // verification_pending / verification_in_progress — keep polling
              } catch (pollErr: any) {
                if (
                  pollErr instanceof TeraBoxGatewaySessionExpiredError ||
                  pollErr instanceof TeraBoxGatewayVerificationFailedError
                ) {
                  throw pollErr;
                }
                logger.warn(`[TeraBox Verification] poll transient error: ${pollErr.message}`);
              }
            }

            if (!verificationCompleted) {
              throw new TeraBoxGatewaySessionExpiredError('Verification session timed out after 10 minutes.');
            }

            // Verification complete — call /complete to get the direct URL
            logger.info(`[TeraBox Verification] completion_requested sessionId=${sessionId.substring(0, 8)}***`);
            const completeResp = await axios.post(
              `${normalizedGwUrl}/api/verification/complete`,
              { session_id: sessionId },
              { timeout: 30000, validateStatus: () => true }
            );

            if (completeResp.status === 410) {
              throw new TeraBoxGatewaySessionExpiredError();
            }
            if (completeResp.status === 409) {
              throw new TeraBoxGatewayVerificationFailedError('Verification complete call returned 409 — still pending');
            }

            const completeData = completeResp.data || {};
            if (completeResp.status !== 200 || completeData.status !== 'success') {
              throw new TeraBoxGatewayVerificationFailedError(
                completeData.message || `Completion endpoint returned HTTP ${completeResp.status}`
              );
            }

            // Extract direct URL from the completion response files
            const completeFiles: any[] = Array.isArray(completeData.files) ? completeData.files : [];
            const completedFile = (completeFiles.find((f: any) => String(f.fs_id) === String(fsId)) || completeFiles[0]) ?? {};
            const rawCompleteUrl =
              completedFile.direct_link ||
              completedFile.download_link ||
              completedFile.dlink ||
              completeData.direct_link ||
              completeData.download_link;
            const extractedUrl = extractTeraBoxDownloadUrl(rawCompleteUrl);

            if (!extractedUrl) {
              throw new TeraBoxGatewayVerificationFailedError('Completion response contained no valid direct download URL');
            }

            logger.info(`[TeraBox Verification] direct_resolution_success`);

            // Synthesise a resolvedFile so the download pipeline can continue normally
            resolvedFile = {
              fileName: completedFile.filename || completedFile.server_filename || 'terabox.file',
              fileSize: Number(completedFile.size_bytes || completedFile.size || 0),
              mimeType: undefined,
              fsId: String(fsId || ''),
              downloadUrl: extractedUrl,
              source: 'terabox-gateway-verified',
              sourceUrl: url,
              headers: {},
              isUnofficial: true,
            };
            // Continue to the download phase
            break;
          }

          // All other resolution errors
          logger.error(`[Download] Attempt ${attempt}: Failed to resolve URL — ${resolveErr.message}`);
          const isDeterministic =
            resolveErr.name === 'ProviderUnavailableError' ||
            resolveErr.name === 'InvalidUrlError' ||
            resolveErr.name === 'NotFoundError' ||
            resolveErr.name === 'TeraBoxVerificationRequiredError' ||
            resolveErr.name === 'TeraBoxAuthRequiredError' ||
            resolveErr.name === 'TeraBoxAuthRejectedError' ||
            resolveErr.name === 'TeraBoxLinkResolutionFailedError' ||
            resolveErr.name === 'TeraBoxMissingContextError' ||
            resolveErr.name === 'TeraBoxGatewaySessionExpiredError' ||
            resolveErr.name === 'TeraBoxGatewayVerificationFailedError' ||
            resolveErr.code === 'TERABOX_VERIFICATION_REQUIRED' ||
            resolveErr.code === 'TERABOX_AUTH_REQUIRED' ||
            resolveErr.code === 'TERABOX_AUTH_REJECTED' ||
            resolveErr.code === 'TERABOX_LINK_RESOLUTION_FAILED' ||
            resolveErr.code === 'TERABOX_GATEWAY_SESSION_EXPIRED' ||
            resolveErr.code === 'TERABOX_GATEWAY_VERIFICATION_FAILED';

          if (isDeterministic || attempt >= maxRetries) {
            throw resolveErr;
          }
          await new Promise(r => setTimeout(r, 3000 * attempt));
          continue;
        }

        const downloadUrl = resolvedFile.downloadUrl;
        if (typeof downloadUrl !== 'string' || !/^https?:\/\//i.test(downloadUrl)) {
          throw new ProviderAccessError(adapter.name, 'TeraBox returned no valid direct download URL.');
        }

        const filename = resolvedFile.fileName || 'downloaded_file';
        const expectedSize = Number(resolvedFile.fileSize || 0);

        logger.info(`[TeraBox] Share resolved | File: "${filename}" | Expected size: ${formatBytes(expectedSize)}`);

        // Update single status message: File found & Downloading
        await updateStatusMessage(
          `📄 *File found*\n` +
          `📁 \`${filename}\`\n` +
          `📦 ${formatBytes(expectedSize)}\n\n` +
          `⬇️ *Downloading...* (Attempt ${attempt}/${maxRetries})`
        );

        const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
        tempFilePath = path.join(tmpDir, `${jobId}_${attempt}_${safeName}`);

        // Attempt download — downloadFileStream validates headers BEFORE streaming
        try {
          await downloadFileStream(downloadUrl, tempFilePath, resolvedFile.headers, expectedSize, filename);
        } catch (dlErr: any) {
          logger.warn(`[Download] Attempt ${attempt} stream failed: ${dlErr.message}`);
          // Clean up the (possibly partial) file
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
            tempFilePath = null;
          }
          const partPath = `${tempFilePath}.part`;
          if (partPath && fs.existsSync(partPath)) {
            try { fs.unlinkSync(partPath); } catch (e) {}
          }
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 3000 * attempt));
            continue;
          }
          // All retries exhausted via stream failure
          throw dlErr;
        }

        // ── Post-stream file validation ──────────────────────────────────────
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          validation = await validateDownloadedFile(tempFilePath, expectedSize, filename);

          logger.info(
            `[Validation] Attempt ${attempt} | ` +
            `Expected=${formatBytes(expectedSize)} | ` +
            `Actual=${formatBytes(validation.actualSize)} | ` +
            `Valid=${validation.valid}`
          );

          if (validation.valid) {
            logger.info(`[Validation] Size validation: PASS | Content validation: PASS`);
            validated = true;
            validatedActualSize = validation.actualSize;
            break; // Valid file — exit retry loop
          }

          logger.error(
            `[Validation] FAILED on attempt ${attempt} | ` +
            `Reason: ${validation.reason || 'unknown'}`
          );
        } else {
          logger.error(`[Download] Attempt ${attempt}: Temp file missing after stream completed.`);
          validation = { valid: false, actualSize: 0, reason: 'Temp file missing after download.' };
        }

        // Clean up invalid file before retrying
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
          tempFilePath = null;
        }

        if (attempt < maxRetries) {
          logger.info(`[Download] Resolving fresh TeraBox URL for attempt ${attempt + 1}...`);
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      }

      // ── HARD FAILURE GATE (ABSOLUTE INVARIANT) ──────────────────────────
      // NO FILE MAY BE UPLOADED TO TELEGRAM UNTIL validation passes.
      if (!validated || !validation?.valid || !tempFilePath || !fs.existsSync(tempFilePath)) {
        const lastActualSize = validation?.actualSize ?? 0;
        const lastExpectedSize = resolvedFile ? Number(resolvedFile.fileSize || 0) : 0;
        const failReason = validation?.reason || 'Download failed validation after all retry attempts.';

        logger.error(`[Job] FAILED — all ${maxRetries} attempts failed validation.`);
        logger.error(`[Download] Expected: ${formatBytes(lastExpectedSize)}`);
        logger.error(`[Download] Last downloaded size: ${formatBytes(lastActualSize)}`);
        logger.error(`[Validation] Reason: ${failReason}`);
        logger.error(`[Validation] Telegram upload was BLOCKED.`);
        logger.error(`[Cache] Cache store BLOCKED.`);
        logger.error(`[Usage] Daily usage NOT incremented.`);

        // Clean up any remaining temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }

        await jobService.updateJobStatus(jobId, 'FAILED');

        const sizeDesc = lastExpectedSize > 0
          ? `Expected: ${formatBytes(lastExpectedSize)}\nLast downloaded size: ${formatBytes(lastActualSize)}`
          : `Last downloaded size: ${formatBytes(lastActualSize)}`;

        throw new Error(
          `Download failed after ${maxRetries} attempts.\n\n${sizeDesc}\n\nReason: Source server returned incomplete or invalid content. Telegram upload was blocked.`
        );
      }

      const filename = resolvedFile.fileName || 'downloaded_file';

      // AUTHORITATIVE FILESYSTEM SIZE CHECK (final double-check after validation passed)
      const finalStats = fs.statSync(tempFilePath);
      const finalActualSize = finalStats.size;
      logger.info(`[Download] Actual file size (fs.stat): ${formatBytes(finalActualSize)}`);

      // Status: PROCESSING -> FILE_READY
      await jobService.updateJobStatus(jobId, 'FILE_READY');

      // Update single status message: Uploading
      await updateStatusMessage(
        `📤 *Uploading to Telegram...*\n\n` +
        `📁 \`${filename}\`\n` +
        `📦 ${formatBytes(finalActualSize)}`
      );

      let sentToUser: any = null;

      // Status: FILE_READY -> SENDING
      await jobService.updateJobStatus(jobId, 'SENDING');

      logger.info(`[Telegram] Uploading validated file (${formatBytes(finalActualSize)}) — validation passed, upload authorized.`);

      // Upload file to Telegram storage channel cache if configured
      if (config.STORAGE_CHANNEL_ID) {
        try {
          logger.info(`[Telegram] Uploading actual file (${formatBytes(finalActualSize)}) to storage channel...`);
          const storedMessage = await bot.telegram.sendDocument(config.STORAGE_CHANNEL_ID!, {
            source: tempFilePath!,
            filename
          }, {
            caption: `Source: ${url}`
          });

          const telegramFileId = storedMessage.document?.file_id;
          if (!telegramFileId) {
            throw new Error('Telegram upload completed without a valid file_id.');
          }

          logger.info(`[Telegram] Upload successful. File ID: ${telegramFileId.substring(0, 10)}...`);
          logger.info(`[Telegram] Returned file size validated: ${formatBytes(finalActualSize)}`);

          // Send to user using cached telegramFileId and smart media helper
          sentToUser = await sendMediaToTelegram(
            telegramId!,
            telegramFileId,
            filename,
            `✅ Download completed!\n🔗 Provider: ${adapter.name}`,
            resolvedFile.mimeType
          );

          // Save to PostgreSQL Cache ONLY after valid file_id and validated size
          const expiresAt = new Date();
          expiresAt.setHours(expiresAt.getHours() + config.STORAGE_RETENTION_HOURS);
          
          await db.storedFile.upsert({
            where: { urlHash },
            update: {
              telegramFileId,
              telegramMessageId: storedMessage.message_id,
              expiresAt,
              fileName: filename,
              fileSize: BigInt(finalActualSize),
              mimeType: resolvedFile.mimeType,
              status: 'ACTIVE'
            },
            create: {
              urlHash,
              telegramFileId,
              telegramMessageId: storedMessage.message_id,
              expiresAt,
              fileName: filename,
              fileSize: BigInt(finalActualSize),
              mimeType: resolvedFile.mimeType,
              status: 'ACTIVE'
            }
          });

          logger.info(`[Cache] Valid Telegram file_id stored | fileName=${filename} | size=${formatBytes(finalActualSize)}`);
        } catch (storageErr: any) {
          logger.warn(`Storage channel caching failed: ${storageErr.message}. Falling back to direct user upload.`);
        }
      } 
      
      // If direct user upload is needed
      if (!sentToUser) {
        logger.info(`[Telegram] Uploading actual file (${formatBytes(finalActualSize)}) directly to user ${telegramId}...`);
        sentToUser = await sendMediaToTelegram(
          telegramId!,
          { source: tempFilePath!, filename },
          filename,
          `✅ Download completed!\n🔗 Provider: ${adapter.name}`,
          resolvedFile.mimeType
        );
        logger.info(`[Telegram] Direct upload successful.`);
      }

      // ATOMIC COMPLETION: Increments daily usage ONLY AFTER successful file delivery to user
      await jobService.completeJob(jobId, BigInt(finalActualSize));

      const updatedUsage = await usageService.getUsage(user.id);
      const remaining = Math.max(0, dailyLimit - updatedUsage.dailyRequests);

      logger.info(`[Job] ${jobId} completed successfully.`);
      logger.info(`[Usage] Daily usage incremented for user ${user.id} — ${updatedUsage.dailyRequests}/${dailyLimit}.`);

      // Final edit to the same single status message: Download Complete
      const finalSuccessMsg =
        `✅ *DOWNLOAD COMPLETE*\n\n` +
        `📁 File: \`${filename}\`\n` +
        `📦 Size: ${formatBytes(finalActualSize)}\n` +
        `⚡ Provider: ${adapter.name}\n\n` +
        `📊 Daily usage: ${updatedUsage.dailyRequests}/${dailyLimit}\n` +
        `📥 Remaining: ${remaining}`;

      await updateStatusMessage(finalSuccessMsg);

    } catch (error: any) {
      const isUploadError = error.message?.includes('sendVideo') || error.message?.includes('sendAudio') || error.message?.includes('sendDocument') || error.message?.includes('sendPhoto');
      
      let userMsg =
        `❌ *DOWNLOAD FAILED*\n\n` +
        `🔗 Source: TeraBox\n\n` +
        `⚠️ ${error.message || 'Unable to download this file completely.'}\n\n` +
        `No usage was consumed.`;

      if (isUploadError) {
        userMsg =
          `❌ *UPLOAD FAILED*\n\n` +
          `⚠️ The file could not be delivered to Telegram.\n\n` +
          `📊 Usage was not consumed.`;
      } else if (error instanceof TeraBoxAuthRequiredError || error.code === 'TERABOX_AUTH_REQUIRED') {
        userMsg =
          `⚠️ *TERABOX AUTHENTICATION REQUIRED*\n\n` +
          `TeraBox authentication is not configured.\nRequired configuration: TERABOX_NDUS\n\n` +
          `Your daily download limit was NOT used.`;
      } else if (error instanceof TeraBoxAuthRejectedError || error.code === 'TERABOX_AUTH_REJECTED') {
        userMsg =
          `⚠️ *TERABOX AUTHENTICATION REJECTED*\n\n` +
          `TeraBox rejected the configured account session (TERABOX_NDUS expired or invalid).\n\n` +
          `Your daily download limit was NOT used.`;
      } else if (error instanceof TeraBoxGatewaySessionExpiredError || error.code === 'TERABOX_GATEWAY_SESSION_EXPIRED') {
        userMsg =
          `⚠️ *TERABOX VERIFICATION EXPIRED*\n\n` +
          `The verification session has expired or was not completed in time.\n` +
          `Please send your link again to start a new verification session.\n\n` +
          `Your daily download limit was NOT used.`;
      } else if (error instanceof TeraBoxGatewayVerificationFailedError || error.code === 'TERABOX_GATEWAY_VERIFICATION_FAILED') {
        userMsg =
          `⚠️ *TERABOX VERIFICATION FAILED*\n\n` +
          `Manual verification could not be confirmed by TeraBox.\n` +
          `Please try sending your link again.\n\n` +
          `Your daily download limit was NOT used.`;
      } else if (error instanceof TeraBoxLinkResolutionFailedError || error.code === 'TERABOX_LINK_RESOLUTION_FAILED') {
        userMsg =
          `⚠️ *TERABOX RESOLUTION FAILED*\n\n` +
          `TeraBox metadata was resolved, but no direct download URL was returned.\n\n` +
          `Your daily download limit was NOT used.`;
      } else if (
        error instanceof TeraBoxGatewayVerificationSessionError ||
        error instanceof TeraBoxVerificationRequiredError ||
        error.name === 'TeraBoxVerificationRequiredError' ||
        error.code === 'TERABOX_VERIFICATION_REQUIRED' ||
        error.name === 'TeraBoxGatewayAuthFailedError' ||
        error.message?.includes('requires verification')
      ) {
        userMsg =
          `⚠️ *TERABOX VERIFICATION REQUIRED*\n\n` +
          `TeraBox requires browser verification before this file can be resolved.\n\n` +
          `Direct download URLs for this link are protected by provider anti-bot verification.\n` +
          `Your daily download limit was NOT used.`;
      } else if (error instanceof ProviderAccessError) {
        userMsg =
          `⚠️ *${error.providerName.toUpperCase()} ACCESS UNAVAILABLE*\n\n` +
          `This ${error.providerName} link requires an available official ${error.providerName} integration.\n\n` +
          `Your daily download limit was NOT used.`;
      }
      
      // Fail job without incrementing daily usage limit
      await jobService.failJob(jobId, error.message || 'Unknown error');
      if (user) {
        await usageService.recordFailedRequest(user.id);
      }
      logger.error(`Job ${jobId} failed: ${error.message}`);
      
      // Edit status message with failure notice
      await updateStatusMessage(userMsg);
    } finally {
      // Temporary file cleanup ALWAYS happens
      if (tempFilePath) {
        const partPath = `${tempFilePath}.part`;
        if (fs.existsSync(partPath)) {
          try { fs.unlinkSync(partPath); } catch (e) {}
        }
        if (fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
            logger.info(`🧹 Cleaned up temporary file ${tempFilePath}`);
          } catch (e: any) {
            logger.error(`Failed to delete temp file ${tempFilePath}: ${e.message}`);
          }
        }
      }
    }
  };

  downloadWorker = new Worker('downloads', async (job: Job) => {
    const { config } = require('../config');
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Job timeout exceeded')), config.JOB_TIMEOUT_MS);
    });
    
    return Promise.race([
      processJob(job),
      timeoutPromise
    ]);
  }, { 
    connection: redis,
    concurrency: require('../config').config.WORKER_CONCURRENCY
  });

  downloadWorker.on('failed', (job, err) => {
    logger.error(`Worker failed job ${job?.id}: ${err.message}`);
  });

  logger.info('👷 BullMQ Download Worker started');
};

export const closeWorker = async () => {
  if (downloadWorker) {
    await downloadWorker.close();
  }
};
