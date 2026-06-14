import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HcmSyncService } from './hcm-sync.service';
import { SyncSource } from '../balance/entities/balance-sync-log.entity';

@Injectable()
export class HcmSchedulerService {
  private readonly logger = new Logger(HcmSchedulerService.name);

  constructor(
    private readonly hcmSyncService: HcmSyncService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('0 */6 * * *', { name: 'hcm-batch-sync' })
  async handleCron() {
    this.logger.log('Scheduled HCM batch sync triggered');
    try {
      await this.hcmSyncService.runBatchSync(SyncSource.BATCH_CRON);
    } catch (err) {
      this.logger.error(`Scheduled batch sync failed: ${err.message}`);
    }
  }
}
