import { DownloadAdapter } from './interfaces/base';
import { DiskwalaProvider } from '../providers/diskwala/diskwala.provider';

export class DiskwalaAdapter implements DownloadAdapter {
  providerName = 'DISKWALA';
  private provider = new DiskwalaProvider();

  canHandle(url: string): boolean {
    return this.provider.canHandle(url);
  }

  async processLink(url: string, jobId: string, onProgress: (msg: string) => Promise<void>): Promise<void> {
    await onProgress('⏳ Resolving Diskwala link...');
    await this.provider.resolve(url);
  }
}
