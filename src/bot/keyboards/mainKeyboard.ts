import { Markup } from 'telegraf';

export const getDisclaimerText = () => {
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

export const getMainKeyboard = (isAdmin: boolean = false, showVerification: boolean = true) => {
  const buttons = [
    [Markup.button.callback('📥 Download', 'download'), Markup.button.callback('👤 Account', 'account')],
    [Markup.button.callback('📊 My Status', 'my_status'), Markup.button.callback('🎁 Referrals', 'referrals')],
  ];

  if (showVerification) {
    buttons.push([Markup.button.callback('🔐 Verification', 'verification'), Markup.button.callback('⭐ Premium', 'premium')]);
  } else {
    buttons.push([Markup.button.callback('⭐ Premium', 'premium')]);
  }

  buttons.push([Markup.button.callback('❓ Help', 'help'), Markup.button.callback('⚠️ Disclaimer', 'disclaimer')]);

  if (isAdmin) {
    buttons.push([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
  }

  return Markup.inlineKeyboard(buttons);
};

export const getBackKeyboard = (target: string = 'main_menu') => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Back', target)]
  ]);
};

export const getAccountKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Premium', 'premium'), Markup.button.callback('🔐 Verification', 'verification')],
    [Markup.button.callback('🎁 Referrals', 'referrals'), Markup.button.callback('📊 My Status', 'my_status')],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getReferralKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗 My Referral Link', 'referral_link'), Markup.button.callback('📊 Referral Stats', 'referral_stats')],
    [Markup.button.callback('🏆 Rewards', 'referral_rewards')],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getMyStatusKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'my_status')],
    [Markup.button.callback('⬅️ Back', 'account')]
  ]);
};

export const getVerificationRequiredKeyboard = (shortUrl: string) => {
  return Markup.inlineKeyboard([
    [Markup.button.url('🔗 Verify Now', shortUrl)],
    [Markup.button.callback('🔄 Check Verification', 'verify_check')],
    [Markup.button.callback('⬅️ Back', 'account')]
  ]);
};

export const getVerificationPromptKeyboard = (jobId: string) => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Verify Now', `verify_flow_${jobId}`)],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getAroLinksVerifyKeyboard = (shortUrl: string, jobId: string) => {
  return Markup.inlineKeyboard([
    [Markup.button.url('🌐 Open Verification Link', shortUrl)],
    [Markup.button.callback('📥 Get File', `get_file_${jobId}`)],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getVerificationExpiredKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Generate New Link', 'verification')],
    [Markup.button.callback('⬅️ Back', 'account')]
  ]);
};

export const getVerifiedKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📥 Download', 'download')],
    [Markup.button.callback('📊 My Status', 'my_status')],
    [Markup.button.callback('⬅️ Back', 'account')]
  ]);
};
