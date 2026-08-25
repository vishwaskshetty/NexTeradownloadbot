import 'dotenv/config';
import { runDiskwalaTests } from '../utils/diskwalaTest';

async function main() {
  const result = await runDiskwalaTests();
  result.log.forEach(line => console.log(line));
  if (result.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
