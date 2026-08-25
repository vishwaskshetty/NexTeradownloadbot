import { DownloadProvider, ResolvedFile } from '../types';
import { DiskwalaResolver, hasDiskwalaCredentials } from './diskwala.resolver';
import { InvalidUrlError, ProviderAccessError } from '../errors';

const DISKWALA_DOMAINS = [
  'diskwala.com',
  'diskwalaapp.com',
  'disk.wala',
];

export class DiskwalaProvider implements DownloadProvider {
  public readonly name = 'Diskwala';

  private readonly resolver = new DiskwalaResolver();

  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return DISKWALA_DOMAINS.some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  }

  /**
   * Checks whether official Diskwala API credentials are configured.
   */
  isConfigured(): boolean {
    return hasDiskwalaCredentials();
  }

  async resolve(url: string): Promise<ResolvedFile> {
    if (!this.canHandle(url)) {
      throw new InvalidUrlError('Invalid or unsupported Diskwala link.');
    }

    const result = await this.resolver.resolvePublicLink(url);

    return {
      provider: this.name,
      sourceUrl: url,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: result.mimeType,
      downloadUrl: result.downloadUrl
    };
  }
}
