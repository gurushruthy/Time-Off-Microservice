import { Injectable, ServiceUnavailableException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

class HcmResponseError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface HcmBalance {
  hcmAvailableBalance: number;
}

export interface HcmBatchItem {
  employeeId: string;
  locationId: string;
  hcmAvailableBalance: number;
}

export interface HcmSubmitRequest {
  employeeId: string;
  locationId: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  requestId: string;
}

export interface HcmSubmitResponse {
  hcmTransactionId: string;
}

@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryCount: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>('HCM_BASE_URL', 'http://mock-hcm:3001');
    this.timeoutMs = parseInt(this.configService.get<string>('HCM_TIMEOUT_MS', '5000'), 10);
    this.retryCount = parseInt(this.configService.get<string>('HCM_RETRY_COUNT', '3'), 10);
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts: number = this.retryCount): Promise<T> {
    const delays = [500, 1000, 2000];
    let lastError: Error;

    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        // 4xx errors are permanent business rejections — retrying will never help
        if (err instanceof HcmResponseError && err.status >= 400 && err.status < 500) {
          throw err;
        }
        lastError = err;
        this.logger.warn(`HCM call failed (attempt ${i + 1}/${attempts}): ${err.message}`);
        if (i < attempts - 1) {
          const delayMs = delays[i] || 2000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    throw new ServiceUnavailableException(`HCM service unavailable after ${attempts} attempts: ${lastError.message}`);
  }

  private extractError(err: any): never {
    if (err.response) {
      throw new HcmResponseError(
        err.response.status,
        `HCM returned ${err.response.status}: ${JSON.stringify(err.response.data)}`,
      );
    }
    throw err;
  }

  async getBalance(employeeId: string, locationId: string): Promise<HcmBalance> {
    return this.withRetry(async () => {
      try {
        const response = await firstValueFrom(
          this.httpService
            .get<HcmBalance>(`${this.baseUrl}/hcm/balance`, {
              params: { employeeId, locationId },
            })
            .pipe(timeout(this.timeoutMs)),
        );
        return response.data;
      } catch (err) {
        this.extractError(err);
      }
    });
  }

  async getBatch(): Promise<HcmBatchItem[]> {
    return this.withRetry(async () => {
      try {
        const response = await firstValueFrom(
          this.httpService
            .get<HcmBatchItem[]>(`${this.baseUrl}/hcm/balance/batch`)
            .pipe(timeout(this.timeoutMs)),
        );
        return response.data;
      } catch (err) {
        this.extractError(err);
      }
    });
  }

  async submitRequest(data: HcmSubmitRequest): Promise<HcmSubmitResponse> {
    return this.withRetry(async () => {
      try {
        const response = await firstValueFrom(
          this.httpService
            .post<HcmSubmitResponse>(`${this.baseUrl}/hcm/time-off`, data)
            .pipe(timeout(this.timeoutMs)),
        );
        return response.data;
      } catch (err) {
        this.extractError(err);
      }
    });
  }

  async cancelTransaction(hcmTransactionId: string): Promise<void> {
    return this.withRetry(async () => {
      try {
        await firstValueFrom(
          this.httpService
            .delete(`${this.baseUrl}/hcm/time-off/${hcmTransactionId}`)
            .pipe(timeout(this.timeoutMs)),
        );
      } catch (err) {
        this.extractError(err);
      }
    });
  }
}
