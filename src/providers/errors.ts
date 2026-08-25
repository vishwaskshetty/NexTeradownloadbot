export class ProviderError extends Error {
  constructor(message: string, public readonly code?: string) {
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
