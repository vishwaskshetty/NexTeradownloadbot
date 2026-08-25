import { DownloadAdapter } from './interfaces/base';
import { TeraboxAdapter } from './terabox';
import { DiskwalaAdapter } from './diskwala';

const adapters: DownloadAdapter[] = [
  new TeraboxAdapter(),
  new DiskwalaAdapter(),
];

export const detectAdapter = (url: string): DownloadAdapter | null => {
  for (const adapter of adapters) {
    if (adapter.canHandle(url)) {
      return adapter;
    }
  }
  return null;
};
