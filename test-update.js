require('ts-node').register();
const { bot } = require('./src/bot');
const { db } = require('./src/db');
const { redis } = require('./src/redis');

(async () => {
  try {
    console.log('Injecting fake /start update...');
    await bot.handleUpdate({
      update_id: 123456,
      message: {
        message_id: 1,
        from: {
          id: 6059191947,
          is_bot: false,
          first_name: 'Test',
          username: 'testuser'
        },
        chat: {
          id: 6059191947,
          type: 'private',
          first_name: 'Test'
        },
        date: Math.floor(Date.now() / 1000),
        text: '/start',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }]
      }
    });
    console.log('Update handled successfully');
  } catch (e) {
    console.error('Update failed:', e);
  } finally {
    await db.$disconnect();
    await redis.quit();
    process.exit(0);
  }
})();
