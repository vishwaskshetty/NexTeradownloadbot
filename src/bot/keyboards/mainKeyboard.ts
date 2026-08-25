import { Markup } from 'telegraf';

export const getMainKeyboard = (isAdmin: boolean = false, showVerification: boolean = true) => {
  const buttons = [
    [Markup.button.callback('📥 Download', 'download'), Markup.button.callback('👤 Account', 'account')],
  ];

  if (showVerification) {
    buttons.push([Markup.button.callback('📊 My Status', 'account')]);
    buttons.push([Markup.button.callback('🔐 Verification', 'verification'), Markup.button.callback('⭐ Premium', 'premium')]);
  } else {
    buttons.push([Markup.button.callback('📊 My Status', 'account')]);
    buttons.push([Markup.button.callback('⭐ Premium', 'premium')]);
  }

  buttons.push([Markup.button.callback('ℹ️ Help', 'help')]);

  if (isAdmin) {
    buttons.push([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
  }

  return Markup.inlineKeyboard(buttons);
};

export const getBackKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getAccountKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Premium', 'premium')],
    [Markup.button.callback('📊 My Status', 'account')],
    [Markup.button.callback('🔐 Verification', 'verification')],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getVerificationRequiredKeyboard = (shortUrl: string) => {
  return Markup.inlineKeyboard([
    [Markup.button.url('🔗 Verify Now', shortUrl)],
    [Markup.button.callback('🔄 Check Verification', 'verify_check')],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};

export const getVerifiedKeyboard = () => {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📥 Download', 'download')],
    [Markup.button.callback('📊 My Status', 'account')],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]);
};
