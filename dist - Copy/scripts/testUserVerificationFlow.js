"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const UserService_1 = require("../services/UserService");
const verification_service_1 = require("../verification/verification.service");
const db_1 = require("../db");
const redis_1 = require("../redis");
const config_1 = require("../config");
async function main() {
    console.log('==================================================');
    console.log('🧪 TESTING AROLINKS USER VERIFICATION SYSTEM');
    console.log('==================================================\n');
    // 1. Create or fetch test user
    const testTelegramId = 777333999;
    const user = await UserService_1.userService.getOrCreateUser(testTelegramId, 'arolinks_test_user', 'AroLinks', 'Test');
    // Ensure user is unverified
    await db_1.db.user.update({
        where: { id: user.id },
        data: { verificationExpiresAt: null }
    });
    await redis_1.redis.del(`user:${user.id}:verified`);
    console.log(`👤 Test User ID: ${user.id} (Telegram ID: ${testTelegramId})`);
    // 2. Initial verification check
    const isVerifiedBefore = await verification_service_1.verificationService.isUserVerified(user.id);
    console.log(`1️⃣ Initial Verification Status: ${isVerifiedBefore ? 'VERIFIED ❌' : 'UNVERIFIED ✅'}`);
    if (isVerifiedBefore)
        throw new Error('User should start unverified.');
    // 3. Test link creation when VERIFICATION_BASE_URL is set vs missing
    console.log('\n2️⃣ Testing Verification Session Creation...');
    // Temporary set test base url for testing link generation flow
    config_1.config.VERIFICATION_BASE_URL = 'https://my-test-bot.onrender.com';
    config_1.config.SHORTENER_API_KEY = process.env.SHORTENER_API_KEY || 'test_key';
    const rawTokenTest = require('crypto').randomBytes(32).toString('hex');
    const tokenHashTest = require('../verification/token.service').tokenService.hashToken(rawTokenTest);
    const testSession = await db_1.db.verificationSession.create({
        data: {
            userId: user.id,
            tokenHash: tokenHashTest,
            status: 'PENDING',
            expiresAt: new Date(Date.now() + 86400000),
            shortenerProvider: 'arolinks'
        }
    });
    console.log(`   VerificationSession ID: ${testSession.id}, Status: ${testSession.status}`);
    // 4. Validate verification token (simulates user completing web flow on /verify/:token)
    console.log('\n3️⃣ Simulating User Opening Verification Link (/verify/:token)...');
    const valResult = await verification_service_1.verificationService.validateToken(rawTokenTest);
    console.log(`   Validation Result: ${valResult.success ? 'SUCCESS ✅' : 'FAILED ❌'} - Message: ${valResult.message}`);
    if (!valResult.success)
        throw new Error(`Token validation failed: ${valResult.message}`);
    // 5. Check Verification Status after redemption
    console.log('\n4️⃣ Checking User Verification Status after completion...');
    const isVerifiedAfter = await verification_service_1.verificationService.isUserVerified(user.id);
    console.log(`   Final Verification Status: ${isVerifiedAfter ? 'VERIFIED ✅' : 'UNVERIFIED ❌'}`);
    if (!isVerifiedAfter)
        throw new Error('User should be verified.');
    // 6. Test duplicate token redemption (idempotency check)
    console.log('\n5️⃣ Testing Duplicate Token Redemption...');
    const dupResult = await verification_service_1.verificationService.validateToken(rawTokenTest);
    console.log(`   Duplicate Redemption Result: ${dupResult.success ? 'SUCCESS (Unexpected!)' : 'REJECTED ✅'} - Message: ${dupResult.message}`);
    if (dupResult.success)
        throw new Error('Duplicate redemption should be rejected.');
    // 7. Cleanup test user & sessions
    await db_1.db.verificationSession.deleteMany({ where: { userId: user.id } });
    await db_1.db.userUsage.deleteMany({ where: { userId: user.id } });
    await db_1.db.user.delete({ where: { id: user.id } });
    console.log('\n==================================================');
    console.log('✅ ALL AROLINKS VERIFICATION SYSTEM TESTS PASSED!');
    console.log('==================================================');
}
main().catch(err => {
    console.error('❌ Verification Test Error:', err);
    process.exit(1);
});
