export interface DownloadAdapter {
  providerName: string;
  canHandle(url: string): boolean;
  processLink(url: string, jobId: string, onProgress: (msg: string) => Promise<void>): Promise<void>;
}
