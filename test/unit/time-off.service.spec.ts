import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  UnprocessableEntityException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TimeOffService } from '../../src/time-off/time-off.service';
import { TimeOffRequest, TimeOffStatus } from '../../src/time-off/entities/time-off-request.entity';
import { TimeOffBalance } from '../../src/balance/entities/time-off-balance.entity';
import { BalanceSyncLog } from '../../src/balance/entities/balance-sync-log.entity';
import { BalanceService } from '../../src/balance/balance.service';
import { HcmClientService } from '../../src/hcm/hcm-client.service';

const mockRequestRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockBalanceRepo = () => ({
  findOne: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockSyncLogRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
});

const mockBalanceService = () => ({
  getOrFetchBalance: jest.fn(),
  computeAvailableToReserve: jest.fn(),
  tryIncrementPending: jest.fn(),
  decrementPending: jest.fn(),
  decrementPendingAndHcm: jest.fn(),
});

const mockHcmClient = () => ({
  getBalance: jest.fn(),
  submitRequest: jest.fn(),
});

describe('TimeOffService', () => {
  let service: TimeOffService;
  let requestRepo: ReturnType<typeof mockRequestRepo>;
  let balanceRepo: ReturnType<typeof mockBalanceRepo>;
  let syncLogRepo: ReturnType<typeof mockSyncLogRepo>;
  let balanceService: ReturnType<typeof mockBalanceService>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  const makeBalance = (overrides = {}): TimeOffBalance => ({
    id: 1,
    employeeId: 'emp-1',
    locationId: 'loc-1',
    hcmAvailableBalance: 10,
    pendingBalance: 0,
    lastSyncedAt: new Date(),
    version: 0,
    ...overrides,
  } as TimeOffBalance);

  const makeRequest = (overrides = {}): TimeOffRequest => ({
    id: 'req-1',
    idempotencyKey: 'idem-1',
    employeeId: 'emp-1',
    locationId: 'loc-1',
    startDate: '2026-07-01',
    endDate: '2026-07-05',
    daysRequested: 3,
    status: TimeOffStatus.PENDING,
    hcmTransactionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TimeOffRequest);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffService,
        { provide: getRepositoryToken(TimeOffRequest), useFactory: mockRequestRepo },
        { provide: getRepositoryToken(TimeOffBalance), useFactory: mockBalanceRepo },
        { provide: getRepositoryToken(BalanceSyncLog), useFactory: mockSyncLogRepo },
        { provide: BalanceService, useFactory: mockBalanceService },
        { provide: HcmClientService, useFactory: mockHcmClient },
      ],
    }).compile();

    service = module.get<TimeOffService>(TimeOffService);
    requestRepo = module.get(getRepositoryToken(TimeOffRequest));
    balanceRepo = module.get(getRepositoryToken(TimeOffBalance));
    syncLogRepo = module.get(getRepositoryToken(BalanceSyncLog));
    balanceService = module.get(BalanceService);
    hcmClient = module.get(HcmClientService);
  });

  describe('createRequest', () => {
    it('should throw BadRequestException when idempotency key is missing', async () => {
      await expect(
        service.createRequest(
          { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-03', daysRequested: 2 },
          '',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return existing request for duplicate idempotency key', async () => {
      const existingReq = makeRequest();
      requestRepo.findOne.mockResolvedValueOnce(existingReq);

      const result = await service.createRequest(
        { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-03', daysRequested: 2 },
        'idem-1',
      );
      expect(result.isNew).toBe(false);
      expect(result.request).toEqual(existingReq);
    });

    it('should reject overlapping dates', async () => {
      requestRepo.findOne.mockResolvedValueOnce(null); // no idempotency match
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(makeRequest()), // overlap found
      };
      requestRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.createRequest(
          { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-05', daysRequested: 3 },
          'idem-new',
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw 422 when insufficient balance', async () => {
      requestRepo.findOne.mockResolvedValueOnce(null);
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      requestRepo.createQueryBuilder.mockReturnValue(qb);
      balanceService.getOrFetchBalance.mockResolvedValue(makeBalance({ hcmAvailableBalance: 2, pendingBalance: 0 }));
      balanceService.computeAvailableToReserve.mockReturnValue(2);

      await expect(
        service.createRequest(
          { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-05', daysRequested: 5 },
          'idem-new',
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw ConflictException when optimistic lock fails', async () => {
      requestRepo.findOne.mockResolvedValueOnce(null);
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      requestRepo.createQueryBuilder.mockReturnValue(qb);
      balanceService.getOrFetchBalance.mockResolvedValue(makeBalance());
      balanceService.computeAvailableToReserve.mockReturnValue(10);

      const savedReq = makeRequest();
      requestRepo.create.mockReturnValue(savedReq);
      requestRepo.save.mockResolvedValue(savedReq);
      balanceService.tryIncrementPending.mockResolvedValue(false); // lock conflict
      requestRepo.delete.mockResolvedValue({});

      await expect(
        service.createRequest(
          { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-05', daysRequested: 3 },
          'idem-new',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully create a request when all conditions are met', async () => {
      requestRepo.findOne.mockResolvedValueOnce(null);
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      requestRepo.createQueryBuilder.mockReturnValue(qb);
      balanceService.getOrFetchBalance.mockResolvedValue(makeBalance());
      balanceService.computeAvailableToReserve.mockReturnValue(10);

      const savedReq = makeRequest();
      requestRepo.create.mockReturnValue(savedReq);
      requestRepo.save.mockResolvedValue(savedReq);
      balanceService.tryIncrementPending.mockResolvedValue(true);
      syncLogRepo.create.mockReturnValue({});
      syncLogRepo.save.mockResolvedValue({});

      const result = await service.createRequest(
        { employeeId: 'emp-1', locationId: 'loc-1', startDate: '2026-07-01', endDate: '2026-07-05', daysRequested: 3 },
        'idem-new',
      );
      expect(result.isNew).toBe(true);
      expect(result.request).toEqual(savedReq);
    });
  });

  describe('listRequests', () => {
    it('should throw BadRequestException for an invalid status value', async () => {
      await expect(service.listRequests('emp-1', 'INVALID')).rejects.toThrow(BadRequestException);
    });

    it('should return all requests when no status filter is given', async () => {
      const reqs = [makeRequest(), makeRequest({ id: 'req-2', status: TimeOffStatus.APPROVED })];
      requestRepo.find.mockResolvedValue(reqs);

      const result = await service.listRequests('emp-1');
      expect(requestRepo.find).toHaveBeenCalledWith({ where: { employeeId: 'emp-1' }, order: { createdAt: 'DESC' } });
      expect(result).toHaveLength(2);
    });

    it('should filter by status when status is provided', async () => {
      const pendingReqs = [makeRequest()];
      requestRepo.find.mockResolvedValue(pendingReqs);

      const result = await service.listRequests('emp-1', 'PENDING');
      expect(requestRepo.find).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1', status: TimeOffStatus.PENDING },
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('cancelRequest', () => {
    it('should cancel a PENDING request and release pendingBalance', async () => {
      const pendingReq = makeRequest({ status: TimeOffStatus.PENDING });
      requestRepo.findOne
        .mockResolvedValueOnce(pendingReq)
        .mockResolvedValueOnce({ ...pendingReq, status: TimeOffStatus.CANCELLED });
      requestRepo.update.mockResolvedValue({});
      balanceRepo.findOne.mockResolvedValue(makeBalance());
      balanceService.decrementPending.mockResolvedValue(undefined);

      const result = await service.cancelRequest('req-1', 'emp-1');
      expect(requestRepo.update).toHaveBeenCalledWith('req-1', { status: TimeOffStatus.CANCELLED, note: null });
      expect(balanceService.decrementPending).toHaveBeenCalled();
      expect(result.status).toBe(TimeOffStatus.CANCELLED);
    });

    it('should throw ForbiddenException when cancelling another employee\'s request', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest({ status: TimeOffStatus.PENDING }));

      await expect(service.cancelRequest('req-1', 'emp-other')).rejects.toThrow(ForbiddenException);
    });

    it('should throw UnprocessableEntityException when cancelling a REJECTED request', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest({ status: TimeOffStatus.REJECTED }));

      await expect(service.cancelRequest('req-1', 'emp-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw UnprocessableEntityException when cancelling APPROVED request with null hcmTransactionId', async () => {
      requestRepo.findOne.mockResolvedValue(
        makeRequest({ status: TimeOffStatus.APPROVED, hcmTransactionId: null }),
      );

      await expect(service.cancelRequest('req-1', 'emp-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('should not call HCM when cancelling a PENDING request', async () => {
      const pendingReq = makeRequest({ status: TimeOffStatus.PENDING });
      requestRepo.findOne
        .mockResolvedValueOnce(pendingReq)
        .mockResolvedValueOnce({ ...pendingReq, status: TimeOffStatus.CANCELLED });
      requestRepo.update.mockResolvedValue({});
      balanceRepo.findOne.mockResolvedValue(makeBalance());
      balanceService.decrementPending.mockResolvedValue(undefined);

      await service.cancelRequest('req-1', 'emp-1');
      expect(hcmClient.getBalance).not.toHaveBeenCalled();
      expect(hcmClient.submitRequest).not.toHaveBeenCalled();
    });
  });

  describe('approveRequest', () => {
    it('should approve a PENDING request', async () => {
      const pendingReq = makeRequest({ status: TimeOffStatus.PENDING });
      const approvedReq = makeRequest({ status: TimeOffStatus.APPROVED, hcmTransactionId: 'hcm-tx-1' });
      requestRepo.findOne
        .mockResolvedValueOnce(pendingReq)
        .mockResolvedValueOnce(approvedReq);
      hcmClient.getBalance.mockResolvedValue({ hcmAvailableBalance: 10 });
      balanceRepo.findOne.mockResolvedValue(makeBalance());
      hcmClient.submitRequest.mockResolvedValue({ hcmTransactionId: 'hcm-tx-1' });
      requestRepo.update.mockResolvedValue({});
      balanceService.decrementPendingAndHcm.mockResolvedValue(undefined);

      const result = await service.approveRequest('req-1');
      expect(result.status).toBe(TimeOffStatus.APPROVED);
      expect(result.hcmTransactionId).toBe('hcm-tx-1');
      expect(balanceService.decrementPendingAndHcm).toHaveBeenCalled();
    });

    it('should throw 422 when trying to approve non-PENDING request', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest({ status: TimeOffStatus.APPROVED }));

      await expect(service.approveRequest('req-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('should auto-reject and throw 422 when balance is insufficient at approval time', async () => {
      const pendingReq = makeRequest({ status: TimeOffStatus.PENDING, daysRequested: 10 });
      requestRepo.findOne.mockResolvedValue(pendingReq);
      hcmClient.getBalance.mockResolvedValue({ hcmAvailableBalance: 3 });
      balanceRepo.findOne.mockResolvedValue(makeBalance({ pendingBalance: 0 }));
      requestRepo.update.mockResolvedValue({});
      balanceService.decrementPending.mockResolvedValue(undefined);

      await expect(service.approveRequest('req-1')).rejects.toThrow(UnprocessableEntityException);
      expect(requestRepo.update).toHaveBeenCalledWith('req-1', {
        status: TimeOffStatus.REJECTED,
        note: expect.stringContaining('Automatically rejected'),
      });
      expect(balanceService.decrementPending).toHaveBeenCalled();
    });
  });

  describe('rejectRequest', () => {
    it('should reject a PENDING request and release pendingBalance', async () => {
      const pendingReq = makeRequest({ status: TimeOffStatus.PENDING });
      const rejectedReq = makeRequest({ status: TimeOffStatus.REJECTED });
      requestRepo.findOne
        .mockResolvedValueOnce(pendingReq)
        .mockResolvedValueOnce(rejectedReq);
      requestRepo.update.mockResolvedValue({});
      balanceRepo.findOne.mockResolvedValue(makeBalance());
      balanceService.decrementPending.mockResolvedValue(undefined);

      const result = await service.rejectRequest('req-1');
      expect(requestRepo.update).toHaveBeenCalledWith('req-1', { status: TimeOffStatus.REJECTED, note: null });
      expect(balanceService.decrementPending).toHaveBeenCalled();
      expect(result.status).toBe(TimeOffStatus.REJECTED);
    });

    it('should throw when rejecting non-PENDING request', async () => {
      requestRepo.findOne.mockResolvedValue(makeRequest({ status: TimeOffStatus.REJECTED }));

      await expect(service.rejectRequest('req-1')).rejects.toThrow(UnprocessableEntityException);
    });
  });
});
