"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const path_1 = __importDefault(require("path"));
const verification_service_1 = require("./verification/verification.service");
const logger_1 = require("./utils/logger");
const adminRouter_1 = require("./admin/adminRouter");
exports.app = (0, express_1.default)();
exports.app.use(express_1.default.json());
exports.app.use(express_1.default.urlencoded({ extended: true }));
exports.app.use((0, cookie_parser_1.default)());
// Setup EJS
exports.app.set('view engine', 'ejs');
exports.app.set('views', path_1.default.join(__dirname, 'admin', 'views'));
// GET /health - Simple HTTP 200 process liveness check for Railway
exports.app.get('/health', (req, res) => {
    return res.status(200).json({
        status: 'ok',
        bot: 'online'
    });
});
// GET /ready - Dependency readiness health report (PostgreSQL & Redis status)
exports.app.get('/ready', async (req, res) => {
    let dbStatus = false;
    let redisStatus = false;
    try {
        const { db } = require('./db');
        await db.$queryRaw `SELECT 1`;
        dbStatus = true;
    }
    catch (e) { }
    try {
        const { redis } = require('./redis');
        await redis.ping();
        redisStatus = true;
    }
    catch (e) { }
    return res.status(200).json({
        bot: true,
        postgres: dbStatus,
        redis: redisStatus
    });
});
// Mount Admin Router
exports.app.use('/admin', adminRouter_1.adminRouter);
// Verification webhook from shortener
exports.app.get('/verify/:token', async (req, res) => {
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
        const result = await verification_service_1.verificationService.validateToken(rawToken);
        if (result.success) {
            return res.send(`
        <html><body>
          <h2>✅ Verification Successful!</h2>
          <p>You can now return to the Telegram bot.</p>
          <p><a href="tg://resolve?domain=NexTeraDownloadBot">Open Telegram</a></p>
        </body></html>
      `);
        }
        else {
            return res.status(400).send(`
        <html><body>
          <h2>❌ Verification Failed</h2>
          <p>${result.message}</p>
        </body></html>
      `);
        }
    }
    catch (error) {
        logger_1.logger.error(error, 'Error in verification endpoint');
        return res.status(500).send('Internal Server Error');
    }
});
const startServer = (port = 3000) => {
    return exports.app.listen(port, '0.0.0.0', () => {
        logger_1.logger.info(`🌐 Server listening on 0.0.0.0:${port}`);
    });
};
exports.startServer = startServer;
