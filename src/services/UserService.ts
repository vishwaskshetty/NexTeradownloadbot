import { db } from '../db';
import type { User } from '@prisma/client';
import { logger } from '../utils/logger';

export class UserService {
  async getOrCreateUser(telegramId: number, username?: string, firstName?: string, lastName?: string, languageCode?: string): Promise<User> {
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
      logger.info({ telegramId }, 'Created new user');
    }

    return user;
  }

  async getUser(telegramId: number): Promise<User | null> {
    return db.user.findUnique({
      where: { telegramId: BigInt(telegramId) }
    });
  }

  async updateUserActivity(telegramId: number): Promise<void> {
    await db.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { lastActivity: new Date() }
    });
  }

  async banUser(telegramId: number): Promise<void> {
    await db.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { isBanned: true }
    });
  }

  async unbanUser(telegramId: number): Promise<void> {
    await db.user.update({
      where: { telegramId: BigInt(telegramId) },
      data: { isBanned: false }
    });
  }

  async getUsers(page: number = 1, limit: number = 5) {
    const skip = Math.max(0, (page - 1) * limit);
    const total = await db.user.count();
    const totalPages = Math.ceil(total / limit) || 1;

    const users = await db.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { usage: true }
    });

    return { users, total, totalPages, page };
  }
}

export const userService = new UserService();
