# NexTeraDownloadBot

A highly scalable, production-ready Telegram Bot built with Telegraf, TypeScript, PostgreSQL, Prisma, Redis, and BullMQ. Designed for secure link processing with robust anti-spam and verification gates.

## Features
- **Scalable Queue**: BullMQ & Redis backed asynchronous job queue.
- **Verification System**: Enforces usage via URL shorteners to monetize free users safely without abusing Captchas.
- **Dynamic Limits**: Separate limits for FREE and PREMIUM users.
- **Admin Commands**: Extensive `/stats`, `/ban`, `/broadcast`, and `/premium` management.

## Environment Variables
Copy `.env.example` to `.env` and fill in the values:
- `BOT_TOKEN`: Your Telegram Bot API token.
- `DATABASE_URL`: PostgreSQL connection string.
- `REDIS_URL`: Redis connection string.
- `SHORTENER_PROVIDER`: The URL shortener provider (e.g. `bitly` or `mock`).
- `VERIFICATION_BASE_URL`: The URL where the bot's Webhook server is accessible.
- `ADMIN_TELEGRAM_IDS`: Comma-separated list of admin Telegram IDs.

## Running Locally (Docker)
1. Ensure Docker and Docker Compose are installed.
2. Configure `.env`.
3. Run `docker-compose up -d --build`.

## Running Locally (Node)
1. `npm install`
2. `npx prisma migrate dev`
3. `npm run dev`

## Available Commands
- `/start`: Open the main menu.
- `My Account`: Check usage and limits.
- `/verification on/off/status`: Admins only. Enable or disable the verification gate.
- `/broadcast <msg>`: Push a message to all users safely via queue.
