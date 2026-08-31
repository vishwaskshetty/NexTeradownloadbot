export interface TeraFlyResolveOptions {
  timeoutMs?: number;
  endpointUrl?: string;
}

export interface TeraFlyWorkerResponse {
  ok?: boolean;
  error?: string;
  title?: string;
  fileName?: string;
  size?: number | string;
  size_str?: string;
  download_url?: string;
  stream_url?: string;
  downloadUrl?: string;
  dlink?: string;
  url?: string;
  thumbnail?: string;
  duration?: string;
  resolution?: string;
}

export interface TeraFlyResolvedResult {
  fileName: string;
  size: number;
  downloadUrl: string;
  source: 'terafly';
}
