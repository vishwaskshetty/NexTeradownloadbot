export interface ShortenerProvider {
  getProviderName(): string;
  createShortUrl(destinationUrl: string): Promise<string>;
}
