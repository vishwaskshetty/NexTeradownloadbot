import { DownloadAdapter } from './interfaces/base';

export class DiskwalaAdapter implements DownloadAdapter {
  providerName = 'DISKWALA';

  canHandle(url: string): boolean {
    const diskwalaRegex = /(diskwala\.com|diskwalaapp\.com)/i; // Placeholder regex
    return diskwalaRegex.test(url);
  }

  async processLink(url: string, jobId: string, onProgress: (msg: string) => Promise<void>): Promise<void> {
    await onProgress('⏳ Analyzing Diskwala link...');
    
    // Explicitly return "not implemented" as requested, no fake downloads.
    throw new Error('NOT_IMPLEMENTED: Diskwala extraction and download provider is not yet connected.');
  }
}
