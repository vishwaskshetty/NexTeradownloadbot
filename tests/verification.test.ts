import { tokenService } from '../src/verification/token.service';
import { verificationService } from '../src/verification/verification.service';
import { getShortenerProvider } from '../src/verification/shortener.service';
import { db } from '../src/db';
import { mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../src/db', () => ({
  db: require('jest-mock-extended').mockDeep()
}));

jest.mock('../src/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    setMaxListeners: jest.fn(),
  }
}));

const mockDb = db as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

describe('Verification System & Security', () => {
  beforeEach(() => {
    mockReset(mockDb);
  });

  describe('TokenService Security', () => {
    it('should generate secure unpredictable tokens', () => {
      const token1 = tokenService.generateSecureToken();
      const token2 = tokenService.generateSecureToken();
      expect(token1).not.toEqual(token2);
      expect(token1.length).toBe(64); // 32 bytes hex = 64 chars
    });

    it('should hash tokens securely using SHA256', () => {
      const token = 'my-secure-token';
      const hash1 = tokenService.hashToken(token);
      const hash2 = tokenService.hashToken(token);
      
      expect(hash1).toEqual(hash2); // deterministic
      expect(hash1).not.toEqual(token); // never store plaintext
      // SHA256 length is 64 hex characters
      expect(hash1.length).toBe(64);
    });
  });

  describe('Shortener Provider', () => {
    it('should return a valid provider instance', async () => {
      const provider = await getShortenerProvider();
      expect(['arolinks', 'bitly', 'disabled']).toContain(provider.getProviderName());
    });
  });

  describe('VerificationService', () => {
    it('should create verification flow', async () => {
      mockDb.verificationSession.create.mockResolvedValue({ id: 'ses-1' } as any);
      mockDb.verificationSession.update.mockResolvedValue({} as any);

      const result = await verificationService.createVerificationFlow(1);
      
      expect(result.shortUrl).toBeDefined();
      expect(result.duration).toBeDefined();
      expect(mockDb.verificationSession.create).toHaveBeenCalledTimes(1);
      expect(mockDb.verificationSession.update).toHaveBeenCalledTimes(1);
    });

    it('should validate token correctly and prevent reuse', async () => {
      const fakeToken = tokenService.generateSecureToken();
      const tokenHash = tokenService.hashToken(fakeToken);

      // We need to mock transaction manually or via mockDb
      mockDb.$transaction.mockImplementation(async (callback) => {
        return callback(mockDb as any);
      });

      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);

      mockDb.verificationSession.findUnique.mockResolvedValue({
        id: 'ses-1',
        userId: 1,
        status: 'PENDING',
        expiresAt: futureDate
      } as any);

      mockDb.verificationSession.update.mockResolvedValue({} as any);
      mockDb.user.update.mockResolvedValue({ id: 1 } as any);

      const result = await verificationService.validateToken(fakeToken);
      
      expect(result.success).toBe(true);
      expect(mockDb.verificationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ses-1' },
          data: expect.objectContaining({ status: 'USED' })
        })
      );
      expect(mockDb.user.update).toHaveBeenCalled();
    });

    it('should reject expired tokens', async () => {
      const fakeToken = tokenService.generateSecureToken();

      mockDb.$transaction.mockImplementation(async (callback) => {
        return callback(mockDb as any);
      });

      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      mockDb.verificationSession.findUnique.mockResolvedValue({
        id: 'ses-1',
        status: 'PENDING',
        expiresAt: pastDate
      } as any);

      const result = await verificationService.validateToken(fakeToken);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('expired');
      expect(mockDb.verificationSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'EXPIRED' }
        })
      );
    });

    it('should reject already used tokens', async () => {
       const fakeToken = tokenService.generateSecureToken();
       mockDb.$transaction.mockImplementation(async (callback) => { return callback(mockDb as any); });

       mockDb.verificationSession.findUnique.mockResolvedValue({
         id: 'ses-1',
         status: 'USED'
       } as any);

       const result = await verificationService.validateToken(fakeToken);
       expect(result.success).toBe(false);
       expect(result.message).toContain('already been used');
    });
  });
});
