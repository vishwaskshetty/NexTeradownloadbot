import { DownloadProvider, ResolvedFile } from '../types';
import { TeraBoxResolver } from './terabox.resolver';
import { InvalidUrlError } from '../errors';

export class TeraBoxProvider implements DownloadProvider {
  public readonly name = 'TeraBox';

  private teraboxDomains = [
    'terabox.com', 'teraboxapp.com', 'teraboxlink.com', 'nephobox.com',
    '4funbox.com', 'mirrobox.com', 'momerybox.com', 'terabox.app',
    'gibox.app', 'freeterabox.com', '1024tera.com', 'terasharelink.com', 'terabox.fun'
  ];

  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      return this.teraboxDomains.some(domain => parsedUrl.hostname.includes(domain));
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<ResolvedFile> {
    if (!this.canHandle(url)) {
      throw new InvalidUrlError();
    }
    
    const resolver = new TeraBoxResolver();
    const result = await resolver.resolvePublicLink(url);
    
    return {
      provider: this.name,
      sourceUrl: url,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: 'application/octet-stream', // Generic fallback, Terabox doesn't always provide reliable mimetypes
      downloadUrl: result.downloadUrl
    };
  }
}
