import { app } from '../src/server';
import { bot } from '../src/bot';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';

// Vercel serverless function entrypoint
// Only configure the webhook if we're actually in Vercel/Production
if (process.env.VERCEL || config.NODE_ENV === 'production') {
  logger.info('Running in Serverless/Production mode. Using Webhook.');
  app.use(bot.webhookCallback('/api/webhook'));
  
  // Try to set the webhook if WEBHOOK_DOMAIN is provided
  if (process.env.WEBHOOK_DOMAIN) {
    bot.telegram.setWebhook(`https://${process.env.WEBHOOK_DOMAIN}/api/webhook`)
      .then(() => logger.info('Webhook set successfully'))
      .catch(e => logger.error(`Failed to set webhook: ${e.message}`));
  }
}

export default app;
