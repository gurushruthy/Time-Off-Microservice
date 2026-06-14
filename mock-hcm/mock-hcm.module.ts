import { Module } from '@nestjs/common';
import { HcmController } from './mock-hcm.controller';
import { HcmStateService } from './mock-hcm-state.service';

@Module({
  controllers: [HcmController],
  providers: [HcmStateService],
})
export class MockHcmModule {}
