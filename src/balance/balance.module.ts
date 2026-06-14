import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffBalance } from './entities/time-off-balance.entity';
import { BalanceSyncLog } from './entities/balance-sync-log.entity';
import { BalanceService } from './balance.service';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffBalance, BalanceSyncLog]),
    HcmModule,
  ],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
