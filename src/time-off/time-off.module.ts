import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { TimeOffBalance } from '../balance/entities/time-off-balance.entity';
import { BalanceSyncLog } from '../balance/entities/balance-sync-log.entity';
import { BalanceModule } from '../balance/balance.module';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, TimeOffBalance, BalanceSyncLog]),
    BalanceModule,
    HcmModule,
  ],
  controllers: [TimeOffController],
  providers: [TimeOffService],
  exports: [TimeOffService],
})
export class TimeOffModule {}
