"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const client_1 = require("@prisma/client");
const logger_1 = require("../utils/logger");
const prisma = new client_1.PrismaClient({
    log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
    ],
});
prisma.$on('error', (e) => logger_1.logger.error(`Prisma Error: ${e.message}`));
prisma.$on('warn', (e) => logger_1.logger.warn(`Prisma Warn: ${e.message}`));
exports.db = prisma;
