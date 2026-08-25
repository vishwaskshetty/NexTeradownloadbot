"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../db");
const UserService_1 = require("../services/UserService");
const AdminService_1 = require("../services/AdminService");
const UsageService_1 = require("../services/UsageService");
async function runTests() {
    console.log('🧪 STARTING PREMIUM USER MANAGEMENT INTEGRATION TESTS...\n');
    const testAdminId = 999999999;
    const testUserId = 888888888;
    const nonExistentUserId = 777777777;
    try {
        // Ensure global premium feature is enabled for limit checks
        await AdminService_1.adminService.setPremiumStatus(true);
        // Clean up pre-existing test data
        await db_1.db.adminAction.deleteMany({ where: { targetUserTelegramId: BigInt(testUserId) } });
        await db_1.db.user.deleteMany({ where: { telegramId: BigInt(testUserId) } });
        // 1. Create Test User (Initially FREE)
        console.log('1️⃣ Creating test user...');
        let user = await UserService_1.userService.getOrCreateUser(testUserId, 'test_premium_user', 'Test', 'User');
        console.log(`   User created: ID=${user.id}, TelegramId=${user.telegramId}, Plan=${user.plan}, isPremium=${user.isPremium}`);
        // Test 10: Free Daily Limit
        const freeLimit = await UsageService_1.usageService.getDailyLimitForUser(user.id);
        console.log(`   Free User Daily Limit: ${freeLimit}`);
        if (freeLimit !== 5)
            throw new Error('Expected free limit 5');
        // 2. Add Premium (30 days)
        console.log('\n2️⃣ Add Premium for user ID (30 Days)...');
        const addResult = await UserService_1.userService.addPremium(testAdminId, testUserId, 30);
        console.log(`   ✅ Added 30 days premium. New Expiry: ${addResult.newExpiry.toISOString()}`);
        // Test 9: Premium Daily Limit
        const premLimit = await UsageService_1.usageService.getDailyLimitForUser(user.id);
        console.log(`   Premium User Daily Limit: ${premLimit}`);
        if (premLimit !== 50)
            throw new Error('Expected premium limit 50');
        // 3. Add Premium to existing active premium user (Extension test)
        console.log('\n3️⃣ Add Premium to existing active user (+30 Days Extension)...');
        const addAgainResult = await UserService_1.userService.addPremium(testAdminId, testUserId, 30);
        console.log(`   ✅ Extended expiry to: ${addAgainResult.newExpiry.toISOString()}`);
        const expectedDiffDays = Math.round((addAgainResult.newExpiry.getTime() - addResult.newExpiry.getTime()) / (1000 * 60 * 60 * 24));
        console.log(`   Added difference in days: ${expectedDiffDays}`);
        if (expectedDiffDays !== 30)
            throw new Error('Expected expiry to extend by exactly 30 days');
        // 4. Extend Premium (+15 days)
        console.log('\n4️⃣ Extend Premium (+15 Days)...');
        const extResult = await UserService_1.userService.extendPremium(testAdminId, testUserId, 15);
        console.log(`   ✅ Extended expiry to: ${extResult.newExpiry.toISOString()}`);
        // 5. View Premium User Details
        console.log('\n5️⃣ View Premium User Details...');
        const detail = await UserService_1.userService.getPremiumUserDetail(testUserId);
        console.log(`   Status: ${detail?.statusText}, Remaining: ${detail?.remainingDays} days, Daily Limit: ${detail?.dailyLimit}`);
        if (!detail?.isActive)
            throw new Error('Expected user to be active premium');
        // 6. Test Automatic Expiration
        console.log('\n6️⃣ Testing Automatic Expiration (Manually setting expiry to past date)...');
        await db_1.db.user.update({
            where: { id: user.id },
            data: { premiumExpiresAt: new Date(Date.now() - 3600 * 1000) } // 1 hour ago
        });
        const expiredDetail = await UserService_1.userService.getPremiumUserDetail(testUserId);
        console.log(`   After expiration check -> Plan: ${expiredDetail?.user.plan}, isPremium: ${expiredDetail?.user.isPremium}, Status: ${expiredDetail?.statusText}`);
        if (expiredDetail?.user.plan !== 'FREE' || expiredDetail?.user.isPremium) {
            throw new Error('Expected automatic downgrade to FREE');
        }
        // 7. Non-Existent User Error Handling
        console.log('\n7️⃣ Non-existent user error handling...');
        try {
            await UserService_1.userService.addPremium(testAdminId, nonExistentUserId, 30);
            throw new Error('Should have failed for non-existent user');
        }
        catch (e) {
            console.log(`   ✅ Caught expected error: ${e.message}`);
        }
        // 8. Unauthorized Telegram User Check
        console.log('\n8️⃣ Unauthorized Telegram User Admin Check...');
        const isAdmin = AdminService_1.adminService.isAdmin(testUserId);
        console.log(`   Is test user ${testUserId} admin? ${isAdmin}`);
        if (isAdmin)
            throw new Error('Test user should not be admin');
        // 9. Remove Premium
        console.log('\n9️⃣ Remove Premium...');
        await UserService_1.userService.addPremium(testAdminId, testUserId, 30); // Re-add
        const remResult = await UserService_1.userService.removePremium(testAdminId, testUserId);
        console.log(`   ✅ Removed premium. Plan: ${remResult.user.plan}, isPremium: ${remResult.user.isPremium}`);
        if (remResult.user.plan !== 'FREE' || remResult.user.isPremium) {
            throw new Error('Expected user to be FREE after removePremium');
        }
        // 10. Audit Log Verification
        console.log('\n🔟 Verifying Audit Logs...');
        const auditLogs = await db_1.db.adminAction.findMany({
            where: { targetUserTelegramId: BigInt(testUserId) },
            orderBy: { createdAt: 'desc' }
        });
        console.log(`   Total Audit Log Entries: ${auditLogs.length}`);
        auditLogs.forEach(log => {
            console.log(`   - Action: ${log.action}, Details: ${log.details}`);
        });
        if (auditLogs.length < 4)
            throw new Error('Expected audit log entries for all premium actions');
        console.log('\n🎉 ALL 10 INTEGRATION TESTS PASSED SUCCESSFULLY!');
    }
    catch (err) {
        console.error(`\n❌ TEST FAILED: ${err.message}`);
        process.exit(1);
    }
    finally {
        // Cleanup
        await db_1.db.adminAction.deleteMany({ where: { targetUserTelegramId: BigInt(testUserId) } });
        await db_1.db.user.deleteMany({ where: { telegramId: BigInt(testUserId) } });
        await db_1.db.$disconnect();
    }
}
runTests();
