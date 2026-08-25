import { DownloadAdapter } from './interfaces/base';

export class TeraboxAdapter implements DownloadAdapter {
  providerName = 'TERABOX';

  canHandle(url: string): boolean {
    const teraboxRegex = /(terabox\.com|teraboxapp\.com|teraboxlink\.com|1024tera\.com|4funbox\.com|mirrobox\.com|nephobox\.com)/i;
    return teraboxRegex.test(url);
  }

  async processLink(url: string, jobId: string, onProgress: (msg: string) => Promise<void>): Promise<void> {
    await onProgress('⏳ Analyzing TeraBox link...');
    
    // Explicitly return "not implemented" as requested, no fake downloads.
    throw new Error('NOT_IMPLEMENTED: TeraBox extraction and download provider is not yet connected.');
  }
}
