import axios from 'axios';
import { NotFoundError, ProviderUnavailableError } from '../errors';

export class DiskwalaResolver {
  async resolvePublicLink(url: string): Promise<{ fileName: string, fileSize: number, downloadUrl: string }> {
    try {
      // Diskwala logic
      // In a real implementation we would fetch the HTML, parse the download button
      // For now, throw ProviderUnavailableError as requested to fail gracefully
      throw new ProviderUnavailableError('Diskwala public scraping is pending implementation.');
    } catch (error: any) {
      if (error.response && error.response.status === 404) {
        throw new NotFoundError();
      }
      if (error instanceof ProviderUnavailableError || error instanceof NotFoundError) {
        throw error;
      }
      throw new ProviderUnavailableError('Failed to access public Diskwala share.');
    }
  }
}
