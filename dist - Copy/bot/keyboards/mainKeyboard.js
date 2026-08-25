"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVerifiedKeyboard = exports.getVerificationExpiredKeyboard = exports.getAroLinksVerifyKeyboard = exports.getVerificationPromptKeyboard = exports.getVerificationRequiredKeyboard = exports.getMyStatusKeyboard = exports.getReferralKeyboard = exports.getAccountKeyboard = exports.getBackKeyboard = exports.getMainKeyboard = exports.getDisclaimerText = void 0;
const telegraf_1 = require("telegraf");
const getDisclaimerText = () => {
    return `⚠️ *DISCLAIMER*

This bot is provided for personal and informational purposes only.

• We do not host, store, or own any files available through this bot.
• We are not responsible for the content, copyright, legality, accuracy, or availability of files obtained through third-party services.
• Users are solely responsible for how they use this bot and any content accessed through it.
• We do not take responsibility for any loss, damage, misuse, or issues caused by third-party links or services.
• Please respect copyright laws and the terms of service of the platforms you use.

By using this bot, you agree that you use it at your own risk.

📩 *For support or concerns:*
👉 @Nr_willHelpYouBot`;
};
exports.getDisclaimerText = getDisclaimerText;
const getMainKeyboard = (isAdmin = false, showVerification = true) => {
    const buttons = [
        [telegraf_1.Markup.button.callback('📥 Download', 'download'), telegraf_1.Markup.button.callback('👤 Account', 'account')],
        [telegraf_1.Markup.button.callback('📊 My Status', 'my_status'), telegraf_1.Markup.button.callback('🎁 Referrals', 'referrals')],
    ];
    if (showVerification) {
        buttons.push([telegraf_1.Markup.button.callback('🔐 Verification', 'verification'), telegraf_1.Markup.button.callback('⭐ Premium', 'premium')]);
    }
    else {
        buttons.push([telegraf_1.Markup.button.callback('⭐ Premium', 'premium')]);
    }
    buttons.push([telegraf_1.Markup.button.callback('❓ Help', 'help'), telegraf_1.Markup.button.callback('⚠️ Disclaimer', 'disclaimer')]);
    if (isAdmin) {
        buttons.push([telegraf_1.Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
    }
    return telegraf_1.Markup.inlineKeyboard(buttons);
};
exports.getMainKeyboard = getMainKeyboard;
const getBackKeyboard = (target = 'main_menu') => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('⬅️ Back', target)]
    ]);
};
exports.getBackKeyboard = getBackKeyboard;
const getAccountKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('⭐ Premium', 'premium'), telegraf_1.Markup.button.callback('🔐 Verification', 'verification')],
        [telegraf_1.Markup.button.callback('🎁 Referrals', 'referrals'), telegraf_1.Markup.button.callback('📊 My Status', 'my_status')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'main_menu')]
    ]);
};
exports.getAccountKeyboard = getAccountKeyboard;
const getReferralKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('🔗 My Referral Link', 'referral_link'), telegraf_1.Markup.button.callback('📊 Referral Stats', 'referral_stats')],
        [telegraf_1.Markup.button.callback('🏆 Rewards', 'referral_rewards')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'main_menu')]
    ]);
};
exports.getReferralKeyboard = getReferralKeyboard;
const getMyStatusKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('🔄 Refresh', 'my_status')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'account')]
    ]);
};
exports.getMyStatusKeyboard = getMyStatusKeyboard;
const getVerificationRequiredKeyboard = (shortUrl) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.url('🔗 Verify Now', shortUrl)],
        [telegraf_1.Markup.button.callback('🔄 Check Verification', 'verify_check')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'account')]
    ]);
};
exports.getVerificationRequiredKeyboard = getVerificationRequiredKeyboard;
const getVerificationPromptKeyboard = (jobId) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('🔗 Verify Now', `verify_flow_${jobId}`)],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'main_menu')]
    ]);
};
exports.getVerificationPromptKeyboard = getVerificationPromptKeyboard;
const getAroLinksVerifyKeyboard = (shortUrl, jobId) => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.url('🌐 Open Verification Link', shortUrl)],
        [telegraf_1.Markup.button.callback('📥 Get File', `get_file_${jobId}`)],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'main_menu')]
    ]);
};
exports.getAroLinksVerifyKeyboard = getAroLinksVerifyKeyboard;
const getVerificationExpiredKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('🔗 Generate New Link', 'verification')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'account')]
    ]);
};
exports.getVerificationExpiredKeyboard = getVerificationExpiredKeyboard;
const getVerifiedKeyboard = () => {
    return telegraf_1.Markup.inlineKeyboard([
        [telegraf_1.Markup.button.callback('📥 Download', 'download')],
        [telegraf_1.Markup.button.callback('📊 My Status', 'my_status')],
        [telegraf_1.Markup.button.callback('⬅️ Back', 'account')]
    ]);
};
exports.getVerifiedKeyboard = getVerifiedKeyboard;
