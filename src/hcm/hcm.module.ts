import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmClientService } from './hcm-client.service';
import { HcmSyncService } from './hcm-sync.service';
import { HcmSchedulerService } from './hcm-scheduler.service';
import { TimeOffBalance } from '../balance/entities/time-off-balance.entity';
import { BalanceSyncLog } from '../balance/entities/balance-sync-log.entity';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        timeout: parseInt(configService.get<string>('HCM_TIMEOUT_MS', '5000'), 10),
      }),
    }),
    TypeOrmModule.forFeature([TimeOffBalance, BalanceSyncLog]),
  ],
  providers: [HcmClientService, HcmSyncService, HcmSchedulerService],
  exports: [HcmClientService, HcmSyncService],
})
export class HcmModule {}
