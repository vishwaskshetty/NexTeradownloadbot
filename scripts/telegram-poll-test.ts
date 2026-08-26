import 'dotenv/config';
import axios from 'axios';

async function runTelegramPollTest() {
  const token = process.env.BOT_TOKEN;
  console.log('======================================================');
  console.log('=== TELEGRAM POLLING ISOLATED DIAGNOSTIC TEST ===');
  console.log('======================================================');

  if (!token || token.trim().length === 0) {
    console.log('[Telegram Health] BOT_TOKEN configured: NO');
    process.exit(1);
  }

  console.log('[Telegram Health] BOT_TOKEN configured: YES');
  const baseUrl = `https://api.telegram.org/bot${token}`;

  // TEST A: getMe
  console.log('\n--- TEST A: getMe ---');
  try {
    const res = await axios.get(`${baseUrl}/getMe`, { timeout: 10000 });
    if (res.data && res.data.ok) {
      console.log('[Telegram Health] getMe: SUCCESS');
      console.log(`[Telegram Health] Bot username: @${res.data.result.username}`);
      console.log(`[Telegram Health] Bot ID: ${res.data.result.id}`);
    } else {
      console.log('[Telegram Health] getMe: FAIL -', res.data);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`[Telegram Health] getMe Error: ${err.message}`, err.response?.data);
    process.exit(1);
  }

  // TEST B: getWebhookInfo
  console.log('\n--- TEST B: getWebhookInfo ---');
  try {
    const res = await axios.get(`${baseUrl}/getWebhookInfo`, { timeout: 10000 });
    const info = res.data?.result || {};
    const webhookUrl = info.url || '<empty>';
    console.log(`[Telegram Health] Webhook URL: ${webhookUrl}`);
    console.log(`[Telegram Health] Pending updates: ${info.pending_update_count ?? 0}`);
  } catch (err: any) {
    console.error(`[Telegram Health] getWebhookInfo Error: ${err.message}`);
  }

  // TEST C: deleteWebhook
  console.log('\n--- TEST C: deleteWebhook ---');
  try {
    const res = await axios.post(`${baseUrl}/deleteWebhook`, { drop_pending_updates: false }, { timeout: 10000 });
    console.log(`[Telegram Health] Webhook removed: ${res.data?.ok ? 'YES' : 'NO'}`);
  } catch (err: any) {
    console.error(`[Telegram Health] deleteWebhook Error: ${err.message}`);
  }

  // TEST D: getUpdates directly
  console.log('\n--- TEST D: getUpdates direct check ---');
  console.log('[Telegram Health] getUpdates request: SENT');
  try {
    const res = await axios.get(`${baseUrl}/getUpdates`, {
      params: { timeout: 3, limit: 10 },
      timeout: 8000,
    });
    if (res.data && res.data.ok) {
      const updates = res.data.result || [];
      console.log('[Telegram Health] getUpdates response: SUCCESS');
      console.log(`[Telegram Health] Update count: ${updates.length}`);
      for (const update of updates) {
        console.log(`[Telegram Health] update_id received: ${update.update_id}`);
        console.log(`[Telegram Health] update accepted: YES`);
      }
    } else {
      console.log('[Telegram Health] getUpdates response: FAIL -', res.data);
    }
  } catch (err: any) {
    if (err.response?.status === 409) {
      console.error('[Telegram Health] 409 CONFLICT');
      console.error('[Telegram Health] This BOT_TOKEN is being polled elsewhere.');
    } else {
      console.error(`[Telegram Health] getUpdates Error: ${err.message}`, err.response?.data);
    }
  }
}

runTelegramPollTest().catch(console.error);
