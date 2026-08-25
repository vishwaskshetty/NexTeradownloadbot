"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenService = exports.TokenService = void 0;
const crypto_1 = __importDefault(require("crypto"));
class TokenService {
    /**
     * Generates a cryptographically secure random token.
     */
    generateSecureToken(length = 32) {
        return crypto_1.default.randomBytes(length).toString('hex');
    }
    /**
     * Hashes a token using SHA-256 for secure database storage.
     */
    hashToken(token) {
        return crypto_1.default.createHash('sha256').update(token).digest('hex');
    }
}
exports.TokenService = TokenService;
exports.tokenService = new TokenService();
