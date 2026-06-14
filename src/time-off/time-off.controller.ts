import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { TimeOffService } from './time-off.service';
import { BalanceService } from '../balance/balance.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { NoteDto } from './dto/note.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('time-off')
@UseGuards(RolesGuard)
export class TimeOffController {
  constructor(
    private readonly timeOffService: TimeOffService,
    private readonly balanceService: BalanceService,
  ) {}

  @Get('balance')
  @Roles('employee', 'manager')
  async getBalance(
    @Query('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
    @Headers('x-user-role') role: string,
    @Headers('x-user-id') userId: string,
  ) {
    if (!employeeId || !locationId) {
      throw new BadRequestException('employeeId and locationId are required');
    }
    if (role === 'employee' && userId !== employeeId) {
      throw new ForbiddenException('Employees can only view their own balance');
    }
    return this.balanceService.getBalance(employeeId, locationId);
  }

  @Post('requests')
  @Roles('employee')
  @HttpCode(HttpStatus.CREATED)
  async createRequest(
    @Body() dto: CreateRequestDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-user-id') userId: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    if (userId !== dto.employeeId) {
      throw new ForbiddenException('Employees can only submit requests for themselves');
    }
    const { request } = await this.timeOffService.createRequest(dto, idempotencyKey);
    return request;
  }

  @Get('requests')
  @Roles('employee', 'manager')
  async listRequests(
    @Query('employeeId') employeeId: string,
    @Query('status') status: string,
    @Headers('x-user-role') role: string,
    @Headers('x-user-id') userId: string,
  ) {
    if (!employeeId) {
      throw new BadRequestException('employeeId is required');
    }
    if (role === 'employee' && userId !== employeeId) {
      throw new ForbiddenException('Employees can only view their own requests');
    }
    return this.timeOffService.listRequests(employeeId, status);
  }

  @Patch('requests/:id/cancel')
  @Roles('employee')
  async cancelRequest(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: NoteDto,
  ) {
    return this.timeOffService.cancelRequest(id, userId, dto.note);
  }

  @Get('requests/pending')
  @Roles('manager')
  async getPendingRequests() {
    return this.timeOffService.getPendingRequests();
  }

  @Patch('requests/:id/approve')
  @Roles('manager')
  async approveRequest(@Param('id') id: string) {
    return this.timeOffService.approveRequest(id);
  }

  @Patch('requests/:id/reject')
  @Roles('manager')
  async rejectRequest(
    @Param('id') id: string,
    @Body() dto: NoteDto,
  ) {
    return this.timeOffService.rejectRequest(id, dto.note);
  }
}
