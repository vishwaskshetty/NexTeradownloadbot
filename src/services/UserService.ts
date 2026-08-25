import { db } from '../db';
import type { User, Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { config } from '../config';

export class UserService {
  /**
   * Automatic expiration guard:
   * Checks if user premium status has expired.
   * If premiumExpiresAt <= current time, automatically downgrades user to FREE.
   */
  async checkAndUpdatePremiumStatus(user: User): Promise<User> {
    if (user.plan === 'PREMIUM' || user.isPremium) {
      if (user.premiumExpiresAt && user.premiumExpiresAt <= new Date()) {
        logger.info(`[UserService] Premium expired for user ${user.telegramId}. Downgrading to FREE.`);
        
        const updatedUser = await db.user.update({
          where: { id: user.id },
          data: {
            plan: 'FREE',
            isPremium: false,
            premiumExpiresAt: null,
          }
        });

        try {
          const { redis } = require('../redis');
          await redis.del(`user:${user.id}:verified`);
        } catch (e) {}

        return updatedUser;
      }
    }
    return user;
  }

  async getOrCreateUser(telegramId: number | bigint, username?: string, firstName?: string, lastName?: string, languageCode?: string): Promise<User> {
    let user = await db.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });

    if (!user) {
      user = await db.user.create({
        data: {
          telegramId: BigInt(telegramId),
          username,
          firstName,
          lastName,
          languageCode,
        }
      });
      logger.info({ telegramId: telegramId.toString() }, 'Created new user');
    }

    return this.checkAndUpdatePremiumStatus(user);
  }

  async getUser(telegramId: number | bigint): Promise<User | null> {
    const user = await db.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });
    if (!user) return null;
    return this.checkAndUpdatePremiumStatus(user);
  }

  async updateUserActivity(telegramId: number | bigint): Promise<void> {
    await db.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { lastActivity: new Date() }
    });
  }

  async banUser(telegramId: number | bigint): Promise<void> {
    await db.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { isBanned: true }
    });
  }

  async unbanUser(telegramId: number | bigint): Promise<void> {
    await db.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { isBanned: false }
    });
  }

  async getUsers(page: number = 1, limit: number = 10) {
    const skip = Math.max(0, (page - 1) * limit);
    const total = await db.user.count();
    const totalPages = Math.ceil(total / limit) || 1;

    let users = await db.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { usage: true }
    });

    // Check expiration for retrieved users
    users = await Promise.all(users.map(u => this.checkAndUpdatePremiumStatus(u) as any));

    return { users, total, totalPages, page };
  }

  /**
   * ADD PREMIUM:
   * Extends existing expiry if user has active premium, or starts new period from current time.
   */
  async addPremium(adminTelegramId: number | bigint, targetTelegramId: number | bigint, days: number) {
    let user = await db.user.findUnique({
      where: { telegramId: BigInt(targetTelegramId) }
    });

    if (!user) {
      throw new Error('❌ User not found.');
    }

    user = await this.checkAndUpdatePremiumStatus(user);

    const now = new Date();
    const durationMs = days * 24 * 60 * 60 * 1000;
    let previousExpiry = user.premiumExpiresAt;
    let newExpiry: Date;

    if (user.isPremium && user.premiumExpiresAt && user.premiumExpiresAt > now) {
      // EXTEND existing active expiry
      newExpiry = new Date(user.premiumExpiresAt.getTime() + durationMs);
    } else {
      // START new period from now
      newExpiry = new Date(now.getTime() + durationMs);
    }

    const updatedUser = await db.user.update({
      where: { id: user.id },
      data: {
        plan: 'PREMIUM',
        isPremium: true,
        premiumExpiresAt: newExpiry,
      }
    });

    // Audit Log
    await db.adminAction.create({
      data: {
        adminUserId: null,
        adminTelegramId: BigInt(adminTelegramId),
        targetUserTelegramId: BigInt(targetTelegramId),
        action: 'ADD_PREMIUM',
        duration: days,
        previousExpiry,
        newExpiry,
        actionType: 'ADD_PREMIUM',
        details: `Added ${days} days premium. New expiry: ${newExpiry.toISOString()}`
      }
    });

    try {
      const { redis } = require('../redis');
      await redis.del(`user:${user.id}:verified`);
    } catch (e) {}

    logger.info(`[UserService] Admin ${adminTelegramId} added ${days} days premium to ${targetTelegramId}`);

    return {
      user: updatedUser,
      previousExpiry,
      newExpiry,
      duration: days
    };
  }

  /**
   * EXTEND PREMIUM:
   * Adds specified duration to current premium expiry or starts from now if expired.
   */
  async extendPremium(adminTelegramId: number | bigint, targetTelegramId: number | bigint, days: number) {
    let user = await db.user.findUnique({
      where: { telegramId: BigInt(targetTelegramId) }
    });

    if (!user) {
      throw new Error('❌ User not found.');
    }

    user = await this.checkAndUpdatePremiumStatus(user);

    const now = new Date();
    const durationMs = days * 24 * 60 * 60 * 1000;
    let previousExpiry = user.premiumExpiresAt;
    let newExpiry: Date;

    if (user.isPremium && user.premiumExpiresAt && user.premiumExpiresAt > now) {
      newExpiry = new Date(user.premiumExpiresAt.getTime() + durationMs);
    } else {
      newExpiry = new Date(now.getTime() + durationMs);
    }

    const updatedUser = await db.user.update({
      where: { id: user.id },
      data: {
        plan: 'PREMIUM',
        isPremium: true,
        premiumExpiresAt: newExpiry,
      }
    });

    // Audit Log
    await db.adminAction.create({
      data: {
        adminUserId: null,
        adminTelegramId: BigInt(adminTelegramId),
        targetUserTelegramId: BigInt(targetTelegramId),
        action: 'EXTEND_PREMIUM',
        duration: days,
        previousExpiry,
        newExpiry,
        actionType: 'EXTEND_PREMIUM',
        details: `Extended premium by ${days} days. New expiry: ${newExpiry.toISOString()}`
      }
    });

    try {
      const { redis } = require('../redis');
      await redis.del(`user:${user.id}:verified`);
    } catch (e) {}

    logger.info(`[UserService] Admin ${adminTelegramId} extended premium for ${targetTelegramId} by ${days} days`);

    return {
      user: updatedUser,
      previousExpiry,
      newExpiry,
      duration: days
    };
  }

  /**
   * REMOVE PREMIUM:
   * Immediately revokes user premium status.
   */
  async removePremium(adminTelegramId: number | bigint, targetTelegramId: number | bigint) {
    const user = await db.user.findUnique({
      where: { telegramId: BigInt(targetTelegramId) }
    });

    if (!user) {
      throw new Error('❌ User not found.');
    }

    const previousExpiry = user.premiumExpiresAt;

    const updatedUser = await db.user.update({
      where: { id: user.id },
      data: {
        plan: 'FREE',
        isPremium: false,
        premiumExpiresAt: null,
      }
    });

    // Audit Log
    await db.adminAction.create({
      data: {
        adminUserId: null,
        adminTelegramId: BigInt(adminTelegramId),
        targetUserTelegramId: BigInt(targetTelegramId),
        action: 'REMOVE_PREMIUM',
        duration: 0,
        previousExpiry,
        newExpiry: null,
        actionType: 'REMOVE_PREMIUM',
        details: `Removed premium subscription. Previous expiry was: ${previousExpiry ? previousExpiry.toISOString() : 'None'}`
      }
    });

    try {
      const { redis } = require('../redis');
      await redis.del(`user:${user.id}:verified`);
    } catch (e) {}

    logger.info(`[UserService] Admin ${adminTelegramId} removed premium for ${targetTelegramId}`);

    return {
      user: updatedUser,
      previousExpiry
    };
  }

  /**
   * VIEW PREMIUM USER DETAILS
   */
  async getPremiumUserDetail(targetTelegramId: number | bigint) {
    const rawUser = await db.user.findUnique({
      where: { telegramId: BigInt(targetTelegramId) },
      include: { usage: true }
    });

    if (!rawUser) return null;

    const user = await this.checkAndUpdatePremiumStatus(rawUser);

    const now = new Date();
    const isActive = user.isPremium && user.plan === 'PREMIUM' && user.premiumExpiresAt && user.premiumExpiresAt > now;
    const remainingMs = user.premiumExpiresAt ? Math.max(0, user.premiumExpiresAt.getTime() - now.getTime()) : 0;
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

    return {
      user,
      isActive,
      statusText: isActive ? '🟢 ACTIVE' : (user.premiumExpiresAt ? '🔴 EXPIRED' : '⚪ FREE USER'),
      remainingDays,
      dailyLimit: isActive ? config.PREMIUM_DAILY_LIMIT : config.FREE_DAILY_LIMIT
    };
  }

  /**
   * LIST PREMIUM USERS WITH PAGINATION AND SEARCH BY TELEGRAM USER ID / USERNAME
   */
  async getPremiumUsersList(page: number = 1, limit: number = 10, search?: string) {
    const skip = Math.max(0, (page - 1) * limit);

    let whereClause: Prisma.UserWhereInput = {
      OR: [
        { isPremium: true },
        { plan: 'PREMIUM' }
      ]
    };

    if (search && search.trim()) {
      const query = search.trim();
      const numSearch = Number(query);

      if (!isNaN(numSearch)) {
        whereClause = {
          AND: [
            whereClause,
            { telegramId: BigInt(numSearch) }
          ]
        };
      } else {
        whereClause = {
          AND: [
            whereClause,
            { username: { contains: query.replace(/^@/, ''), mode: 'insensitive' } }
          ]
        };
      }
    }

    const total = await db.user.count({ where: whereClause });
    const totalPages = Math.ceil(total / limit) || 1;

    let users = await db.user.findMany({
      where: whereClause,
      skip,
      take: limit,
      orderBy: [
        { premiumExpiresAt: 'asc' },
        { createdAt: 'desc' }
      ],
      include: { usage: true }
    });

    // Run expiration check for each retrieved user
    users = await Promise.all(users.map(u => this.checkAndUpdatePremiumStatus(u) as any));

    return { users, total, totalPages, page };
  }
}

export const userService = new UserService();
