import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'info' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('error', (e: any) => logger.error(`Prisma Error: ${e.message}`));
prisma.$on('warn', (e: any) => logger.warn(`Prisma Warn: ${e.message}`));

export const db = prisma;
