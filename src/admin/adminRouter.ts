import { Router } from 'express';
import { db } from '../db';
import { adminService } from '../services/AdminService';
import { config } from '../config';
import crypto from 'crypto';

export const adminRouter = Router();

// Simple in-memory token store for admin login
const activeTokens: Record<string, number> = {};

// Middleware to protect admin routes
adminRouter.use((req, res, next) => {
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
adminRouter.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Verify token from Telegram /adminpanel link
adminRouter.get('/verify-token', (req, res) => {
  const { token } = req.query;
  
  if (typeof token === 'string' && activeTokens[token]) {
    res.cookie('admin_token', token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 });
    return res.redirect('/admin/dashboard');
  }
  
  res.render('login', { error: 'Invalid or expired token.' });
});

// Dashboard
adminRouter.get('/dashboard', async (req, res) => {
  const totalUsers = await db.user.count();
  const premiumUsers = await db.user.count({ where: { plan: 'PREMIUM' } });
  const verifiedUsers = await db.verificationSession.count({ where: { status: 'VERIFIED' } });
  const activeJobs = await db.job.count({ where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] } } });
  const usageStats = await db.userUsage.aggregate({ _sum: { dailyRequests: true } });
  
  res.render('dashboard', {
    totalUsers,
    premiumUsers,
    verifiedUsers,
    activeJobs,
    downloadsToday: usageStats._sum.dailyRequests || 0
  });
});

// Users
adminRouter.get('/users', async (req, res) => {
  const users = await db.user.findMany({
    take: 100,
    orderBy: { createdAt: 'desc' }
  });
  res.render('users', { users });
});

// Premium
adminRouter.get('/premium', async (req, res) => {
  const isEnabled = await adminService.getPremiumStatus();
  const premiumUsers = await db.user.findMany({
    where: { plan: 'PREMIUM' },
    orderBy: { createdAt: 'desc' }
  });
  res.render('premium', { 
    isEnabled,
    premiumUsers,
    freeLimit: config.FREE_DAILY_LIMIT,
    premiumLimit: config.PREMIUM_DAILY_LIMIT
  });
});

adminRouter.post('/premium/toggle', async (req, res) => {
  const isEnabled = await adminService.getPremiumStatus();
  await adminService.setPremiumStatus(!isEnabled);
  res.redirect('/admin/premium');
});

// Verification
adminRouter.get('/verification', async (req, res) => {
  const isEnabled = await adminService.getVerificationStatus();
  res.render('verification', { isEnabled, validity: config.VERIFICATION_VALIDITY_MINUTES });
});

adminRouter.post('/verification/toggle', async (req, res) => {
  const isEnabled = await adminService.getVerificationStatus();
  await adminService.setVerificationStatus(!isEnabled);
  res.redirect('/admin/verification');
});

// Shortener
adminRouter.get('/shortener', async (req, res) => {
  const isEnabled = await adminService.getShortenerStatus();
  const provider = await adminService.getShortenerProvider();
  res.render('shortener', { isEnabled, provider, apiKey: config.SHORTENER_API_KEY });
});

adminRouter.post('/shortener/toggle', async (req, res) => {
  const isEnabled = await adminService.getShortenerStatus();
  await adminService.setShortenerStatus(!isEnabled);
  res.redirect('/admin/shortener');
});

// Active Downloads
adminRouter.get('/jobs', async (req, res) => {
  const jobs = await db.job.findMany({
    where: { status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'UPLOADING'] } },
    include: { user: true },
    orderBy: { createdAt: 'desc' }
  });
  res.render('jobs', { jobs });
});

adminRouter.post('/jobs/:id/cancel', async (req, res) => {
  await db.job.update({
    where: { id: req.params.id },
    data: { status: 'CANCELLED' }
  });
  res.redirect('/admin/jobs');
});

// Statistics
adminRouter.get('/statistics', async (req, res) => {
  const totalUsers = await db.user.count();
  const usageStats = await db.userUsage.aggregate({
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
adminRouter.get('/broadcast', (req, res) => {
  res.render('broadcast', { success: req.query.success === 'true' });
});

adminRouter.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  if (message) {
    const { broadcastQueue } = require('../queue/jobQueue');
    await broadcastQueue.add('broadcastMessage', { text: message });
  }
  res.redirect('/admin/broadcast?success=true');
});

// Settings
adminRouter.get('/settings', (req, res) => {
  res.render('settings');
});

// API function to generate a token for telegram bot
export const generateAdminToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  activeTokens[token] = Date.now() + 1000 * 60 * 15; // valid for 15 mins to login
  return token;
};
