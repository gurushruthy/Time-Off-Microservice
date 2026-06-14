import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HcmClientService } from './hcm-client.service';
import { TimeOffBalance } from '../balance/entities/time-off-balance.entity';
import { BalanceSyncLog, SyncSource } from '../balance/entities/balance-sync-log.entity';

@Injectable()
export class HcmSyncService {
  private readonly logger = new Logger(HcmSyncService.name);

  constructor(
    private readonly hcmClient: HcmClientService,
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    @InjectRepository(BalanceSyncLog)
    private readonly syncLogRepo: Repository<BalanceSyncLog>,
  ) {}

  async runBatchSync(source: SyncSource = SyncSource.BATCH_CRON): Promise<void> {
    this.logger.log(`Running batch sync [source=${source}]`);

    const batchData = await this.hcmClient.getBatch();

    for (const item of batchData) {
      const existing = await this.balanceRepo.findOne({
        where: { employeeId: item.employeeId, locationId: item.locationId },
      });

      const previousBalance = existing ? Number(existing.hcmAvailableBalance) : 0;

      if (existing) {
        await this.balanceRepo.update(existing.id, {
          hcmAvailableBalance: item.hcmAvailableBalance,
          lastSyncedAt: new Date(),
          version: existing.version + 1,
        });
      } else {
        const newBalance = this.balanceRepo.create({
          employeeId: item.employeeId,
          locationId: item.locationId,
          hcmAvailableBalance: item.hcmAvailableBalance,
          pendingBalance: 0,
          lastSyncedAt: new Date(),
          version: 0,
        });
        await this.balanceRepo.save(newBalance);
      }

      const log = this.syncLogRepo.create({
        employeeId: item.employeeId,
        locationId: item.locationId,
        source,
        previousBalance,
        newBalance: item.hcmAvailableBalance,
      });
      await this.syncLogRepo.save(log);
    }

    this.logger.log(`Batch sync complete: ${batchData.length} records processed`);
  }
}
