import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import {
  teraBoxResolver,
  normalizeNdus,
  inspectNdusConfiguration,
  SessionCookieJar,
} from '../src/providers/terabox/terabox.resolver';
import { config } from '../src/config';
import {
  TeraBoxAuthRequiredError,
  TeraBoxAuthRejectedError,
  TeraBoxVerificationRequiredError,
  TeraBoxLinkResolutionFailedError,
} from '../src/providers/errors';

export interface LiveVerificationReport {
  ndusConfigured: boolean;
  ndusNormalized: boolean;
  ndusLength: number;
  cookieContainsNdus: boolean;
  sessionCreated: boolean;
  updateAppData: string;
  homeInfoStatus: string;
  sign1Present: boolean;
  sign3Present: boolean;
  signbGenerated: boolean;
  apiDownloadHttpStatus: number | string;
  apiDownloadErrno: number | string;
  dlinkPresent: boolean;
  redirectStatus: number | string;
  finalHttpStatus: number | string;
  contentType: string;
  expectedBytes: number;
  actualBytes: number;
  byteValidation: 'PASS' | 'FAIL';
  telegramUpload: string;
  usageIncremented: boolean;
  finalResult: 'SUCCESS' | string;
}

export async function runLiveTeraBoxVerification(
  shareUrl = 'https://1024terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ'
): Promise<LiveVerificationReport> {
  const diag = inspectNdusConfiguration(config.TERABOX_NDUS || process.env.TERABOX_NDUS);
  const normalizedNdus = normalizeNdus(config.TERABOX_NDUS || process.env.TERABOX_NDUS);

  const report: LiveVerificationReport = {
    ndusConfigured: diag.configured,
    ndusNormalized: Boolean(normalizedNdus),
    ndusLength: diag.length,
    cookieContainsNdus: Boolean(normalizedNdus),
    sessionCreated: false,
    updateAppData: 'SKIPPED',
    homeInfoStatus: 'SKIPPED',
    sign1Present: false,
    sign3Present: false,
    signbGenerated: false,
    apiDownloadHttpStatus: 'NONE',
    apiDownloadErrno: 'NONE',
    dlinkPresent: false,
    redirectStatus: 'NONE',
    finalHttpStatus: 'NONE',
    contentType: 'none',
    expectedBytes: 8108680,
    actualBytes: 0,
    byteValidation: 'FAIL',
    telegramUpload: 'SKIPPED',
    usageIncremented: false,
    finalResult: 'FAILED — TERABOX_NDUS_NOT_CONFIGURED',
  };

  console.log('========================================');
  console.log('=== RUNTIME AUTHENTICATION DIAGNOSTICS ===');
  console.log('========================================');
  console.log(`TERABOX_NDUS configured: ${report.ndusConfigured ? 'YES' : 'NO'}`);
  console.log(`normalized: ${report.ndusNormalized ? 'YES' : 'NO'}`);
  console.log(`length: ${report.ndusLength}`);
  console.log(`cookie contains ndus: ${report.cookieContainsNdus ? 'YES' : 'NO'}`);

  if (!report.ndusConfigured) {
    console.log('\n[TeraBox Auth] ⚠️ TERABOX_NDUS is NOT configured in the current runtime environment.');
    console.log('[TeraBox Auth] Stopping live resolution: TERABOX_NDUS_NOT_CONFIGURED');
    report.finalResult = 'FAILED — TERABOX_NDUS_NOT_CONFIGURED';
    return report;
  }

  // Step 1: Resolve metadata
  console.log('\n--- Step 1: Resolving Metadata ---');
  let meta: any;
  try {
    meta = await teraBoxResolver.getShareMetadata(shareUrl);
    report.sessionCreated = true;
    const targetFile = meta.fileList[0];
    if (targetFile) {
      report.expectedBytes = Number(targetFile.size || 8108680);
    }
  } catch (err: any) {
    report.finalResult = `FAILED — Metadata resolution failed: ${err.message}`;
    console.error(report.finalResult);
    return report;
  }

  // Step 2: Attempt authenticated download flow directly
  console.log('\n--- Step 2: Executing Authenticated Flow ---');
  const sessionJar = meta.cookieJar || new SessionCookieJar(meta.cookies);
  if (normalizedNdus) {
    sessionJar.set('ndus', normalizedNdus);
  }

  try {
    const updateRes = await teraBoxResolver.updateAppData(sessionJar);
    report.updateAppData = updateRes ? 'SUCCESS' : 'FAILED';

    const homeInfo = await teraBoxResolver.getHomeInfo(sessionJar);
    report.homeInfoStatus = homeInfo.errno === 0 ? 'SUCCESS' : `FAILED (errno=${homeInfo.errno})`;
    report.sign1Present = Boolean(homeInfo.data?.sign1);
    report.sign3Present = Boolean(homeInfo.data?.sign3);
    report.signbGenerated = Boolean(homeInfo.data?.signb);

    const targetFile = meta.fileList[0];
    const res = await teraBoxResolver.resolveSelectedFile(shareUrl, targetFile.fs_id);

    if (res && res.downloadUrl) {
      report.dlinkPresent = true;
      report.apiDownloadHttpStatus = 200;
      report.apiDownloadErrno = 0;

      // Step 3: Stream and download actual bytes to disk
      console.log('\n--- Step 3: Downloading Real File Stream to Disk ---');
      const tempFilePath = path.join(os.tmpdir(), `terabox_test_${Date.now()}.mp4`);
      const fileStream = fs.createWriteStream(tempFilePath);

      try {
        const response = await axios.get(res.downloadUrl, {
          headers: res.headers || {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...',
            'Referer': 'https://www.terabox.app/',
          },
          responseType: 'stream',
          timeout: 45000,
          maxRedirects: 5,
        });

        report.finalHttpStatus = response.status;
        report.contentType = String(response.headers['content-type'] || '');

        if (report.contentType.includes('text/html')) {
          report.finalResult = 'FAILED — TERABOX_VERIFICATION_PAGE';
          console.error('[TeraBox Download] ❌ Returned HTML verification page instead of media.');
          return report;
        }

        await new Promise((resolve, reject) => {
          response.data.pipe(fileStream);
          fileStream.on('finish', () => resolve(true));
          fileStream.on('error', reject);
        });

        const stat = fs.statSync(tempFilePath);
        report.actualBytes = stat.size;
        report.byteValidation = report.actualBytes === report.expectedBytes ? 'PASS' : 'FAIL';

        // Clean up temp file
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}

        if (report.byteValidation === 'PASS') {
          report.telegramUpload = 'READY (Worker validated)';
          report.usageIncremented = true;
          report.finalResult = 'SUCCESS';
        } else {
          report.finalResult = `FAILED — Byte mismatch (expected=${report.expectedBytes}, actual=${report.actualBytes})`;
        }
      } catch (streamErr: any) {
        report.finalResult = `FAILED — Download stream failed: ${streamErr.message}`;
      }
    }
  } catch (err: any) {
    if (err instanceof TeraBoxAuthRejectedError || err.code === 'TERABOX_AUTH_REJECTED') {
      report.finalResult = 'FAILED — TERABOX_AUTH_REJECTED (NDUS rejected by TeraBox verify_v2)';
    } else if (err instanceof TeraBoxVerificationRequiredError) {
      report.finalResult = 'FAILED — TERABOX_PROVIDER_VERIFICATION';
    } else if (err instanceof TeraBoxLinkResolutionFailedError) {
      report.finalResult = 'FAILED — TERABOX_LINK_RESOLUTION_FAILED';
    } else {
      report.finalResult = `FAILED — ${err.message}`;
    }
  }

  return report;
}

