FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Build TypeScript code
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Production image
FROM node:18-alpine

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

ENV NODE_ENV=production

# Expose Webhook server port
EXPOSE 3000

# Start script should run prisma deploy and then the bot
CMD ["npm", "start"]
