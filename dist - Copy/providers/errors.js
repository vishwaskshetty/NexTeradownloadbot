"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderAccessError = exports.InvalidUrlError = exports.ProviderUnavailableError = exports.NotFoundError = exports.ProviderError = void 0;
class ProviderError extends Error {
    code;
    providerName;
    constructor(message, code, providerName) {
        super(message);
        this.code = code;
        this.providerName = providerName;
        this.name = 'ProviderError';
    }
}
exports.ProviderError = ProviderError;
class NotFoundError extends ProviderError {
    constructor(message = 'File not found or is no longer publicly accessible.') {
        super(message, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}
exports.NotFoundError = NotFoundError;
class ProviderUnavailableError extends ProviderError {
    constructor(message = 'Provider is temporarily unavailable. Please try again later.') {
        super(message, 'UNAVAILABLE');
        this.name = 'ProviderUnavailableError';
    }
}
exports.ProviderUnavailableError = ProviderUnavailableError;
class InvalidUrlError extends ProviderError {
    constructor(message = 'Invalid or unsupported public link.') {
        super(message, 'INVALID_URL');
        this.name = 'InvalidUrlError';
    }
}
exports.InvalidUrlError = InvalidUrlError;
/**
 * Thrown when a provider is correctly detected but cannot proceed
 * because official API credentials are not configured.
 * This is NOT an error — it is an expected state when credentials are absent.
 */
class ProviderAccessError extends ProviderError {
    providerName;
    constructor(providerName, message) {
        super(message || `${providerName} requires official API credentials that are not configured.`, 'ACCESS_REQUIRED');
        this.providerName = providerName;
        this.name = 'ProviderAccessError';
    }
}
exports.ProviderAccessError = ProviderAccessError;
