import 'dotenv/config';
import { runUsageAccountingTests } from '../utils/usageAccountingTest';

async function main() {
  const result = await runUsageAccountingTests();
  result.log.forEach(line => console.log(line));
  if (result.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
