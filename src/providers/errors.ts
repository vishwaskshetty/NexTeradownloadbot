export class ProviderError extends Error {
  constructor(message: string, public readonly code?: string, public readonly providerName?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class NotFoundError extends ProviderError {
  constructor(message = 'File not found or is no longer publicly accessible.') {
    super(message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(message = 'Provider is temporarily unavailable. Please try again later.') {
    super(message, 'UNAVAILABLE');
    this.name = 'ProviderUnavailableError';
  }
}

export class InvalidUrlError extends ProviderError {
  constructor(message = 'Invalid or unsupported public link.') {
    super(message, 'INVALID_URL');
    this.name = 'InvalidUrlError';
  }
}

/**
 * Thrown when a provider is correctly detected but cannot proceed
 * because official API credentials are not configured.
 * This is NOT an error — it is an expected state when credentials are absent.
 */
export class ProviderAccessError extends ProviderError {
  constructor(public readonly providerName: string, message?: string) {
    super(
      message || `${providerName} requires official API credentials that are not configured.`,
      'ACCESS_REQUIRED'
    );
    this.name = 'ProviderAccessError';
  }
}
