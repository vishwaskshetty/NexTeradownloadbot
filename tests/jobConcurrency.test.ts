import { mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../src/db', () => ({
  db: require('jest-mock-extended').mockDeep()
}));

import { JobService } from '../src/services/JobService';
import { db } from '../src/db';

const mockDb = db as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

describe('JobService Concurrency & Error Handling', () => {
  const jobService = new JobService();

  beforeEach(() => {
    mockReset(mockDb);
  });

  it('should create a job successfully if no active job exists', async () => {
    const mockJob = { id: 'job1', userId: 1, status: 'PENDING', provider: 'TERABOX', url: 'http://test' };
    mockDb.job.create.mockResolvedValue(mockJob as any);

    const result = await jobService.createJob(1, 'http://test', 'TERABOX');
    expect(result.isExisting).toBe(false);
    expect(result.job.id).toBe('job1');
  });

  it('should catch P2002 Unique Constraint violation and return the existing active job', async () => {
    // Simulate Prisma throwing a P2002 error (which is what happens due to the Partial Unique Index in Postgres)
    const error = new Error('Unique constraint failed on the fields: (`userId`)');
    (error as any).code = 'P2002';
    mockDb.job.create.mockRejectedValue(error);

    const activeJob = { id: 'job_active', userId: 1, status: 'PROCESSING', provider: 'TERABOX', url: 'http://active' };
    mockDb.job.findFirst.mockResolvedValue(activeJob as any);

    const result = await jobService.createJob(1, 'http://test', 'TERABOX');
    
    expect(result.isExisting).toBe(true);
    expect(result.job.id).toBe('job_active');
    expect(mockDb.job.findFirst).toHaveBeenCalledTimes(1);
  });
});
