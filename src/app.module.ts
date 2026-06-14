import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { TimeOffModule } from './time-off/time-off.module';
import { BalanceModule } from './balance/balance.module';
import { HcmModule } from './hcm/hcm.module';
import { TimeOffBalance } from './balance/entities/time-off-balance.entity';
import { BalanceSyncLog } from './balance/entities/balance-sync-log.entity';
import { TimeOffRequest } from './time-off/entities/time-off-request.entity';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: false,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'better-sqlite3',
        database: configService.get<string>('DATABASE_PATH', './data/timeoff.sqlite'),
        entities: [TimeOffBalance, BalanceSyncLog, TimeOffRequest],
        synchronize: true,
        logging: false,
      }),
    }),
    ScheduleModule.forRoot(),
    TimeOffModule,
    BalanceModule,
    HcmModule,
    AdminModule,
  ],
})
export class AppModule {}
