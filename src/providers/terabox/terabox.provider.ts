import { DownloadProvider, FileInfo, ResolvedFile } from '../types';
import { TeraBoxResolver, isSafeTeraBoxUrl, hasTeraBoxCredentials, TeraBoxShareMetadata } from './terabox.resolver';
import { InvalidUrlError } from '../errors';

/**
 * TeraBoxProvider encapsulates both official TeraBox Open Platform API logic
 * and isolated fallback resolution.
 *
 * If official API credentials (client ID, client secret, access token) are set in .env,
 * it utilizes official endpoints. Otherwise, it isolates reverse-engineered/unofficial
 * public link resolution behind this Provider interface so it can be swapped effortlessly.
 */
export class TeraBoxProvider implements DownloadProvider {
  public readonly name = 'TeraBox';

  private readonly resolver = new TeraBoxResolver();

  /**
   * Validate if the given URL is a supported TeraBox public link
   * and passes domain whitelist & SSRF security checks.
   */
  canHandle(url: string): boolean {
    return isSafeTeraBoxUrl(url);
  }

  /**
   * Returns whether official TeraBox Open Platform credentials are configured.
   */
  isConfigured(): boolean {
    return hasTeraBoxCredentials();
  }

  /**
   * Retrieve basic file metadata without resolving full download payload.
   */
  async getFileInfo(url: string): Promise<FileInfo> {
    const resolved = await this.resolve(url);
    return {
      fileName: resolved.fileName,
      fileSize: resolved.fileSize,
      mimeType: resolved.mimeType,
    };
  }

  /**
   * Get metadata list for single or multi-file TeraBox share.
   */
  async getShareMetadata(url: string): Promise<TeraBoxShareMetadata> {
    if (!this.canHandle(url)) {
      throw new InvalidUrlError('❌ Invalid TeraBox link');
    }
    return this.resolver.getShareMetadata(url);
  }

  /**
   * Resolve selected file from single or multi-file share.
   */
  async resolveSelectedFile(url: string, fsId?: string | number): Promise<ResolvedFile> {
    if (!this.canHandle(url)) {
      throw new InvalidUrlError('❌ Invalid TeraBox link');
    }

    const result = await this.resolver.resolveSelectedFile(url, fsId);

    return {
      provider: this.name,
      sourceUrl: url,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: result.mimeType,
      downloadUrl: result.downloadUrl,
    };
  }

  /**
   * Complete resolution process returning file details and direct download URL.
   */
  async resolve(url: string): Promise<ResolvedFile> {
    return this.resolveSelectedFile(url);
  }
}
