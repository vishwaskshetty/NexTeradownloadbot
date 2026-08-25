import { Markup } from 'telegraf';

export const getMainKeyboard = (isAdmin: boolean = false, showVerification: boolean = true) => {
  const buttons = [
    [Markup.button.callback('📥 Download', 'download'), Markup.button.callback('👤 Account', 'account')],
    [Markup.button.callback('📊 My Status', 'my_status')],
  ];

  if (showVerification) {
    buttons.push([Markup.button.callback('🔐 Verification', 'verification'), Markup.button.callback('⭐ Premium', 'premium')]);
  } else {
    buttons.push([Markup.button.callback('⭐ Premium', 'premium')]);
  }

  buttons.push([Markup.button.callback('❓ Help', 'help')]);

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
    [Markup.button.callback('📊 My Status', 'my_status')],
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
