import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { verificationService } from './verification/verification.service';
import { logger } from './utils/logger';
import { adminRouter } from './admin/adminRouter';

export const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'admin', 'views'));

// GET /health - Simple HTTP 200 process liveness check for Railway
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    bot: 'online'
  });
});

// GET /version - Safe metadata endpoint reporting version, commit SHA and uptime
app.get('/version', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    version: '1.0.0',
    commit: 'd70512d',
    role: process.env.BOT_ROLE || 'bot',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// GET /ready - Dependency readiness health report (PostgreSQL & Redis status)
app.get('/ready', async (req, res) => {
  let dbStatus = false;
  let redisStatus = false;

  try {
    const { db } = require('./db');
    await db.$queryRaw`SELECT 1`;
    dbStatus = true;
  } catch (e) {}

  try {
    const { redis } = require('./redis');
    await redis.ping();
    redisStatus = true;
  } catch (e) {}

  return res.status(200).json({
    bot: true,
    postgres: dbStatus,
    redis: redisStatus
  });
});

// Mount Admin Router
app.use('/admin', adminRouter);

// Verification webhook from shortener
app.get('/verify/:token', async (req, res) => {
  try {
    const rawToken = req.params.token;
    
    if (!rawToken || rawToken.length < 16) {
      return res.status(400).send(`
        <html><body>
          <h2>❌ Invalid Verification Token</h2>
          <p>The token provided is missing or invalid.</p>
        </body></html>
      `);
    }

    const result = await verificationService.validateToken(rawToken);

    if (result.success) {
      return res.send(`
        <html><body>
          <h2>✅ Verification Successful!</h2>
          <p>You can now return to the Telegram bot.</p>
          <p><a href="tg://resolve?domain=NexTeraDownloadBot">Open Telegram</a></p>
        </body></html>
      `);
    } else {
      return res.status(400).send(`
        <html><body>
          <h2>❌ Verification Failed</h2>
          <p>${result.message}</p>
        </body></html>
      `);
    }
  } catch (error) {
    logger.error(error, 'Error in verification endpoint');
    return res.status(500).send('Internal Server Error');
  }
});

export const startServer = (port: number = 3000) => {
  return app.listen(port, '0.0.0.0', () => {
    logger.info(`🌐 Server listening on 0.0.0.0:${port}`);
  });
};
