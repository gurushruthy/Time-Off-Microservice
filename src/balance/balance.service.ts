import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TimeOffBalance } from './entities/time-off-balance.entity';
import { BalanceSyncLog, SyncSource } from './entities/balance-sync-log.entity';
import { HcmClientService } from '../hcm/hcm-client.service';

export interface BalanceResult {
  employeeId: string;
  locationId: string;
  hcmAvailableBalance: number;
  pendingBalance: number;
  availableToReserve: number;
  lastSyncedAt: Date | null;
}

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    @InjectRepository(BalanceSyncLog)
    private readonly syncLogRepo: Repository<BalanceSyncLog>,
    private readonly hcmClient: HcmClientService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  private isStale(lastSyncedAt: Date | null): boolean {
    if (!lastSyncedAt) return true;
    const thresholdMinutes = parseInt(
      this.configService.get<string>('BALANCE_STALENESS_THRESHOLD_MINUTES', '15'),
      10,
    );
    const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
    return ageMs > thresholdMinutes * 60 * 1000;
  }

  computeAvailableToReserve(hcmAvailableBalance: number, pendingBalance: number): number {
    return Number(hcmAvailableBalance) - Number(pendingBalance);
  }

  async getBalance(employeeId: string, locationId: string): Promise<BalanceResult> {
    let balance = await this.balanceRepo.findOne({
      where: { employeeId, locationId },
    });

    if (!balance || this.isStale(balance.lastSyncedAt)) {
      const hcmData = await this.hcmClient.getBalance(employeeId, locationId);
      const previousBalance = balance ? Number(balance.hcmAvailableBalance) : 0;

      if (balance) {
        await this.balanceRepo.update(balance.id, {
          hcmAvailableBalance: hcmData.hcmAvailableBalance,
          lastSyncedAt: new Date(),
          version: balance.version + 1,
        });
        balance = await this.balanceRepo.findOne({ where: { id: balance.id } });
      } else {
        balance = this.balanceRepo.create({
          employeeId,
          locationId,
          hcmAvailableBalance: hcmData.hcmAvailableBalance,
          pendingBalance: 0,
          lastSyncedAt: new Date(),
          version: 0,
        });
        balance = await this.balanceRepo.save(balance);
      }

      const log = this.syncLogRepo.create({
        employeeId,
        locationId,
        source: SyncSource.REALTIME_PULL,
        previousBalance,
        newBalance: hcmData.hcmAvailableBalance,
      });
      await this.syncLogRepo.save(log);
    }

    const availableToReserve = this.computeAvailableToReserve(
      balance.hcmAvailableBalance,
      balance.pendingBalance,
    );

    return {
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      hcmAvailableBalance: Number(balance.hcmAvailableBalance),
      pendingBalance: Number(balance.pendingBalance),
      availableToReserve,
      lastSyncedAt: balance.lastSyncedAt,
    };
  }

  async getOrFetchBalance(employeeId: string, locationId: string): Promise<TimeOffBalance> {
    const hcmData = await this.hcmClient.getBalance(employeeId, locationId);
    const existing = await this.balanceRepo.findOne({ where: { employeeId, locationId } });

    const previousBalance = existing ? Number(existing.hcmAvailableBalance) : 0;

    let balance: TimeOffBalance;
    if (existing) {
      await this.balanceRepo.update(existing.id, {
        hcmAvailableBalance: hcmData.hcmAvailableBalance,
        lastSyncedAt: new Date(),
        version: existing.version + 1,
      });
      balance = await this.balanceRepo.findOne({ where: { id: existing.id } });
    } else {
      balance = this.balanceRepo.create({
        employeeId,
        locationId,
        hcmAvailableBalance: hcmData.hcmAvailableBalance,
        pendingBalance: 0,
        lastSyncedAt: new Date(),
        version: 0,
      });
      balance = await this.balanceRepo.save(balance);
    }

    const log = this.syncLogRepo.create({
      employeeId,
      locationId,
      source: SyncSource.REQUEST,
      previousBalance,
      newBalance: hcmData.hcmAvailableBalance,
    });
    await this.syncLogRepo.save(log);

    return balance;
  }

  /**
   * Attempts to atomically increment pendingBalance using optimistic locking.
   * Returns false if the update conflicts (0 rows affected).
   */
  async tryIncrementPending(
    balanceId: number,
    version: number,
    delta: number,
  ): Promise<boolean> {
    const result = await this.balanceRepo
      .createQueryBuilder()
      .update(TimeOffBalance)
      .set({
        pendingBalance: () => `pendingBalance + ${delta}`,
        version: version + 1,
      })
      .where('id = :id AND version = :version', { id: balanceId, version })
      .execute();

    return result.affected > 0;
  }

  async decrementPending(balanceId: number, delta: number): Promise<void> {
    await this.balanceRepo
      .createQueryBuilder()
      .update(TimeOffBalance)
      .set({
        pendingBalance: () => `MAX(0, pendingBalance - ${delta})`,
      })
      .where('id = :id', { id: balanceId })
      .execute();
  }

  // On approval: HCM has now recorded the deduction, so reduce our cached hcmAvailableBalance
  // and release the pending hold simultaneously.
  async decrementPendingAndHcm(balanceId: number, delta: number): Promise<void> {
    await this.balanceRepo
      .createQueryBuilder()
      .update(TimeOffBalance)
      .set({
        pendingBalance: () => `MAX(0, pendingBalance - ${delta})`,
        hcmAvailableBalance: () => `MAX(0, hcmAvailableBalance - ${delta})`,
      })
      .where('id = :id', { id: balanceId })
      .execute();
  }
}
