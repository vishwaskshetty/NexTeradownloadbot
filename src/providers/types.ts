export interface FileInfo {
  fileName: string;
  fileSize: number | bigint;
  mimeType: string;
}

export interface ResolvedFile extends FileInfo {
  provider: string;
  sourceUrl: string;
  downloadUrl: string;
  headers?: Record<string, string>;
  expiresAt?: Date;
}

export interface DownloadProvider {
  /**
   * The name of the provider, e.g. "TeraBox", "Diskwala"
   */
  readonly name: string;

  /**
   * Check if this provider can handle the given URL
   */
  canHandle(url: string): boolean;

  /**
   * Complete resolution process that returns all info and the direct download URL
   */
  resolve(url: string): Promise<ResolvedFile>;

  /**
   * Optional: Just get metadata without resolving the full download link if possible
   */
  getFileInfo?(url: string): Promise<FileInfo>;
}
