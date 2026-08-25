import crypto from 'crypto';

export class TokenService {
  /**
   * Generates a cryptographically secure random token.
   */
  generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Hashes a token using SHA-256 for secure database storage.
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}

export const tokenService = new TokenService();
