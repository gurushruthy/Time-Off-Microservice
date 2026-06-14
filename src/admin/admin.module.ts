import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { HcmModule } from '../hcm/hcm.module';

@Module({
  imports: [HcmModule],
  controllers: [AdminController],
})
export class AdminModule {}
