import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { HcmStateService } from './mock-hcm-state.service';

@Controller()
export class HcmController {
  constructor(private readonly state: HcmStateService) {}

  // ─── HCM API endpoints ───────────────────────────────────────────────────

  @Get('hcm/balance')
  getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
  ) {
    if (this.state.isSilentBadBalance()) {
      return { hcmAvailableBalance: 0 };
    }
    if (this.state.shouldError()) {
      throw new HttpException('HCM Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const balance = this.state.getBalance(employeeId, locationId);
    if (!balance) {
      throw new HttpException(`Balance not found for ${employeeId}/${locationId}`, HttpStatus.NOT_FOUND);
    }
    return { hcmAvailableBalance: balance.hcmAvailableBalance };
  }

  @Get('hcm/balance/batch')
  getBatch() {
    if (this.state.shouldError()) {
      throw new HttpException('HCM Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return this.state.getAllBalances();
  }

  @Post('hcm/time-off')
  submitTimeOff(
    @Body() body: { employeeId: string; locationId: string; daysRequested: number; requestId: string },
  ) {
    if (this.state.shouldError()) {
      throw new HttpException('HCM Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    try {
      const hcmTransactionId = this.state.submitRequest(
        body.employeeId,
        body.locationId,
        body.daysRequested,
        body.requestId,
      );
      return { hcmTransactionId };
    } catch (err) {
      throw new HttpException(err.message, HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  @Delete('hcm/time-off/:id')
  @HttpCode(HttpStatus.OK)
  cancelTimeOff(@Param('id') id: string) {
    if (this.state.shouldError()) {
      throw new HttpException('HCM Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const success = this.state.cancelTransaction(id);
    if (!success) {
      throw new HttpException(`Transaction ${id} not found`, HttpStatus.NOT_FOUND);
    }
    return { message: 'Transaction cancelled and balance restored' };
  }

  // ─── Test control endpoints ──────────────────────────────────────────────

  @Post('test/simulate/anniversary')
  @HttpCode(HttpStatus.OK)
  simulateAnniversary(
    @Body() body: { employeeId: string; locationId: string; bonusDays: number },
  ) {
    this.state.simulateAnniversary(body.employeeId, body.locationId, body.bonusDays);
    return { message: `Added ${body.bonusDays} days to ${body.employeeId}/${body.locationId}` };
  }

  @Post('test/simulate/year-reset')
  @HttpCode(HttpStatus.OK)
  simulateYearReset(@Body() body: { locationId: string; newBalance: number }) {
    this.state.simulateYearReset(body.locationId, body.newBalance);
    return { message: `Reset all balances for location ${body.locationId} to ${body.newBalance}` };
  }

  @Post('test/set-error-mode')
  @HttpCode(HttpStatus.OK)
  setErrorMode(@Body() body: { enabled: boolean; count?: number }) {
    this.state.setErrorMode(body.enabled, body.count ?? (body.enabled ? 999999 : 0));
    return { message: `Error mode set to ${body.enabled}` };
  }

  @Post('test/set-silent-bad-balance')
  @HttpCode(HttpStatus.OK)
  setSilentBadBalance(@Body() body: { enabled: boolean }) {
    this.state.setSilentBadBalance(body.enabled);
    return { message: `Silent bad balance mode set to ${body.enabled}` };
  }

  @Post('test/reset')
  @HttpCode(HttpStatus.OK)
  resetState() {
    this.state.reset();
    return { message: 'State reset to seed data' };
  }

  @Get('test/state')
  getState() {
    return this.state.getState();
  }
}
