import { DownloadAdapter } from './interfaces/base';
import { TeraBoxProvider } from '../providers/terabox/terabox.provider';
import { ResolvedFile } from '../providers/types';

export class TeraboxAdapter implements DownloadAdapter {
  public readonly providerName = 'TeraBox';
  private readonly provider = new TeraBoxProvider();

  canHandle(url: string): boolean {
    return this.provider.canHandle(url);
  }

  async resolve(url: string): Promise<ResolvedFile> {
    return this.provider.resolve(url);
  }

  async getShareMetadata(url: string) {
    return this.provider.getShareMetadata(url);
  }

  async resolveSelectedFile(url: string, fsId?: string | number): Promise<ResolvedFile> {
    return this.provider.resolveSelectedFile(url, fsId);
  }

  async processLink(url: string, jobId: string, onProgress: (msg: string) => Promise<void>): Promise<void> {
    await onProgress('🔎 Validating and resolving TeraBox public share link...');
    await this.provider.resolve(url);
    await onProgress('✅ TeraBox link successfully resolved!');
  }
}
