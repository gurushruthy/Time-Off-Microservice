import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MockHcmModule } from './mock-hcm.module';

async function bootstrap() {
  const app = await NestFactory.create(MockHcmModule);
  const port = process.env.MOCK_HCM_PORT || 3001;
  await app.listen(port);
  console.log(`Mock HCM server running on port ${port}`);
}

bootstrap();
