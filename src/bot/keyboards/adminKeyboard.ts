import { Markup } from 'telegraf';

export const getAdminKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📢 Force Subscribe', 'admin_forcesub'), Markup.button.callback('🔐 Verification', 'admin_verification')],
    [Markup.button.callback('⭐ Premium', 'admin_premium'), Markup.button.callback('🔗 Shortener', 'admin_shortener')],
    [Markup.button.callback('👥 Users', 'admin_users'), Markup.button.callback('📈 Statistics', 'admin_statistics')],
    [Markup.button.callback('📢 Broadcast', 'admin_broadcast'), Markup.button.callback('⚙️ Settings', 'admin_settings')],
    [Markup.button.callback('📦 Storage', 'admin_storage'), Markup.button.callback('⚡ Active Jobs', 'admin_jobs')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);
};

export const getAdminForceSubKeyboard = (isEnabled: boolean) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Force Sub' : '🟢 Enable Force Sub', 'admin_toggle_forcesub')],
    [Markup.button.callback('➕ Add Channel Prompt', 'admin_add_channel_prompt'), Markup.button.callback('➖ Remove Channel Prompt', 'admin_remove_channel_prompt')],
    [Markup.button.callback('📋 View Channels', 'admin_list_channels'), Markup.button.callback('✏️ Edit Message Prompt', 'admin_edit_forcesub_msg_prompt')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};

export const getAdminVerificationKeyboard = (isEnabled: boolean) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Verification' : '🟢 Enable Verification', 'admin_toggle_verify')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};

export const getAdminShortenerKeyboard = (isEnabled: boolean) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Shortener' : '🟢 Activate Shortener', 'admin_toggle_shortener')],
    [Markup.button.callback('🧪 Test Shortener', 'admin_test_shortener')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};

export const getAdminPremiumKeyboard = (isEnabled: boolean) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback(isEnabled ? '🔴 Disable Global Premium' : '🟢 Enable Global Premium', 'admin_toggle_premium')],
    [Markup.button.callback('⭐ Add Premium', 'admin_add_premium_prompt'), Markup.button.callback('➕ Extend Premium', 'admin_extend_premium_prompt')],
    [Markup.button.callback('❌ Remove Premium', 'admin_remove_premium_prompt'), Markup.button.callback('👁 View User', 'admin_view_premium_prompt')],
    [Markup.button.callback('📋 Premium Users List', 'admin_list_premium_1')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};

export const getAdminStorageKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Test Storage', 'admin_test_storage'), Markup.button.callback('🧹 Cleanup Storage', 'admin_clean_storage')],
    [Markup.button.callback('⏱️ Retention', 'admin_retention_storage')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};

export const getAdminJobsKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'admin_jobs'), Markup.button.callback('🧹 Cleanup', 'admin_clean_jobs')],
    [Markup.button.callback('🛑 Cancel Job', 'admin_cancel_job_prompt')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};

export const getAdminBroadcastKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'admin_panel')],
    [Markup.button.callback('⬅️ Back', 'admin_panel')]
  ]);
};
