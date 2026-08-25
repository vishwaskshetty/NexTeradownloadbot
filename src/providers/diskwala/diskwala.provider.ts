import { DownloadProvider, ResolvedFile } from '../types';
import { DiskwalaResolver } from './diskwala.resolver';
import { InvalidUrlError } from '../errors';

export class DiskwalaProvider implements DownloadProvider {
  public readonly name = 'Diskwala';

  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.hostname.includes('diskwala.com') || parsedUrl.hostname.includes('disk.wala');
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<ResolvedFile> {
    if (!this.canHandle(url)) {
      throw new InvalidUrlError();
    }
    
    const resolver = new DiskwalaResolver();
    const result = await resolver.resolvePublicLink(url);
    
    return {
      provider: this.name,
      sourceUrl: url,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: 'application/octet-stream',
      downloadUrl: result.downloadUrl
    };
  }
}
