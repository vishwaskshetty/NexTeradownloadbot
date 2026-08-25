import 'dotenv/config';
import { runCallbackAudit } from '../utils/callbackTest';

async function main() {
  console.log('Running complete Telegram Callback & Keyboard audit...');
  const result = await runCallbackAudit();
  result.log.forEach((line: string) => console.log(line));
  if (result.failed > 0) {
    console.error(`❌ Callback Audit Failed with ${result.failed} errors.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Audit script error:', err);
  process.exit(1);
});
