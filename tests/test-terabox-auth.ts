import 'dotenv/config';
import axios from 'axios';
import { teraBoxResolver, normalizeNdus } from '../src/providers/terabox/terabox.resolver';
import { config } from '../src/config';
import {
  TeraBoxAuthRequiredError,
  TeraBoxAuthRejectedError,
  TeraBoxLinkResolutionFailedError,
} from '../src/providers/errors';

export interface StandaloneAuthTestResult {
  metadataPass: boolean;
  ndusConfigured: boolean;
  authPass: boolean;
  directUrlPass: boolean;
  downloadPass: boolean;
  downloadedBytes: number;
  expectedBytes: number;
  fileName: string;
  errorReason?: string;
}

export async function runStandaloneTeraBoxAuthTest(
  shareUrl = 'https://1024terabox.com/s/1fKvukFFlwMqHt3vbdFoRYQ'
): Promise<StandaloneAuthTestResult> {
  const result: StandaloneAuthTestResult = {
    metadataPass: false,
    ndusConfigured: false,
    authPass: false,
    directUrlPass: false,
    downloadPass: false,
    downloadedBytes: 0,
    expectedBytes: 8108680,
    fileName: '2026-04-23-18-55-38(8).mp4',
  };

  const normalizedNdus = normalizeNdus(config.TERABOX_NDUS || process.env.TERABOX_NDUS);
  result.ndusConfigured = Boolean(normalizedNdus);

  console.log('--- [TeraBox Auth Test] Step 1: Resolving Metadata ---');
  let meta: any;
  try {
    meta = await teraBoxResolver.getShareMetadata(shareUrl);
    result.metadataPass = true;
    console.log(`[TeraBox Test] Share code resolved: ${meta.shareCode || meta.surl}`);
    console.log(`[TeraBox Test] Files found: ${meta.fileList.length}`);
    const firstFile = meta.fileList[0];
    if (firstFile) {
      result.fileName = firstFile.server_filename || result.fileName;
      result.expectedBytes = Number(firstFile.size || result.expectedBytes);
    }
  } catch (err: any) {
    result.errorReason = `Metadata resolution failed: ${err.message}`;
    console.error(`[TeraBox Test] ❌ ${result.errorReason}`);
    return result;
  }

  console.log('\n--- [TeraBox Auth Test] Step 2: Authenticated Flow ---');
  console.log(`[TeraBox Test] NDUS configured: ${result.ndusConfigured ? 'YES' : 'NO'}`);
  console.log(`[TeraBox Test] jsToken present: ${Boolean(meta.jsToken) ? 'YES' : 'NO'}`);
  console.log(`[TeraBox Test] sign present: ${Boolean(meta.sign) ? 'YES' : 'NO'}`);
  console.log(`[TeraBox Test] timestamp present: ${Boolean(meta.timestamp) ? 'YES' : 'NO'}`);

  const targetFile = meta.fileList[0];
  let downloadResult: any;

  try {
    downloadResult = await teraBoxResolver.resolveWithPahadi10Flow(targetFile.fs_id, meta);
    result.authPass = true;
    result.directUrlPass = Boolean(downloadResult?.downloadUrl);
    console.log(`[TeraBox Test] Direct URL obtained: ${result.directUrlPass ? 'YES' : 'NO'}`);
    console.log(`[TeraBox Test] Strategy source: ${downloadResult.source}`);
  } catch (err: any) {
    if (err instanceof TeraBoxAuthRequiredError) {
      result.errorReason = 'TERABOX_AUTH_REQUIRED (No TERABOX_NDUS in environment)';
    } else if (err instanceof TeraBoxAuthRejectedError) {
      result.errorReason = 'TERABOX_AUTH_REJECTED (TERABOX_NDUS rejected or expired)';
    } else if (err instanceof TeraBoxLinkResolutionFailedError) {
      result.errorReason = 'TERABOX_LINK_RESOLUTION_FAILED (No download URL returned)';
    } else {
      result.errorReason = `Provider error: ${err.message}`;
    }
    console.log(`[TeraBox Test] ℹ️ Result: ${result.errorReason}`);
    return result;
  }

  if (downloadResult?.downloadUrl) {
    console.log('\n--- [TeraBox Auth Test] Step 3: Real HTTP Download Stream ---');
    try {
      const parsed = new URL(downloadResult.downloadUrl);
      console.log(`[TeraBox Test] Target Hostname: ${parsed.hostname}`);

      const response = await axios.get(downloadResult.downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...',
          'Referer': 'https://www.terabox.app/',
        },
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 5,
      });

      console.log(`[TeraBox Test] HTTP Status: ${response.status}`);
      console.log(`[TeraBox Test] Content-Type: ${response.headers['content-type']}`);
      console.log(`[TeraBox Test] Content-Length: ${response.headers['content-length']}`);

      let received = 0;
      await new Promise((resolve, reject) => {
        response.data.on('data', (chunk: Buffer) => {
          received += chunk.length;
        });
        response.data.on('end', () => {
          result.downloadedBytes = received;
          resolve(true);
        });
        response.data.on('error', (e: any) => reject(e));
      });

      console.log(`[TeraBox Test] Total Bytes Downloaded: ${result.downloadedBytes} / ${result.expectedBytes}`);
      if (result.downloadedBytes > 0 && Math.abs(result.downloadedBytes - result.expectedBytes) < 1000) {
        result.downloadPass = true;
      }
    } catch (dlErr: any) {
      result.errorReason = `Download streaming failed: ${dlErr.message}`;
      console.error(`[TeraBox Test] ❌ ${result.errorReason}`);
    }
  }

  return result;
}

if (require.main === module) {
  runStandaloneTeraBoxAuthTest()
    .then(r => {
      console.log('\n========================================');
      console.log('=== STANDALONE TEST COMPLETE SUMMARY ===');
      console.log('========================================');
      console.log(JSON.stringify(r, null, 2));
    })
    .catch(console.error);
}
