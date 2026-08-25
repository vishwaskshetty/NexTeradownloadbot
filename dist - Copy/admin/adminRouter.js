"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAdminToken = exports.adminRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const AdminService_1 = require("../services/AdminService");
const config_1 = require("../config");
const crypto_1 = __importDefault(require("crypto"));
exports.adminRouter = (0, express_1.Router)();
// Simple in-memory token store for admin login
const activeTokens = {};
// Middleware to protect admin routes
exports.adminRouter.use((req, res, next) => {
    if (req.path === '/login' || req.path === '/verify-token') {
        return next();
    }
    const token = req.cookies?.admin_token;
    if (!token || !activeTokens[token]) {
        return res.redirect('/admin/login');
    }
    // Extend token life on activity
    activeTokens[token] = Date.now() + 1000 * 60 * 60 * 24; // 24 hours
    next();
});
// Login Page
exports.adminRouter.get('/login', (req, res) => {
    res.render('login', { error: null });
});
// Verify token from Telegram /adminpanel link
exports.adminRouter.get('/verify-token', (req, res) => {
    const { token } = req.query;
    if (typeof token === 'string' && activeTokens[token]) {
        res.cookie('admin_token', token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 });
        return res.redirect('/admin/dashboard');
    }
    res.render('login', { error: 'Invalid or expired token.' });
});
// Dashboard
exports.adminRouter.get('/dashboard', async (req, res) => {
    const totalUsers = await db_1.db.user.count();
    const premiumUsers = await db_1.db.user.count({ where: { plan: 'PREMIUM' } });
    const verifiedUsers = await db_1.db.verificationSession.count({ where: { status: 'VERIFIED' } });
    const activeJobs = await db_1.db.job.count({ where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] } } });
    const usageStats = await db_1.db.userUsage.aggregate({ _sum: { dailyRequests: true } });
    res.render('dashboard', {
        totalUsers,
        premiumUsers,
        verifiedUsers,
        activeJobs,
        downloadsToday: usageStats._sum.dailyRequests || 0
    });
});
// Users
exports.adminRouter.get('/users', async (req, res) => {
    const users = await db_1.db.user.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' }
    });
    res.render('users', { users });
});
// Premium Management Routes
exports.adminRouter.get('/premium', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const search = req.query.search || '';
    const msg = req.query.msg || null;
    const error = req.query.error || null;
    const isEnabled = await AdminService_1.adminService.getPremiumStatus();
    const { userService } = require('../services/UserService');
    const { users, total, totalPages } = await userService.getPremiumUsersList(page, 10, search);
    res.render('premium', {
        isEnabled,
        premiumUsers: users,
        total,
        totalPages,
        page,
        search,
        msg,
        error,
        freeLimit: config_1.config.FREE_DAILY_LIMIT,
        premiumLimit: config_1.config.PREMIUM_DAILY_LIMIT
    });
});
exports.adminRouter.post('/premium/add', async (req, res) => {
    try {
        const { telegramId, duration, customDuration } = req.body;
        const days = parseInt(customDuration || duration || '30', 10);
        const targetId = BigInt(telegramId);
        const adminId = config_1.config.ADMIN_TELEGRAM_IDS[0] || 0;
        const { userService } = require('../services/UserService');
        await userService.addPremium(adminId, targetId, days);
        res.redirect(`/admin/premium?msg=${encodeURIComponent(`✅ Added ${days} days premium to User ID ${telegramId}`)}`);
    }
    catch (err) {
        res.redirect(`/admin/premium?error=${encodeURIComponent(err.message || 'Failed to add premium')}`);
    }
});
exports.adminRouter.post('/premium/extend', async (req, res) => {
    try {
        const { telegramId, duration, customDuration } = req.body;
        const days = parseInt(customDuration || duration || '30', 10);
        const targetId = BigInt(telegramId);
        const adminId = config_1.config.ADMIN_TELEGRAM_IDS[0] || 0;
        const { userService } = require('../services/UserService');
        await userService.extendPremium(adminId, targetId, days);
        res.redirect(`/admin/premium?msg=${encodeURIComponent(`✅ Extended premium for User ID ${telegramId} by ${days} days`)}`);
    }
    catch (err) {
        res.redirect(`/admin/premium?error=${encodeURIComponent(err.message || 'Failed to extend premium')}`);
    }
});
exports.adminRouter.post('/premium/remove', async (req, res) => {
    try {
        const { telegramId } = req.body;
        const targetId = BigInt(telegramId);
        const adminId = config_1.config.ADMIN_TELEGRAM_IDS[0] || 0;
        const { userService } = require('../services/UserService');
        await userService.removePremium(adminId, targetId);
        res.redirect(`/admin/premium?msg=${encodeURIComponent(`✅ Removed premium for User ID ${telegramId}`)}`);
    }
    catch (err) {
        res.redirect(`/admin/premium?error=${encodeURIComponent(err.message || 'Failed to remove premium')}`);
    }
});
exports.adminRouter.post('/premium/toggle', async (req, res) => {
    const isEnabled = await AdminService_1.adminService.getPremiumStatus();
    await AdminService_1.adminService.setPremiumStatus(!isEnabled);
    res.redirect('/admin/premium');
});
// Referral Management Routes
exports.adminRouter.get('/referrals', async (req, res) => {
    const { referralService } = require('../services/ReferralService');
    const stats = await referralService.getGlobalReferralStats();
    const msg = req.query.msg || null;
    const error = req.query.error || null;
    res.render('referrals', {
        ...stats,
        msg,
        error
    });
});
exports.adminRouter.post('/referrals/toggle', async (req, res) => {
    const isEnabled = await AdminService_1.adminService.getReferralStatus();
    await AdminService_1.adminService.setReferralStatus(!isEnabled);
    res.redirect('/admin/referrals?msg=✅ Referral status updated');
});
exports.adminRouter.post('/referrals/update', async (req, res) => {
    try {
        const { referralsRequired, rewardDays } = req.body;
        const count = parseInt(referralsRequired, 10);
        const days = parseInt(rewardDays, 10);
        if (count > 0)
            await AdminService_1.adminService.setReferralsRequired(count);
        if (days > 0)
            await AdminService_1.adminService.setReferralRewardDays(days);
        res.redirect('/admin/referrals?msg=✅ Referral settings updated successfully');
    }
    catch (err) {
        res.redirect(`/admin/referrals?error=${encodeURIComponent(err.message || 'Failed to update referral settings')}`);
    }
});
// Verification
exports.adminRouter.get('/verification', async (req, res) => {
    const isEnabled = await AdminService_1.adminService.getVerificationStatus();
    res.render('verification', { isEnabled, validity: config_1.config.VERIFICATION_VALIDITY_MINUTES });
});
exports.adminRouter.post('/verification/toggle', async (req, res) => {
    const isEnabled = await AdminService_1.adminService.getVerificationStatus();
    await AdminService_1.adminService.setVerificationStatus(!isEnabled);
    res.redirect('/admin/verification');
});
// Shortener
exports.adminRouter.get('/shortener', async (req, res) => {
    const isEnabled = await AdminService_1.adminService.getShortenerStatus();
    const provider = await AdminService_1.adminService.getShortenerProvider();
    res.render('shortener', { isEnabled, provider, apiKey: config_1.config.SHORTENER_API_KEY });
});
exports.adminRouter.post('/shortener/toggle', async (req, res) => {
    const isEnabled = await AdminService_1.adminService.getShortenerStatus();
    await AdminService_1.adminService.setShortenerStatus(!isEnabled);
    res.redirect('/admin/shortener');
});
// Active Downloads
exports.adminRouter.get('/jobs', async (req, res) => {
    const jobs = await db_1.db.job.findMany({
        where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] } },
        include: { user: true },
        orderBy: { createdAt: 'desc' }
    });
    res.render('jobs', { jobs });
});
exports.adminRouter.post('/jobs/:id/cancel', async (req, res) => {
    await db_1.db.job.update({
        where: { id: req.params.id },
        data: { status: 'CANCELLED' }
    });
    res.redirect('/admin/jobs');
});
// Statistics
exports.adminRouter.get('/statistics', async (req, res) => {
    const totalUsers = await db_1.db.user.count();
    const usageStats = await db_1.db.userUsage.aggregate({
        _sum: {
            successfulRequests: true,
            failedRequests: true,
            dailyRequests: true
        }
    });
    const totalDownloads = (usageStats._sum.successfulRequests || 0) + (usageStats._sum.failedRequests || 0);
    res.render('statistics', {
        totalUsers,
        totalDownloads,
        successful: usageStats._sum.successfulRequests || 0,
        failed: usageStats._sum.failedRequests || 0,
        downloadsToday: usageStats._sum.dailyRequests || 0
    });
});
// Broadcast
exports.adminRouter.get('/broadcast', (req, res) => {
    res.render('broadcast', { success: req.query.success === 'true' });
});
exports.adminRouter.post('/broadcast', async (req, res) => {
    const { message } = req.body;
    if (message) {
        const { broadcastQueue } = require('../queue/jobQueue');
        await broadcastQueue.add('broadcastMessage', { text: message });
    }
    res.redirect('/admin/broadcast?success=true');
});
// Settings
exports.adminRouter.get('/settings', (req, res) => {
    res.render('settings');
});
// API function to generate a token for telegram bot
const generateAdminToken = () => {
    const token = crypto_1.default.randomBytes(32).toString('hex');
    activeTokens[token] = Date.now() + 1000 * 60 * 15; // valid for 15 mins to login
    return token;
};
exports.generateAdminToken = generateAdminToken;
