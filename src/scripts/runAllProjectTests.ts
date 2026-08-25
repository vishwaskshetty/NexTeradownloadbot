import { db } from '../db';
import { userService } from '../services/UserService';
import { adminService } from '../services/AdminService';
import { usageService } from '../services/UsageService';
import { verificationService } from '../verification/verification.service';
import { referralService } from '../services/ReferralService';
import { tokenService } from '../verification/token.service';

async function runAllTests() {
  console.log('==================================================');
  console.log('🧪 RUNNING FULL COMPREHENSIVE PROJECT TEST SUITE');
  console.log('==================================================\n');

  const adminTelegramId = 6059191947;
  const user1TelegramId = 111111111;
  const user2TelegramId = 222222222;

  try {
    // Ensure settings
    await adminService.setPremiumStatus(true);
    await adminService.setReferralStatus(true);
    await adminService.setReferralsRequired(10);
    await adminService.setReferralRewardDays(5);

    // Clean up test data
    await db.adminAction.deleteMany({ where: { OR: [{ adminTelegramId: BigInt(adminTelegramId) }, { targetUserTelegramId: BigInt(user1TelegramId) }, { targetUserTelegramId: BigInt(user2TelegramId) }] } });
    await db.userUsage.deleteMany({});
    await db.referralMilestone.deleteMany({});
    await db.referral.deleteMany({});
    await db.verificationSession.deleteMany({});
    await db.user.deleteMany({ where: { OR: [{ telegramId: BigInt(user1TelegramId) }, { telegramId: BigInt(user2TelegramId) }] } });

    // Create Test Users
    const u1 = await userService.getOrCreateUser(user1TelegramId, 'user_one', 'User', 'One');
    const u2 = await userService.getOrCreateUser(user2TelegramId, 'user_two', 'User', 'Two');

    console.log('--------------------------------------------------');
    console.log('SECTION 1: TOKEN VERIFICATION SYSTEM TESTS');
    console.log('--------------------------------------------------');

    // Test 1.1: Verification Flow Creation & Token Generation
    console.log('1.1 Testing Verification Flow Creation...');
    const flowResult = await verificationService.createVerificationFlow(u1.id, 'NexTeraDownloadBot');
    console.log(`    Generated Short URL: ${flowResult.shortUrl}`);
    console.log(`    Generated Internal Token: ${flowResult.token.substring(0, 8)}...`);
    if (!flowResult.success || !flowResult.token || !flowResult.shortUrl) {
      throw new Error('Failed to create verification flow');
    }

    // Test 1.2: Validate Valid Token
    console.log('1.2 Validating Valid Token...');
    const valResult = await verificationService.validateToken(flowResult.token);
    console.log(`    Validation Result: ${valResult.message}`);
    if (!valResult.success) throw new Error('Valid token validation failed');

    // Test 1.3: Validate Reused Token Rejection
    console.log('1.3 Validating Reused Token Rejection...');
    const reusedVal = await verificationService.validateToken(flowResult.token);
    console.log(`    Reused Token Result: ${reusedVal.message}`);
    if (reusedVal.success) throw new Error('Reused token should have been rejected');

    // Test 1.4: Validate Invalid Token Rejection
    console.log('1.4 Validating Invalid Token Rejection...');
    const invalidVal = await verificationService.validateToken('invalid_token_1234567890');
    console.log(`    Invalid Token Result: ${invalidVal.message}`);
    if (invalidVal.success) throw new Error('Invalid token should have been rejected');

    // Test 1.5: Validate Expired Token Rejection
    console.log('1.5 Validating Expired Token Rejection...');
    const expiredRawToken = tokenService.generateSecureToken(32);
    const expiredHash = tokenService.hashToken(expiredRawToken);
    await db.verificationSession.create({
      data: {
        userId: u1.id,
        tokenHash: expiredHash,
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 3600 * 1000) // 1 hour ago
      }
    });
    const expiredVal = await verificationService.validateToken(expiredRawToken);
    console.log(`    Expired Token Result: ${expiredVal.message}`);
    if (expiredVal.success) throw new Error('Expired token should have been rejected');

    console.log('\n--------------------------------------------------');
    console.log('SECTION 2: USAGE ACCOUNTING TESTS');
    console.log('--------------------------------------------------');

    // Test 2.1: Failed Request does NOT increment daily limit quota
    console.log('2.1 Testing Failed Request Quota Guard...');
    const initialUsage = await usageService.getUsage(u1.id);
    await usageService.recordFailedRequest(u1.id);
    const postFailedUsage = await usageService.getUsage(u1.id);
    console.log(`    Initial dailyRequests: ${initialUsage.dailyRequests}, Post-failed dailyRequests: ${postFailedUsage.dailyRequests}`);
    if (postFailedUsage.dailyRequests !== initialUsage.dailyRequests) {
      throw new Error('Failed request must not increment dailyRequests');
    }

    console.log('\n--------------------------------------------------');
    console.log('SECTION 3: REFERRAL REWARD SYSTEM TESTS');
    console.log('--------------------------------------------------');

    // Test 3.1: Self-Referral Rejection
    console.log('3.1 Testing Self-Referral Rejection...');
    const selfRef = await referralService.processReferral(user1TelegramId, user1TelegramId);
    console.log(`    Self-referral result: ${selfRef.message}`);
    if (selfRef.success) throw new Error('Self-referral must be rejected');

    // Test 3.2: Valid Referral Registration
    console.log('3.2 Testing Valid Referral Registration...');
    const validRef = await referralService.processReferral(user1TelegramId, user2TelegramId);
    console.log(`    Valid referral result: ${validRef.message}`);
    if (!validRef.success) throw new Error('Valid referral failed');

    // Test 3.3: Duplicate Referral Rejection
    console.log('3.3 Testing Duplicate Referral Rejection...');
    const dupRef = await referralService.processReferral(user1TelegramId, user2TelegramId);
    console.log(`    Duplicate referral result: ${dupRef.message}`);
    if (dupRef.success) throw new Error('Duplicate referral must be rejected');

    // Test 3.4: Referral Milestones (9 referrals = no reward, 10 referrals = +5 days)
    console.log('3.4 Testing Referral Milestones & Reward Integration...');
    for (let i = 3; i <= 10; i++) {
      const dummyId = 300000000 + i;
      await userService.getOrCreateUser(dummyId, `dummy_${i}`);
      await referralService.processReferral(user1TelegramId, dummyId);
    }

    // Now total referrals = 9
    let stats = await referralService.getReferralStats(user1TelegramId);
    console.log(`    Referrals Count: ${stats.totalReferrals}/10, Progress Bar: ${stats.progressBar}`);
    if (stats.totalReferrals !== 9) throw new Error('Expected 9 referrals');

    let u1Check = await userService.getUser(user1TelegramId);
    if (u1Check?.isPremium) throw new Error('User should not be premium at 9 referrals');

    // Add 10th referral -> Triggers Milestone #1 (+5 days premium)
    console.log('3.5 Adding 10th Referral (Triggers Milestone #1)...');
    await userService.getOrCreateUser(300000011, 'dummy_11');
    await referralService.processReferral(user1TelegramId, 300000011);

    stats = await referralService.getReferralStats(user1TelegramId);
    console.log(`    Referrals Count: ${stats.totalReferrals}/10, Total Milestones: ${stats.totalMilestonesClaimed}, Premium Days Earned: ${stats.totalDaysEarned}`);

    u1Check = await userService.getUser(user1TelegramId);
    console.log(`    User #1 Premium Status: isPremium=${u1Check?.isPremium}, Expiry=${u1Check?.premiumExpiresAt?.toISOString()}`);
    if (!u1Check?.isPremium) throw new Error('Expected user to be awarded premium at 10 referrals');

    // Test 3.6: Idempotent Restart Test (re-evaluating milestones does not duplicate awards)
    console.log('3.6 Testing Idempotent Milestone Re-Evaluation Safety...');
    await referralService.checkAndAwardMilestones(u1Check.id, BigInt(user1TelegramId));
    const milestonesCount = await db.referralMilestone.count({ where: { referrerUserId: u1Check.id } });
    console.log(`    Milestones recorded in DB: ${milestonesCount}`);
    if (milestonesCount !== 1) throw new Error('Milestone should not be duplicated');

    console.log('\n--------------------------------------------------');
    console.log('SECTION 4: PREMIUM EXPIRATION & EXTENSION TESTS');
    console.log('--------------------------------------------------');

    // Test 4.1: Manual Admin Extension adds to existing referral premium
    console.log('4.1 Manual Admin Extension (+30 Days)...');
    const oldExp = u1Check.premiumExpiresAt!;
    const extResult = await userService.extendPremium(adminTelegramId, user1TelegramId, 30);
    console.log(`    Previous Expiry: ${oldExp.toISOString()}, New Expiry: ${extResult.newExpiry.toISOString()}`);
    const diffDays = Math.round((extResult.newExpiry.getTime() - oldExp.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays !== 30) throw new Error('Manual extension must extend existing expiry by exactly 30 days');

    // Test 4.2: Automatic Expiration Downgrade
    console.log('4.2 Testing Automatic Expiration Downgrade...');
    await db.user.update({
      where: { id: u1Check.id },
      data: { premiumExpiresAt: new Date(Date.now() - 60000) } // 1 min ago
    });
    const downgradedUser = await userService.getUser(user1TelegramId);
    console.log(`    Post Expiration Check -> plan: ${downgradedUser?.plan}, isPremium: ${downgradedUser?.isPremium}`);
    if (downgradedUser?.plan !== 'FREE' || downgradedUser?.isPremium) {
      throw new Error('Expired premium user must be automatically downgraded to FREE');
    }

    console.log('\n==================================================');
    console.log('🎉 ALL PROJECT SYSTEM TESTS PASSED SUCCESSFULLY!');
    console.log('==================================================');
  } catch (err: any) {
    console.error(`\n❌ TEST SUITE FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    // Cleanup test data
    await db.adminAction.deleteMany({ where: { targetUserTelegramId: BigInt(user1TelegramId) } });
    await db.referralMilestone.deleteMany({});
    await db.referral.deleteMany({});
    await db.verificationSession.deleteMany({});
    await db.userUsage.deleteMany({});
    await db.user.deleteMany({ where: { telegramId: { in: [BigInt(user1TelegramId), BigInt(user2TelegramId)] } } });
    await db.$disconnect();
  }
}

runAllTests();
