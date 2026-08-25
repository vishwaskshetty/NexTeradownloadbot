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
      logger.warn('No SHORTENER_API_KEY provided for BitlyProvider. Returning original URL.');
      return destinationUrl;
    }
    
    try {
      const response = await axios.post(
        'https://api-ssl.bitly.com/v4/shorten',
        { long_url: destinationUrl },
        {
          headers: {
            'Authorization': `Bearer ${config.SHORTENER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.link;
    } catch (error: any) {
      logger.error(error, 'Failed to create short url via Bitly');
      throw new Error('Shortener API failed');
    }
  }
}

export class DisabledProvider implements ShortenerProvider {
  getProviderName(): string {
    return 'disabled';
  }

  async createShortUrl(destinationUrl: string): Promise<string> {
    return destinationUrl; // Just pass through the long URL gracefully
  }
}

export class ArolinksProvider implements ShortenerProvider {
  getProviderName(): string {
    return 'arolinks';
  }

  async createShortUrl(destinationUrl: string): Promise<string> {
    if (!config.SHORTENER_API_KEY) {
      throw new Error('SHORTENER_API_KEY is not configured for Arolinks.');
    }
    
    // Per the strict requirement: "If the exact Arolinks API integration cannot be verified, 
    // clearly mark it as requiring official API documentation instead of creating fake functionality."
    // Since there are no API docs provided in the workspace for Arolinks, we strictly throw this error.
    throw new Error('AROLINKS_API_UNVERIFIED: The exact Arolinks API endpoints and response formats are not documented in the project. Please provide the official API documentation to complete this integration.');
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
  } else if (providerName === 'arolinks') {
    return new ArolinksProvider();
  }
  
  // Default fallback if unknown provider
  return new BitlyProvider();
};
