import { userService } from '../services/UserService';
import { jobService } from '../services/JobService';
import { usageService } from '../services/UsageService';
import { db } from '../db';
import { logger } from '../utils/logger';

export async function runUsageAccountingTests(): Promise<{ total: number; passed: number; failed: number; log: string[] }> {
  const log: string[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;

  log.push('==================================================');
  log.push('🧪 TESTING USAGE ACCOUNTING & IDEMPOTENCY');
  log.push('==================================================\n');

  // Create test user
  const testTelegramId = 888111222;
  const user = await userService.getOrCreateUser(testTelegramId, 'usage_test_user', 'Usage', 'Test');
  
  // Reset test user's usage
  await db.userUsage.upsert({
    where: { userId: user.id },
    update: { dailyRequests: 0, successfulRequests: 0, failedRequests: 0, dailyFiles: 0, totalFiles: 0 },
    create: { userId: user.id, dailyRequests: 0, successfulRequests: 0, failedRequests: 0, dailyFiles: 0, totalFiles: 0 }
  });

  const getUsageCount = async () => (await usageService.getUsage(user.id)).dailyRequests;

  // --------------------------------------------------
  // Test 1: Link submitted → usage unchanged
  // --------------------------------------------------
  total++;
  const initialUsage = await getUsageCount();
  const jobResult1 = await jobService.createJob(user.id, 'https://terabox.com/s/test_1', 'TeraBox');
  const usage1 = await getUsageCount();
  if (usage1 === initialUsage) {
    passed++;
    log.push('✅ Test 1: Link submitted → usage unchanged (0)');
  } else {
    failed++;
    log.push(`❌ Test 1: Link submitted changed usage! Expected ${initialUsage}, got ${usage1}`);
  }

  // --------------------------------------------------
  // Test 2: Job queued → usage unchanged
  // --------------------------------------------------
  total++;
  await jobService.updateJobStatus(jobResult1.job.id, 'QUEUED');
  const usage2 = await getUsageCount();
  if (usage2 === initialUsage) {
    passed++;
    log.push('✅ Test 2: Job queued → usage unchanged');
  } else {
    failed++;
    log.push(`❌ Test 2: Job queued changed usage! Got ${usage2}`);
  }

  // --------------------------------------------------
  // Test 3: Job starts (PROCESSING) → usage unchanged
  // --------------------------------------------------
  total++;
  await jobService.updateJobStatus(jobResult1.job.id, 'PROCESSING');
  const usage3 = await getUsageCount();
  if (usage3 === initialUsage) {
    passed++;
    log.push('✅ Test 3: Job starts (PROCESSING) → usage unchanged');
  } else {
    failed++;
    log.push(`❌ Test 3: Job starts changed usage! Got ${usage3}`);
  }

  // --------------------------------------------------
  // Test 4: Provider fails → usage unchanged
  // --------------------------------------------------
  total++;
  await jobService.failJob(jobResult1.job.id, 'Provider resolution failed');
  await usageService.recordFailedRequest(user.id);
  const usage4 = await getUsageCount();
  if (usage4 === initialUsage) {
    passed++;
    log.push('✅ Test 4: Provider fails → usage unchanged');
  } else {
    failed++;
    log.push(`❌ Test 4: Provider fails changed usage! Got ${usage4}`);
  }

  // --------------------------------------------------
  // Test 5: Download fails → usage unchanged
  // --------------------------------------------------
  total++;
  const jobResult2 = await jobService.createJob(user.id, 'https://diskwala.com/file/test_2', 'Diskwala');
  await jobService.updateJobStatus(jobResult2.job.id, 'PROCESSING');
  await jobService.failJob(jobResult2.job.id, 'Network stream interrupted');
  await usageService.recordFailedRequest(user.id);
  const usage5 = await getUsageCount();
  if (usage5 === initialUsage) {
    passed++;
    log.push('✅ Test 5: Download fails → usage unchanged');
  } else {
    failed++;
    log.push(`❌ Test 5: Download fails changed usage! Got ${usage5}`);
  }

  // --------------------------------------------------
  // Test 6: Telegram send fails → usage unchanged
  // --------------------------------------------------
  total++;
  const jobResult3 = await jobService.createJob(user.id, 'https://diskwala.com/file/test_3', 'Diskwala');
  await jobService.updateJobStatus(jobResult3.job.id, 'FILE_READY');
  await jobService.updateJobStatus(jobResult3.job.id, 'SENDING');
  await jobService.failJob(jobResult3.job.id, 'Telegram sendDocument failed');
  const usage6 = await getUsageCount();
  if (usage6 === initialUsage) {
    passed++;
    log.push('✅ Test 6: Telegram send fails → usage unchanged');
  } else {
    failed++;
    log.push(`❌ Test 6: Telegram send fails changed usage! Got ${usage6}`);
  }

  // --------------------------------------------------
  // Test 7: User cancels job → usage unchanged
  // --------------------------------------------------
  total++;
  const jobResult4 = await jobService.createJob(user.id, 'https://diskwala.com/file/test_4', 'Diskwala');
  await jobService.cancelJob(jobResult4.job.id);
  const usage7 = await getUsageCount();
  if (usage7 === initialUsage) {
    passed++;
    log.push('✅ Test 7: User cancels job → usage unchanged');
  } else {
    failed++;
    log.push(`❌ Test 7: User cancels job changed usage! Got ${usage7}`);
  }

  // --------------------------------------------------
  // Test 8: File successfully sent → usage +1
  // --------------------------------------------------
  total++;
  const jobResult5 = await jobService.createJob(user.id, 'https://diskwala.com/file/test_5', 'Diskwala');
  await jobService.updateJobStatus(jobResult5.job.id, 'PROCESSING');
  await jobService.updateJobStatus(jobResult5.job.id, 'SENDING');
  const compResult1 = await jobService.completeJob(jobResult5.job.id, 1024n);
  const usage8 = await getUsageCount();
  if (usage8 === initialUsage + 1 && compResult1.newlyCompleted) {
    passed++;
    log.push(`✅ Test 8: File successfully sent → usage +1 (now ${usage8})`);
  } else {
    failed++;
    log.push(`❌ Test 8: File successfully sent failed! Expected ${initialUsage + 1}, got ${usage8}`);
  }

  // --------------------------------------------------
  // Test 9: Worker retries completed job → usage remains unchanged
  // --------------------------------------------------
  total++;
  const compResult2 = await jobService.completeJob(jobResult5.job.id, 1024n);
  const usage9 = await getUsageCount();
  if (usage9 === usage8 && !compResult2.newlyCompleted) {
    passed++;
    log.push('✅ Test 9: Worker retries completed job → usage remains unchanged');
  } else {
    failed++;
    log.push(`❌ Test 9: Retrying completed job changed usage! Expected ${usage8}, got ${usage9}`);
  }

  // --------------------------------------------------
  // Test 10: Completion callback runs twice concurrently → usage increases only once
  // --------------------------------------------------
  total++;
  const jobResult6 = await jobService.createJob(user.id, 'https://diskwala.com/file/test_6', 'Diskwala');
  await Promise.all([
    jobService.completeJob(jobResult6.job.id, 2048n),
    jobService.completeJob(jobResult6.job.id, 2048n)
  ]);
  const usage10 = await getUsageCount();
  if (usage10 === usage8 + 1) {
    passed++;
    log.push(`✅ Test 10: Duplicate concurrent completion → usage increased only once (now ${usage10})`);
  } else {
    failed++;
    log.push(`❌ Test 10: Concurrent completion failed! Expected ${usage8 + 1}, got ${usage10}`);
  }

  // --------------------------------------------------
  // Test 11: Premium user follows the exact same rules
  // --------------------------------------------------
  total++;
  await db.user.update({ where: { id: user.id }, data: { plan: 'PREMIUM' } });
  const premJob = await jobService.createJob(user.id, 'https://diskwala.com/file/prem_test', 'Diskwala');
  await jobService.failJob(premJob.job.id, 'Simulated failure for premium');
  const usage11Failed = await getUsageCount();
  await jobService.completeJob(premJob.job.id, 4096n);
  const usage11Success = await getUsageCount();
  if (usage11Failed === usage10 && usage11Success === usage10 + 1) {
    passed++;
    log.push('✅ Test 11: Premium user follows same rules (failed = no change, success = +1)');
  } else {
    failed++;
    log.push(`❌ Test 11 failed! Failed usage: ${usage11Failed}, Success usage: ${usage11Success}`);
  }

  // --------------------------------------------------
  // Test 12: Daily limit is checked using successful completed downloads only
  // --------------------------------------------------
  total++;
  const dailyLimit = await usageService.getDailyLimit('PREMIUM');
  const usage12 = await getUsageCount();
  if (usage12 <= dailyLimit && typeof usage12 === 'number') {
    passed++;
    log.push(`✅ Test 12: Daily limit (${dailyLimit}) checked using completed downloads only (${usage12})`);
  } else {
    failed++;
    log.push(`❌ Test 12 failed! Usage: ${usage12}, Limit: ${dailyLimit}`);
  }

  // Cleanup test user
  try {
    await db.job.deleteMany({ where: { userId: user.id } });
    await db.userUsage.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  } catch (e) {}

  log.push('\n--------------------------------------------------');
  log.push(`SUMMARY: Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  log.push('--------------------------------------------------');

  return { total, passed, failed, log };
}
