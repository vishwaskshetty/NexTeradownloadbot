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

export class TeraBoxResolverError extends ProviderError {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly errno?: number,
    public readonly requestId?: string,
    code = 'TERABOX_RESOLVER_ERROR'
  ) {
    super(message, code, 'TeraBox');
    this.name = 'TeraBoxResolverError';
  }
}

export class TeraBoxSessionError extends TeraBoxResolverError {
  constructor(message = 'Failed to establish TeraBox share session.', stage = 'session') {
    super(message, stage, undefined, undefined, 'TERABOX_SESSION_ERROR');
    this.name = 'TeraBoxSessionError';
  }
}

export class TeraBoxMetadataError extends TeraBoxResolverError {
  constructor(message = 'Failed to retrieve TeraBox share metadata.', stage = 'metadata', errno?: number, requestId?: string) {
    super(message, stage, errno, requestId, 'TERABOX_METADATA_ERROR');
    this.name = 'TeraBoxMetadataError';
  }
}

export class TeraBoxMissingContextError extends TeraBoxResolverError {
  constructor(message: string, stage = 'validation') {
    super(message, stage, undefined, undefined, 'TERABOX_MISSING_CONTEXT');
    this.name = 'TeraBoxMissingContextError';
  }
}

export class TeraBoxProviderError extends TeraBoxResolverError {
  constructor(message: string, stage = 'download', errno?: number, requestId?: string) {
    super(message, stage, errno, requestId, 'TERABOX_PROVIDER_ERROR');
    this.name = 'TeraBoxProviderError';
  }
}

export class TeraBoxDownloadUrlError extends TeraBoxResolverError {
  constructor(message = 'TeraBox returned no valid direct download URL.', stage = 'extraction') {
    super(message, stage, undefined, undefined, 'TERABOX_DOWNLOAD_URL_ERROR');
    this.name = 'TeraBoxDownloadUrlError';
  }
}

export class TeraBoxVerificationRequiredError extends TeraBoxResolverError {
  constructor(
    message = 'TeraBox download requires an authenticated account session (TERABOX_NDUS) or official API credentials (TERABOX_ACCESS_TOKEN).',
    stage = 'verification',
    errno = 400310,
    requestId?: string
  ) {
    super(message, stage, errno, requestId, 'TERABOX_VERIFICATION_REQUIRED');
    this.name = 'TeraBoxVerificationRequiredError';
  }
}


