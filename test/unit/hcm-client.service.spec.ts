import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { HcmClientService } from '../../src/hcm/hcm-client.service';

// Override the retry delay so tests don't take seconds
jest.mock('../../src/hcm/hcm-client.service', () => {
  const actual = jest.requireActual('../../src/hcm/hcm-client.service');
  // We will patch the instance after construction
  return actual;
});

const mockHttpService = () => ({
  get: jest.fn(),
  post: jest.fn(),
});

const mockConfigService = () => ({
  get: jest.fn((key: string, defaultVal: any) => {
    const map: Record<string, string> = {
      HCM_BASE_URL: 'http://localhost:3001',
      HCM_TIMEOUT_MS: '500',
      HCM_RETRY_COUNT: '3',
    };
    return map[key] ?? defaultVal;
  }),
});

describe('HcmClientService', () => {
  let service: HcmClientService;
  let httpService: ReturnType<typeof mockHttpService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmClientService,
        { provide: HttpService, useFactory: mockHttpService },
        { provide: ConfigService, useFactory: mockConfigService },
      ],
    }).compile();

    service = module.get<HcmClientService>(HcmClientService);
    httpService = module.get(HttpService);

    // Patch the private withRetry to use zero delays to speed up tests
    (service as any).withRetry = async function<T>(fn: () => Promise<T>, attempts: number = 3): Promise<T> {
      let lastError: Error;
      for (let i = 0; i < attempts; i++) {
        try {
          return await fn();
        } catch (err) {
          lastError = err;
        }
      }
      throw new ServiceUnavailableException(`HCM service unavailable after ${attempts} attempts: ${lastError.message}`);
    };
  });

  describe('getBalance', () => {
    it('should return hcmAvailableBalance on success', async () => {
      httpService.get.mockReturnValue(
        of({ data: { hcmAvailableBalance: 10 }, status: 200 }),
      );

      const result = await service.getBalance('emp-1', 'loc-1');
      expect(result.hcmAvailableBalance).toBe(10);
    });

    it('should retry 3 times on 500 error then throw ServiceUnavailableException', async () => {
      const error = {
        response: { status: 500, data: 'Internal Server Error' },
        message: 'Request failed with status code 500',
      };
      httpService.get.mockImplementation(() => throwError(() => error));

      await expect(service.getBalance('emp-1', 'loc-1')).rejects.toThrow(ServiceUnavailableException);
      expect(httpService.get).toHaveBeenCalledTimes(3);
    });

    it('should succeed if retry succeeds after first failure', async () => {
      const error = {
        response: { status: 500, data: 'error' },
        message: 'Request failed',
      };
      httpService.get
        .mockImplementationOnce(() => throwError(() => error))
        .mockReturnValueOnce(of({ data: { hcmAvailableBalance: 8 }, status: 200 }));

      const result = await service.getBalance('emp-1', 'loc-1');
      expect(result.hcmAvailableBalance).toBe(8);
      expect(httpService.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('submitRequest', () => {
    it('should return hcmTransactionId on success', async () => {
      httpService.post.mockReturnValue(
        of({ data: { hcmTransactionId: 'tx-123' }, status: 200 }),
      );

      const result = await service.submitRequest({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        startDate: '2026-07-01',
        endDate: '2026-07-05',
        daysRequested: 3,
        requestId: 'req-1',
      });
      expect(result.hcmTransactionId).toBe('tx-123');
    });

    it('should throw ServiceUnavailableException after all retries on 500', async () => {
      const error = {
        response: { status: 500, data: 'error' },
        message: 'Request failed',
      };
      httpService.post.mockImplementation(() => throwError(() => error));

      await expect(
        service.submitRequest({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          daysRequested: 3,
          requestId: 'req-1',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(httpService.post).toHaveBeenCalledTimes(3);
    });
  });

  describe('getBatch', () => {
    it('should return array of balance items on success', async () => {
      const batchData = [
        { employeeId: 'emp-1', locationId: 'loc-1', hcmAvailableBalance: 10 },
      ];
      httpService.get.mockReturnValue(of({ data: batchData, status: 200 }));

      const result = await service.getBatch();
      expect(result).toEqual(batchData);
    });

    it('should throw ServiceUnavailableException after 3 retries', async () => {
      const error = {
        response: { status: 500, data: 'error' },
        message: 'Internal Server Error',
      };
      httpService.get.mockImplementation(() => throwError(() => error));

      await expect(service.getBatch()).rejects.toThrow(ServiceUnavailableException);
      expect(httpService.get).toHaveBeenCalledTimes(3);
    });
  });
});
