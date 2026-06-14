import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BalanceService } from '../../src/balance/balance.service';
import { TimeOffBalance } from '../../src/balance/entities/time-off-balance.entity';
import { BalanceSyncLog } from '../../src/balance/entities/balance-sync-log.entity';
import { HcmClientService } from '../../src/hcm/hcm-client.service';

const mockBalanceRepo = () => ({
  findOne: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockSyncLogRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
});

const mockHcmClient = () => ({
  getBalance: jest.fn(),
  getBatch: jest.fn(),
});

const mockConfigService = () => ({
  get: jest.fn((key: string, defaultVal: any) => {
    const map: Record<string, string> = {
      BALANCE_STALENESS_THRESHOLD_MINUTES: '15',
    };
    return map[key] ?? defaultVal;
  }),
});

const mockDataSource = () => ({});

describe('BalanceService', () => {
  let service: BalanceService;
  let balanceRepo: ReturnType<typeof mockBalanceRepo>;
  let syncLogRepo: ReturnType<typeof mockSyncLogRepo>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(TimeOffBalance), useFactory: mockBalanceRepo },
        { provide: getRepositoryToken(BalanceSyncLog), useFactory: mockSyncLogRepo },
        { provide: HcmClientService, useFactory: mockHcmClient },
        { provide: ConfigService, useFactory: mockConfigService },
        { provide: getDataSourceToken(), useFactory: mockDataSource },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
    balanceRepo = module.get(getRepositoryToken(TimeOffBalance));
    syncLogRepo = module.get(getRepositoryToken(BalanceSyncLog));
    hcmClient = module.get(HcmClientService);
  });

  describe('computeAvailableToReserve', () => {
    it('should return hcmAvailableBalance minus pendingBalance', () => {
      expect(service.computeAvailableToReserve(10, 3)).toBe(7);
    });

    it('should return 0 when pending equals hcm balance', () => {
      expect(service.computeAvailableToReserve(5, 5)).toBe(0);
    });

    it('should handle decimal values', () => {
      expect(service.computeAvailableToReserve(10.5, 3.5)).toBe(7);
    });
  });

  describe('staleness check logic', () => {
    it('should consider balance fresh when lastSyncedAt is recent', async () => {
      const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
      const existingBalance = {
        id: 1,
        employeeId: 'emp-1',
        locationId: 'loc-1',
        hcmAvailableBalance: 10,
        pendingBalance: 2,
        lastSyncedAt: recentDate,
        version: 0,
      };
      balanceRepo.findOne.mockResolvedValue(existingBalance);

      const result = await service.getBalance('emp-1', 'loc-1');
      expect(hcmClient.getBalance).not.toHaveBeenCalled();
      expect(result.hcmAvailableBalance).toBe(10);
      expect(result.pendingBalance).toBe(2);
      expect(result.availableToReserve).toBe(8);
    });

    it('should refresh from HCM when lastSyncedAt is older than 15 minutes', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
      const existingBalance = {
        id: 1,
        employeeId: 'emp-1',
        locationId: 'loc-1',
        hcmAvailableBalance: 8,
        pendingBalance: 1,
        lastSyncedAt: staleDate,
        version: 2,
      };
      balanceRepo.findOne
        .mockResolvedValueOnce(existingBalance)
        .mockResolvedValueOnce({ ...existingBalance, hcmAvailableBalance: 12, version: 3 });
      balanceRepo.update.mockResolvedValue({ affected: 1 });
      hcmClient.getBalance.mockResolvedValue({ hcmAvailableBalance: 12 });
      syncLogRepo.create.mockReturnValue({});
      syncLogRepo.save.mockResolvedValue({});

      const result = await service.getBalance('emp-1', 'loc-1');
      expect(hcmClient.getBalance).toHaveBeenCalledWith('emp-1', 'loc-1');
      expect(result.hcmAvailableBalance).toBe(12);
    });

    it('should refresh from HCM when lastSyncedAt is null', async () => {
      balanceRepo.findOne.mockResolvedValueOnce(null);
      hcmClient.getBalance.mockResolvedValue({ hcmAvailableBalance: 10 });
      const savedBalance = {
        id: 1,
        employeeId: 'emp-1',
        locationId: 'loc-1',
        hcmAvailableBalance: 10,
        pendingBalance: 0,
        lastSyncedAt: new Date(),
        version: 0,
      };
      balanceRepo.create.mockReturnValue(savedBalance);
      balanceRepo.save.mockResolvedValue(savedBalance);
      syncLogRepo.create.mockReturnValue({});
      syncLogRepo.save.mockResolvedValue({});

      const result = await service.getBalance('emp-1', 'loc-1');
      expect(hcmClient.getBalance).toHaveBeenCalled();
      expect(result.hcmAvailableBalance).toBe(10);
    });
  });

  describe('tryIncrementPending (optimistic lock)', () => {
    it('should return true when update affects rows', async () => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.tryIncrementPending(1, 0, 2);
      expect(result).toBe(true);
    });

    it('should return false when 0 rows updated (optimistic lock conflict)', async () => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      balanceRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.tryIncrementPending(1, 0, 2);
      expect(result).toBe(false);
    });
  });
});
