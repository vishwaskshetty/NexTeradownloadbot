import { db } from '../db';
import type { VerificationSession, User, Prisma } from '@prisma/client';
import { tokenService } from './token.service';
import { getShortenerProvider } from './shortener.service';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface VerificationFlowResult {
  success: boolean;
  shortUrl: string;
  token: string;
  duration: number;
}

export class VerificationService {
  /**
   * Generates a new verification session for a user with a 15-minute token validity
   * and returns the actual AroLinks short URL targeting the Telegram bot deep link.
   * Completely removes dependency on VERIFICATION_BASE_URL.
   */
  async createVerificationFlow(userId: number, botUsername?: string): Promise<VerificationFlowResult> {
    const targetBotUsername = botUsername || process.env.BOT_USERNAME || 'NexTeraDownloadBot';

    const rawToken = tokenService.generateSecureToken(32);
    const tokenHash = tokenService.hashToken(rawToken);
    
    // Strict 15 minutes token validity for verification link completion
    const linkExpiry = new Date(Date.now() + 15 * 60 * 1000);

    const provider = await getShortenerProvider();
    const providerName = provider.getProviderName();

    // Create session in DB with 15-min expiration
    const session = await db.verificationSession.create({
      data: {
        userId,
        tokenHash,
        status: 'PENDING',
        expiresAt: linkExpiry,
        shortenerProvider: providerName
      }
    });

    // Destination callback URL: Telegram bot deep link
    // When user completes AroLinks, AroLinks redirects to https://t.me/<BotUsername>?start=verify_<token>
    const destinationUrl = `https://t.me/${targetBotUsername}?start=verify_${rawToken}`;
    
    // Fetch real shortened URL returned by AroLinks API
    const shortUrl = await provider.createShortUrl(destinationUrl);
    
    if (!shortUrl || typeof shortUrl !== 'string' || !shortUrl.startsWith('http')) {
      throw new Error('AroLinks API returned an invalid or missing short URL.');
    }

    // Store short URL reference in DB
    await db.verificationSession.update({
      where: { id: session.id },
      data: { shortenerReference: shortUrl }
    });

    return {
      success: true,
      shortUrl,
      token: rawToken,
      duration: 15
    };
  }

  /**
   * Validates an internal token sent from Telegram deep link (/start verify_<token>)
   * or web callback (/verify/:token).
   * Enforces 15-minute expiration, single-use, and prevents token reuse.
   */
  async validateToken(rawToken: string): Promise<{ success: boolean; message: string; user?: User }> {
    const tokenHash = tokenService.hashToken(rawToken);

    // Run within a transaction to prevent race conditions on verification
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.verificationSession.findUnique({
        where: { tokenHash },
        include: { user: true }
      });

      if (!session) {
        return { success: false, message: 'Invalid or unrecognized verification token.' };
      }

      if (session.status === 'VERIFIED' || session.status === 'USED') {
        return { success: false, message: 'This verification link has already been used.' };
      }

      if (session.status === 'EXPIRED' || session.expiresAt < new Date()) {
        await tx.verificationSession.update({
          where: { id: session.id },
          data: { status: 'EXPIRED' }
        });
        return { success: false, message: 'This verification link has expired (15-minute limit exceeded).' };
      }

      if (session.status !== 'PENDING') {
        return { success: false, message: 'Invalid verification session state.' };
      }

      // Mark session as USED to prevent token reuse
      await tx.verificationSession.update({
        where: { id: session.id },
        data: {
          status: 'USED',
          usedAt: new Date()
        }
      });

      // Update user verification validity (15 minutes or configured validity)
      const userExpiryMinutes = config.VERIFICATION_VALIDITY_MINUTES || 15;
      const userExpiry = new Date(Date.now() + userExpiryMinutes * 60 * 1000);

      const user = await tx.user.update({
        where: { id: session.userId },
        data: { verificationExpiresAt: userExpiry }
      });

      const { redis } = require('../redis');
      await redis.setex(`user:${session.userId}:verified`, userExpiryMinutes * 60, 'true');

      logger.info(`[VerificationService] User ${session.userId} successfully verified via token.`);

      return { success: true, message: 'Verification successful.', user };
    });
  }

  /**
   * Checks whether the user has an active verified session.
   */
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
