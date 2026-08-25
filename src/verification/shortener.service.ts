import { ShortenerProvider } from './verification.types';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { adminService } from '../services/AdminService';

export class BitlyProvider implements ShortenerProvider {
  getProviderName(): string {
    return 'bitly';
  }

  async createShortUrl(destinationUrl: string): Promise<string> {
    if (!config.SHORTENER_API_KEY) {
      throw new Error('SHORTENER_API_KEY is not configured for Bitly.');
    }
    
    try {
      const response = await axios.post(
        'https://api-ssl.bitly.com/v4/shorten',
        { long_url: destinationUrl },
        {
          headers: {
            'Authorization': `Bearer ${config.SHORTENER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      if (response.data?.link) {
        return response.data.link;
      }
      throw new Error('Bitly API returned no link');
    } catch (error: any) {
      logger.error(`[BitlyProvider] Bitly API error: ${error?.message}`);
      throw error;
    }
  }
}

export class DisabledProvider implements ShortenerProvider {
  getProviderName(): string {
    return 'disabled';
  }

  async createShortUrl(destinationUrl: string): Promise<string> {
    return destinationUrl;
  }
}

export class ArolinksProvider implements ShortenerProvider {
  getProviderName(): string {
    return 'arolinks';
  }

  async createShortUrl(destinationUrl: string): Promise<string> {
    if (!config.SHORTENER_API_KEY || config.SHORTENER_API_KEY.includes('your_arolinks_api_key')) {
      throw new Error('SHORTENER_API_KEY is not configured in .env for AroLinks.');
    }

    try {
      // AroLinks API endpoint: GET https://arolinks.com/api?api=KEY&url=DESTINATION
      const apiUrl = `https://arolinks.com/api?api=${encodeURIComponent(config.SHORTENER_API_KEY)}&url=${encodeURIComponent(destinationUrl)}`;
      const response = await axios.get(apiUrl, { timeout: 10000 });
      const data = response.data;
      
      const shortUrl = data?.shortenedUrl || data?.shortened_url || data?.url || data?.short_url || data?.link;
      if (shortUrl && typeof shortUrl === 'string' && shortUrl.startsWith('http')) {
        logger.info(`[ArolinksProvider] Successfully generated AroLinks URL: ${shortUrl}`);
        return shortUrl;
      }

      if (data?.status === 'error' && Array.isArray(data?.message)) {
        throw new Error(`AroLinks API returned error: ${data.message.join(', ')}`);
      }

      throw new Error(`AroLinks API response format unrecognized`);
    } catch (err: any) {
      // Sanitize secrets in error logging
      const sanitizedErrMsg = (err?.message || '').replace(config.SHORTENER_API_KEY, '***');
      logger.error(`[ArolinksProvider] AroLinks request failed: ${sanitizedErrMsg}`);
      throw new Error(`AroLinks API request failed: ${sanitizedErrMsg}`);
    }
  }
}

// Factory to select provider based on config/db
export const getShortenerProvider = async (): Promise<ShortenerProvider> => {
  const isEnabled = await adminService.getShortenerStatus();
  if (!isEnabled) {
    return new DisabledProvider();
  }

  const providerName = (await adminService.getShortenerProvider()).toLowerCase();
  
  if (providerName === 'bitly') {
    return new BitlyProvider();
  }
  
  // Default to AroLinks as requested
  return new ArolinksProvider();
};
