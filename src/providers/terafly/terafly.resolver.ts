import axios, { AxiosError } from 'axios';
import { logger } from '../../utils/logger';
import { extractTeraBoxDownloadUrl, isSafeTeraBoxUrl } from '../terabox/terabox.resolver';
import { TeraBoxResolverError, TeraBoxDownloadUrlError, ProviderUnavailableError } from '../errors';
import { TeraFlyResolveOptions, TeraFlyResolvedResult, TeraFlyWorkerResponse } from './terafly.types';

import { config } from '../../config';

export const TERAFLY_PUBLIC_ENDPOINT = 'https://terabox-proxy.freedekholive-577.workers.dev/';

/**
 * TeraFly External Source Resolver Adapter.
 * Resolves TeraBox URLs through the permitted TeraFly public web interface:
 * https://www.terafly.in/p/terabox-player.html?m=1
 */
export class TeraFlyResolver {
  public isEnabled(): boolean {
    if (typeof (config as any).TERABOX_TERAFLY_ENABLED === 'boolean' && !(config as any).TERABOX_TERAFLY_ENABLED) {
      return false;
    }
    return true;
  }

  /**
   * Resolve direct media download URL for a given TeraBox share URL using TeraFly interface.
   */
  public async resolve(
    teraboxUrl: string,
    options?: TeraFlyResolveOptions
  ): Promise<TeraFlyResolvedResult> {
    if (!this.isEnabled()) {
      logger.info('[TeraFly] unavailable');
      throw new ProviderUnavailableError('TeraFly resolver is disabled by configuration.');
    }

    logger.info('[TeraFly] resolution_started');

    if (!isSafeTeraBoxUrl(teraboxUrl)) {
      logger.warn('[TeraFly] resolution_failed reason=invalid_terabox_url');
      throw new TeraBoxResolverError('Invalid TeraBox URL provided to TeraFly resolver.', 'terafly');
    }

    const envBaseUrl = process.env.TERAFLY_BASE_URL;
    const endpoint = options?.endpointUrl || (envBaseUrl ? `${envBaseUrl.replace(/\/+$/, '')}/` : TERAFLY_PUBLIC_ENDPOINT);

    const timeout = options?.timeoutMs || 15000;

    try {
      logger.info('[TeraFly] page_loaded');
      logger.info('[TeraFly] processing_started');

      const response = await axios.post<TeraFlyWorkerResponse>(
        endpoint,
        { url: teraboxUrl },
        {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
          },
          timeout,
          maxRedirects: 5,
        }
      );

      const data = response.data;
      if (!data || typeof data !== 'object') {
        logger.warn('[TeraFly] resolution_failed reason=invalid_json_response');
        throw new TeraBoxDownloadUrlError('TeraFly returned empty or non-object response.', 'terafly');
      }

      if (data.ok === false) {
        const errReason = typeof data.error === 'string' ? data.error : 'provider_error';
        logger.warn(`[TeraFly] resolution_failed reason=${errReason.replace(/[\n\r]/g, ' ')}`);
        throw new TeraBoxDownloadUrlError(`TeraFly resolution failed: ${errReason}`, 'terafly');
      }

      // Extract title/fileName safely
      const fileName =
        typeof data.title === 'string' && data.title.trim()
          ? data.title.trim()
          : typeof data.fileName === 'string' && data.fileName.trim()
          ? data.fileName.trim()
          : 'terabox.file';

      // Extract size safely
      let size = 0;
      if (typeof data.size === 'number' && data.size > 0) {
        size = data.size;
      } else if (typeof data.size === 'string') {
        const parsed = parseInt(data.size, 10);
        if (!isNaN(parsed) && parsed > 0) size = parsed;
      }

      // Find direct URL candidate
      const rawCandidate =
        data.stream_url ||
        data.download_url ||
        data.downloadUrl ||
        data.dlink ||
        data.url ||
        null;

      if (!rawCandidate) {
        logger.warn('[TeraFly] resolution_failed reason=no_download_url_field');
        throw new TeraBoxDownloadUrlError('TeraFly response contained no download URL field.', 'terafly');
      }

      logger.info('[TeraFly] download_result_detected');

      // Validate direct URL via strict existing direct download validator
      const validatedUrl = extractTeraBoxDownloadUrl(rawCandidate);
      if (!validatedUrl) {
        logger.warn('[TeraFly] resolution_failed reason=direct_url_validation_failed');
        throw new TeraBoxDownloadUrlError('TeraFly direct download URL failed validation checks.', 'terafly');
      }

      logger.info('[TeraFly] resolution_success');

      return {
        fileName,
        size,
        downloadUrl: validatedUrl,
        source: 'terafly',
      };
    } catch (err: any) {
      if (err instanceof TeraBoxResolverError || err instanceof ProviderUnavailableError) {
        throw err;
      }

      let sanitizedReason = 'network_error';
      if (axios.isAxiosError(err)) {
        const axiosErr = err as AxiosError;
        if (axiosErr.code === 'ECONNABORTED' || axiosErr.message.includes('timeout')) {
          sanitizedReason = 'timeout';
        } else if (axiosErr.response) {
          sanitizedReason = `http_${axiosErr.response.status}`;
        } else {
          sanitizedReason = axiosErr.code || 'connection_failed';
        }
      } else if (err.message) {
        sanitizedReason = err.message.replace(/[\n\r]/g, ' ').substring(0, 100);
      }

      logger.warn(`[TeraFly] resolution_failed reason=${sanitizedReason}`);
      throw new TeraBoxDownloadUrlError(`TeraFly resolution failed (${sanitizedReason})`, 'terafly');
    }
  }
}

export const teraFlyResolver = new TeraFlyResolver();
