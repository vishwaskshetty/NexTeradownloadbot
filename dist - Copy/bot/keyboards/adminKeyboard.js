"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminBroadcastKeyboard = exports.getAdminJobsKeyboard = exports.getAdminStorageKeyboard = exports.getAdminPremiumKeyboard = exports.getAdminShortenerKeyboard = exports.getAdminVerificationKeyboard = exports.getAdminForceSubKeyboard = exports.getAdminKeyboard = void 0;
const telegraf_1 = require("telegraf");
const getAdminKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('📢 Force Subscribe', 'admin_forcesub'), telegraf_1.Markup.button.callback('🔐 Verification', 'admin_verification')],
        [telegraf_1.Markup.button.callback('⭐ Premium', 'admin_premium'), telegraf_1.Markup.button.callback('🔗 Shortener', 'admin_shortener')],
        [telegraf_1.Markup.button.callback('👥 Users', 'admin_users'), telegraf_1.Markup.button.callback('📈 Statistics', 'admin_statistics')],
        [telegraf_1.Markup.button.callback('📢 Broadcast', 'admin_broadcast'), telegraf_1.Markup.button.callback('⚙️ Settings', 'admin_settings')],
        [telegraf_1.Markup.button.callback('📦 Storage', 'admin_storage'), telegraf_1.Markup.button.callback('⚡ Active Jobs', 'admin_jobs')],
        [telegraf_1.Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ]);
};
exports.getAdminKeyboard = getAdminKeyboard;
const getAdminForceSubKeyboard = (isEnabled) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback(isEnabled ? '🔴 Disable Force Sub' : '🟢 Enable Force Sub', 'admin_toggle_forcesub')],
        [telegraf_1.Markup.button.callback('➕ Add Channel Prompt', 'admin_add_channel_prompt'), telegraf_1.Markup.button.callback('➖ Remove Channel Prompt', 'admin_remove_channel_prompt')],
        [telegraf_1.Markup.button.callback('📋 View Channels', 'admin_list_channels'), telegraf_1.Markup.button.callback('✏️ Edit Message Prompt', 'admin_edit_forcesub_msg_prompt')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminForceSubKeyboard = getAdminForceSubKeyboard;
const getAdminVerificationKeyboard = (isEnabled) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback(isEnabled ? '🔴 Disable Verification' : '🟢 Enable Verification', 'admin_toggle_verify')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminVerificationKeyboard = getAdminVerificationKeyboard;
const getAdminShortenerKeyboard = (isEnabled) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback(isEnabled ? '🔴 Disable Shortener' : '🟢 Activate Shortener', 'admin_toggle_shortener')],
        [telegraf_1.Markup.button.callback('🧪 Test Shortener', 'admin_test_shortener')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminShortenerKeyboard = getAdminShortenerKeyboard;
const getAdminPremiumKeyboard = (isEnabled) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback(isEnabled ? '🔴 Disable Global Premium' : '🟢 Enable Global Premium', 'admin_toggle_premium')],
        [telegraf_1.Markup.button.callback('⭐ Add Premium', 'admin_add_premium_prompt'), telegraf_1.Markup.button.callback('➕ Extend Premium', 'admin_extend_premium_prompt')],
        [telegraf_1.Markup.button.callback('❌ Remove Premium', 'admin_remove_premium_prompt'), telegraf_1.Markup.button.callback('👁 View User', 'admin_view_premium_prompt')],
        [telegraf_1.Markup.button.callback('📋 Premium Users List', 'admin_list_premium_1')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminPremiumKeyboard = getAdminPremiumKeyboard;
const getAdminStorageKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('🔄 Test Storage', 'admin_test_storage'), telegraf_1.Markup.button.callback('🧹 Cleanup Storage', 'admin_clean_storage')],
        [telegraf_1.Markup.button.callback('⏱️ Retention', 'admin_retention_storage')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminStorageKeyboard = getAdminStorageKeyboard;
const getAdminJobsKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('🔄 Refresh', 'admin_jobs'), telegraf_1.Markup.button.callback('🧹 Cleanup', 'admin_clean_jobs')],
        [telegraf_1.Markup.button.callback('🛑 Cancel Job', 'admin_cancel_job_prompt')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminJobsKeyboard = getAdminJobsKeyboard;
const getAdminBroadcastKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('❌ Cancel', 'admin_panel')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'admin_panel')]
    ]);
};
exports.getAdminBroadcastKeyboard = getAdminBroadcastKeyboard;