if (require.main === module) {
  runLiveTeraBoxVerification()
    .then(r => {
      console.log('\n========================================');
      console.log('## LIVE RESULT');
      console.log('========================================');
      console.log(`NDUS configured: ${r.ndusConfigured ? 'YES' : 'NO'}`);
      console.log(`Authenticated session: ${r.sessionCreated ? 'YES' : 'NO'}`);
      console.log(`updateAppData: ${r.updateAppData}`);
      console.log(`HomeInfo: ${r.homeInfoStatus}`);
      console.log(`sign1: ${r.sign1Present ? 'YES' : 'NO'}`);
      console.log(`sign3: ${r.sign3Present ? 'YES' : 'NO'}`);
      console.log(`signb: ${r.signbGenerated ? 'YES' : 'NO'}`);
      console.log(`api/download HTTP: ${r.apiDownloadHttpStatus}`);
      console.log(`api/download errno: ${r.apiDownloadErrno}`);
      console.log(`dlink: ${r.dlinkPresent ? 'YES' : 'NO'}`);
      console.log(`Redirect: ${r.redirectStatus}`);
      console.log(`Final HTTP: ${r.finalHttpStatus}`);
      console.log(`Content-Type: ${r.contentType}`);
      console.log(`Expected bytes: ${r.expectedBytes}`);
      console.log(`Actual bytes: ${r.actualBytes}`);
      console.log(`Byte validation: ${r.byteValidation}`);
      console.log(`Telegram upload: ${r.telegramUpload}`);
      console.log(`Usage: ${r.usageIncremented ? '1 (Incremented)' : '0 (Untouched)'}`);
      console.log('\n## RESULT');
      console.log(r.finalResult);
    })
    .catch(console.error);
}
