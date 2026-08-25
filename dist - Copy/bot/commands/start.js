"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCommand = exports.getMainMenuText = void 0;
const telegraf_1 = require("telegraf");
const mainKeyboard_1 = require("../keyboards/mainKeyboard");
const UserService_1 = require("../../services/UserService");
const AdminService_1 = require("../../services/AdminService");
const verification_service_1 = require("../../verification/verification.service");
const db_1 = require("../../db");
const logger_1 = require("../../utils/logger");
const getMainMenuText = () => {
    return `
👋 *WELCOME TO NexTeraDownloadBot*

⚡ Fast and reliable file processing bot.

Choose an option below:

⚠️ _By using this bot, you agree that you use it at your own risk._`;
};
exports.getMainMenuText = getMainMenuText;
const startCommand = async (ctx) => {
    try {
        const telegramId = ctx.from?.id;
        if (!telegramId)
            return;
        logger_1.logger.info(`Processing /start for ${telegramId}`);
        // Get or Create user
        const user = await UserService_1.userService.getOrCreateUser(telegramId, ctx.from?.username, ctx.from?.first_name, ctx.from?.last_name, ctx.from?.language_code);
        const isAdmin = AdminService_1.adminService.isAdmin(telegramId);
        // ADMIN BYPASS: Force Subscribe check ONLY applies to normal users
        if (!isAdmin) {
            const { forceSubService } = require('../../services/ForceSubService');
            const isForceSubEnabled = await forceSubService.getForceSubStatus();
            if (isForceSubEnabled) {
                const checkResult = await forceSubService.checkUserMembership(ctx.telegram, telegramId);
                if (!checkResult.isMember) {
                    const rawMsg = await forceSubService.getCustomMessage();
                    const userName = ctx.from?.first_name || 'User';
                    const formattedMsg = rawMsg.replace(/\{user_name\}/g, userName);
                    const inlineKeyboard = [];
                    checkResult.missingChannels.forEach((ch, idx) => {
                        inlineKeyboard.push([
                            telegraf_1.Markup.button.url(`📢 Join ${ch.name || `Channel ${idx + 1}`}`, ch.inviteUrl)
                        ]);
                    });
                    inlineKeyboard.push([
                        telegraf_1.Markup.button.callback('🔄 Check Again', 'check_force_sub')
                    ]);
                    await ctx.reply(formattedMsg, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                    return;
                }
            }
        }
        const isVerificationRequired = await AdminService_1.adminService.getVerificationStatus();
        const showVerification = isVerificationRequired && user.plan === 'FREE';
        // @ts-ignore
        const text = ctx.message?.text || '';
        // Check if there is a referral deep link payload (e.g. /start ref_123456789)
        const refMatch = text.match(/\/start\s+(?:ref_|r_)(\d+)/i);
        if (refMatch && refMatch[1]) {
            const referrerTelegramId = parseInt(refMatch[1], 10);
            logger_1.logger.info(`[startCommand] Referral deep link received from ${referrerTelegramId} for new user ${telegramId}`);
            const { referralService } = require('../../services/ReferralService');
            await referralService.processReferral(referrerTelegramId, telegramId);
        }
        // Check if there is a verification deep link payload (e.g. /start verify_<token> or /start v_<token>)
        const payloadMatch = text.match(/\/start\s+(?:verify_|v_)([a-f0-9]+)/i);
        if (payloadMatch && payloadMatch[1]) {
            const rawToken = payloadMatch[1];
            logger_1.logger.info(`[startCommand] Verification deep link received for user ${user.id} with token ${rawToken.substring(0, 8)}...`);
            const result = await verification_service_1.verificationService.validateToken(rawToken);
            if (result.success) {
                // Check if user has an active job in VERIFYING state
                const pendingJob = await db_1.db.job.findFirst({
                    where: {
                        userId: user.id,
                        status: 'VERIFYING'
                    },
                    orderBy: { createdAt: 'desc' }
                });
                if (pendingJob) {
                    await ctx.reply(`✅ *VERIFICATION SUCCESSFUL!*\n\nYour account is now verified.\n\nClick *📥 Get File* below to start your download processing.`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📥 Get File', callback_data: `get_file_${pendingJob.id}` }],
                                [{ text: '🏠 Main Menu', callback_data: 'main_menu' }]
                            ]
                        }
                    });
                }
                else {
                    await ctx.reply(`✅ *VERIFICATION SUCCESSFUL!*\n\nYour account has been successfully verified for 15 minutes.\nYou can now send any supported TeraBox or Diskwala link to download.`, {
                        parse_mode: 'Markdown',
                        ...(0, mainKeyboard_1.getMainKeyboard)(isAdmin, showVerification)
                    });
                }
                return;
            }
            else {
                await ctx.reply(`❌ *VERIFICATION FAILED*\n\n${result.message}\n\nPlease generate a new link to try again. Zero daily usage was consumed.`, {
                    parse_mode: 'Markdown',
                    ...(0, mainKeyboard_1.getMainKeyboard)(isAdmin, showVerification)
                });
                return;
            }
        }
        logger_1.logger.info(`Sending welcome message to ${telegramId}`);
        const extraParams = {
            parse_mode: 'Markdown',
            ...(0, mainKeyboard_1.getMainKeyboard)(isAdmin, showVerification)
        };
        await ctx.reply((0, exports.getMainMenuText)(), extraParams);
        logger_1.logger.info(`Welcome message sent to ${telegramId} successfully`);
    }
    catch (err) {
        logger_1.logger.error(`Error in startCommand: ${err.message}`);
        throw err;
    }
};
exports.startCommand = startCommand;
