import { DownloadProvider } from './types';
import { TeraBoxProvider } from './terabox/terabox.provider';
import { DiskwalaProvider } from './diskwala/diskwala.provider';

export class ProviderRegistry {
  private providers: DownloadProvider[] = [];

  constructor() {
    this.registerProvider(new TeraBoxProvider());
    this.registerProvider(new DiskwalaProvider());
  }

  registerProvider(provider: DownloadProvider) {
    this.providers.push(provider);
  }

  getProviderForUrl(url: string): DownloadProvider | undefined {
    return this.providers.find(p => p.canHandle(url));
  }
  
  detectAdapter(url: string) {
    const provider = this.getProviderForUrl(url);
    if (!provider) return null;
    return {
      providerName: provider.name,
      adapter: provider
    };
  }
}

export const providerRegistry = new ProviderRegistry();

// Keep backward compatible export for message.ts
export const detectAdapter = (url: string) => providerRegistry.detectAdapter(url);
