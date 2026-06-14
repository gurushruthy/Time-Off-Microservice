import { Controller, Post, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { HcmSyncService } from '../hcm/hcm-sync.service';
import { SyncSource } from '../balance/entities/balance-sync-log.entity';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin')
@UseGuards(RolesGuard)
export class AdminController {
  constructor(private readonly hcmSyncService: HcmSyncService) {}

  @Post('hcm/sync')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async triggerSync() {
    await this.hcmSyncService.runBatchSync(SyncSource.BATCH_MANUAL);
    return { message: 'Batch sync completed successfully' };
  }
}
