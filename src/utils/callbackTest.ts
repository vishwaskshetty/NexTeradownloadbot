import { callbackHandler } from '../bot/handlers/callback';
import { adminService } from '../services/AdminService';
import { userService } from '../services/UserService';

/**
 * Automated Button Audit and Route Verification Tool
 * Runs through all registered callback_data routes with mock contexts
 */
export async function runCallbackAudit(): Promise<{ total: number; passed: number; failed: number; log: string[] }> {
  const log: string[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;

  const callbacksToTest = [
    // User callbacks
    { data: 'main_menu', name: 'Main Menu', adminOnly: false },
    { data: 'download', name: 'Download', adminOnly: false },
    { data: 'account', name: 'Account', adminOnly: false },
    { data: 'my_status', name: 'My Status', adminOnly: false },
    { data: 'verification', name: 'Verification', adminOnly: false },
    { data: 'verify_check', name: 'Check Verification', adminOnly: false },
    { data: 'premium', name: 'Premium', adminOnly: false },
    { data: 'help', name: 'Help', adminOnly: false },

    // Admin callbacks
    { data: 'admin_panel', name: 'Admin Panel', adminOnly: true },
    { data: 'admin_verification', name: 'Admin Verification', adminOnly: true },
    { data: 'admin_toggle_verify', name: 'Admin Toggle Verify', adminOnly: true },
    { data: 'admin_shortener', name: 'Admin Shortener', adminOnly: true },
    { data: 'admin_toggle_shortener', name: 'Admin Toggle Shortener', adminOnly: true },
    { data: 'admin_premium', name: 'Admin Premium', adminOnly: true },
    { data: 'admin_toggle_premium', name: 'Admin Toggle Premium', adminOnly: true },
    { data: 'admin_status', name: 'Admin Status', adminOnly: true },
    { data: 'refresh', name: 'Refresh Status', adminOnly: true },
    { data: 'admin_users', name: 'Admin Users', adminOnly: true },
    { data: 'admin_users_1', name: 'Admin Users Page 1', adminOnly: true },
    { data: 'admin_statistics', name: 'Admin Statistics', adminOnly: true },
    { data: 'admin_broadcast', name: 'Admin Broadcast', adminOnly: true },
    { data: 'admin_settings', name: 'Admin Settings', adminOnly: true },
    { data: 'admin_storage', name: 'Admin Storage', adminOnly: true },
    { data: 'admin_jobs', name: 'Admin Jobs', adminOnly: true },

    // Misc / System
    { data: 'noop', name: 'Pagination Noop', adminOnly: false },
    { data: 'outdated_callback_test', name: 'Outdated Callback Handler', adminOnly: false }
  ];

  const adminUser = await userService.getOrCreateUser(6059191947, 'test_admin', 'Admin', 'User');
  const normalUser = await userService.getOrCreateUser(999999999, 'test_user', 'Normal', 'User');

  log.push('==================================================');
  log.push('🧪 AUTOMATED TELEGRAM CALLBACK ROUTE AUDIT');
  log.push('==================================================\n');

  for (const item of callbacksToTest) {
    total++;
    let success = false;
    let editCalled = false;
    let answerCalled = false;

    const mockCtx: any = {
      callbackQuery: { data: item.data },
      state: { user: item.adminOnly ? adminUser : normalUser },
      answerCbQuery: async (text?: string) => {
        answerCalled = true;
        return true;
      },
      editMessageText: async (text: string, extra: any) => {
        editCalled = true;
        return true;
      }
    };

    try {
      await callbackHandler(mockCtx);
      // Success if executed without error and either answered or edited message
      success = answerCalled || editCalled;
    } catch (e: any) {
      log.push(`❌ ${item.name} (${item.data}): FAILED - ${e.message}`);
    }

    if (success) {
      passed++;
      log.push(`✅ ${item.name} [${item.data}] -> OK`);
    } else {
      failed++;
      log.push(`❌ ${item.name} [${item.data}] -> NO RESPONSE`);
    }
  }

  log.push('\n--------------------------------------------------');
  log.push(`SUMMARY: Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  log.push('--------------------------------------------------');

  return { total, passed, failed, log };
}
