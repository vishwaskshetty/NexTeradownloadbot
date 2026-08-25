import { db } from '../db';
import { VerificationSession, User } from '@prisma/client';
import { tokenService } from './token.service';
import { getShortenerProvider } from './shortener.service';
import { config } from '../config';

export class VerificationService {
  /**
   * Generates a new verification session for a user and returns the short URL.
   */
  async createVerificationFlow(userId: number): Promise<{ shortUrl: string; duration: number }> {
    const rawToken = tokenService.generateSecureToken();
    const tokenHash = tokenService.hashToken(rawToken);
    
    // Default 24 hours validity for the link itself to be clicked
    const linkExpiry = new Date();
    linkExpiry.setHours(linkExpiry.getHours() + 24);

    const provider = await getShortenerProvider();
    const providerName = provider.getProviderName();

    // Create session in DB
    const session = await db.verificationSession.create({
      data: {
        userId,
        tokenHash,
        status: 'PENDING',
        expiresAt: linkExpiry,
        shortenerProvider: providerName
      }
    });

    // Generate destination callback URL
    const destinationUrl = `${config.VERIFICATION_BASE_URL}/verify/${rawToken}`;
    
    // Get short URL
    const shortUrl = await provider.createShortUrl(destinationUrl);
    
    // Update reference
    await db.verificationSession.update({
      where: { id: session.id },
      data: { shortenerReference: shortUrl }
    });

    return { shortUrl, duration: config.VERIFICATION_VALIDITY_MINUTES };
  }

  /**
   * Validates a token sent from the web callback.
   */
  async validateToken(rawToken: string): Promise<{ success: boolean; message: string; user?: User }> {
    const tokenHash = tokenService.hashToken(rawToken);

    // Run within a transaction to prevent race conditions on verification
    return await db.$transaction(async (tx) => {
      const session = await tx.verificationSession.findUnique({
        where: { tokenHash },
        include: { user: true }
      });

      if (!session) {
        return { success: false, message: 'Invalid verification token.' };
      }

      if (session.status === 'VERIFIED' || session.status === 'USED') {
        return { success: false, message: 'This verification link has already been used.' };
      }

      if (session.status === 'EXPIRED' || session.expiresAt < new Date()) {
        await tx.verificationSession.update({
          where: { id: session.id },
          data: { status: 'EXPIRED' }
        });
        return { success: false, message: 'This verification link has expired.' };
      }

      if (session.status !== 'PENDING') {
        return { success: false, message: 'Invalid session state.' };
      }

      // Mark session as VERIFIED
      await tx.verificationSession.update({
        where: { id: session.id },
        data: {
          status: 'USED',
          usedAt: new Date()
        }
      });

      // Update user verification validity
      const userExpiry = new Date();
      userExpiry.setMinutes(userExpiry.getMinutes() + config.VERIFICATION_VALIDITY_MINUTES);

      const user = await tx.user.update({
        where: { id: session.userId },
        data: { verificationExpiresAt: userExpiry }
      });

      const { redis } = require('../redis');
      await redis.setex(`user:${session.userId}:verified`, config.VERIFICATION_VALIDITY_MINUTES * 60, 'true');

      return { success: true, message: 'Verification successful.', user };
    });
  }

  async isUserVerified(userId: number): Promise<boolean> {
    const { redis } = require('../redis');
    const cached = await redis.get(`user:${userId}:verified`);
    if (cached === 'true') return true;

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return false;
    if (user.plan === 'PREMIUM') {
      await redis.setex(`user:${userId}:verified`, 86400, 'true');
      return true;
    }
    if (!user.verificationExpiresAt) return false;
    
    const isValid = user.verificationExpiresAt > new Date();
    if (isValid) {
      const ttl = Math.floor((user.verificationExpiresAt.getTime() - Date.now()) / 1000);
      if (ttl > 0) {
        await redis.setex(`user:${userId}:verified`, ttl, 'true');
      }
    }
    return isValid;
  }
}

export const verificationService = new VerificationService();
