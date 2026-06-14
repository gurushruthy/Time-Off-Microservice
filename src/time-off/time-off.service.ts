import {
  Injectable,
  BadRequestException,
  UnprocessableEntityException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffRequest, TimeOffStatus } from './entities/time-off-request.entity';
import { CreateRequestDto } from './dto/create-request.dto';
import { BalanceService } from '../balance/balance.service';
import { HcmClientService } from '../hcm/hcm-client.service';
import { BalanceSyncLog, SyncSource } from '../balance/entities/balance-sync-log.entity';
import { TimeOffBalance } from '../balance/entities/time-off-balance.entity';

@Injectable()
export class TimeOffService {

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    @InjectRepository(BalanceSyncLog)
    private readonly syncLogRepo: Repository<BalanceSyncLog>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  async createRequest(
    dto: CreateRequestDto,
    idempotencyKey: string,
  ): Promise<{ request: TimeOffRequest; isNew: boolean }> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    // Idempotency check
    const existing = await this.requestRepo.findOne({ where: { idempotencyKey } });
    if (existing) {
      return { request: existing, isNew: false };
    }

    // Date validation
    if (dto.startDate > dto.endDate) {
      throw new UnprocessableEntityException('startDate must be before or equal to endDate');
    }

    // Overlap detection for PENDING/APPROVED requests
    const overlapping = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.employeeId = :employeeId', { employeeId: dto.employeeId })
      .andWhere('r.locationId = :locationId', { locationId: dto.locationId })
      .andWhere('r.status IN (:...statuses)', { statuses: [TimeOffStatus.PENDING, TimeOffStatus.APPROVED] })
      .andWhere('r.startDate <= :endDate AND r.endDate >= :startDate', {
        startDate: dto.startDate,
        endDate: dto.endDate,
      })
      .getOne();

    if (overlapping) {
      throw new UnprocessableEntityException('Date range overlaps with an existing PENDING or APPROVED request');
    }

    // Fetch fresh balance from HCM (throws 503 if HCM down)
    const balance = await this.balanceService.getOrFetchBalance(dto.employeeId, dto.locationId);
    const availableToReserve = this.balanceService.computeAvailableToReserve(
      balance.hcmAvailableBalance,
      balance.pendingBalance,
    );

    if (availableToReserve < dto.daysRequested) {
      throw new UnprocessableEntityException(
        `Insufficient balance: available=${availableToReserve}, requested=${dto.daysRequested}`,
      );
    }

    // Create the request
    const request = this.requestRepo.create({
      idempotencyKey,
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      daysRequested: dto.daysRequested,
      status: TimeOffStatus.PENDING,
    });
    const savedRequest = await this.requestRepo.save(request);

    // Optimistic lock: increment pendingBalance
    const updated = await this.balanceService.tryIncrementPending(
      balance.id,
      balance.version,
      dto.daysRequested,
    );

    if (!updated) {
      // Rollback: delete the request we just created
      await this.requestRepo.delete(savedRequest.id);
      throw new ConflictException('Concurrent modification detected. Please retry.');
    }

    // Log
    const log = this.syncLogRepo.create({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      source: SyncSource.REQUEST,
      previousBalance: Number(balance.hcmAvailableBalance),
      newBalance: Number(balance.hcmAvailableBalance),
    });
    await this.syncLogRepo.save(log);

    return { request: savedRequest, isNew: true };
  }

  async listRequests(employeeId: string): Promise<TimeOffRequest[]> {
    return this.requestRepo.find({ where: { employeeId }, order: { createdAt: 'DESC' } });
  }

  async cancelRequest(id: string, userId: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    if (request.employeeId !== userId) {
      throw new ForbiddenException('Employees can only cancel their own requests');
    }

    if (request.status === TimeOffStatus.PENDING) {
      await this.requestRepo.update(id, { status: TimeOffStatus.CANCELLED });

      const balance = await this.balanceRepo.findOne({
        where: { employeeId: request.employeeId, locationId: request.locationId },
      });
      if (balance) {
        await this.balanceService.decrementPending(balance.id, Number(request.daysRequested));
      }
    } else if (request.status === TimeOffStatus.APPROVED) {
      // Fail closed — if HCM cannot confirm the reversal, do not change local state
      await this.hcmClient.cancelTransaction(request.hcmTransactionId);

      await this.requestRepo.update(id, { status: TimeOffStatus.CANCELLED });

      // Immediately re-fetch balance from HCM so the restored days are visible without
      // waiting for the next batch sync
      await this.balanceService.getOrFetchBalance(request.employeeId, request.locationId);
    } else {
      throw new UnprocessableEntityException(
        `Cannot cancel a request with status ${request.status}. Only PENDING or APPROVED requests can be cancelled.`,
      );
    }

    return this.requestRepo.findOne({ where: { id } });
  }

  async getPendingRequests(): Promise<TimeOffRequest[]> {
    return this.requestRepo.find({
      where: { status: TimeOffStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
  }

  async approveRequest(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    if (request.status !== TimeOffStatus.PENDING) {
      throw new UnprocessableEntityException(
        `Cannot approve a request with status ${request.status}. Only PENDING requests can be approved.`,
      );
    }

    // Fetch fresh balance from HCM
    const hcmData = await this.hcmClient.getBalance(request.employeeId, request.locationId);
    const balance = await this.balanceRepo.findOne({
      where: { employeeId: request.employeeId, locationId: request.locationId },
    });

    const currentPending = balance ? Number(balance.pendingBalance) : 0;
    const availableToReserve = Number(hcmData.hcmAvailableBalance) - currentPending;

    if (availableToReserve < Number(request.daysRequested)) {
      throw new UnprocessableEntityException(
        `Insufficient balance for approval: available=${availableToReserve}, requested=${request.daysRequested}`,
      );
    }

    // Submit to HCM
    const hcmResponse = await this.hcmClient.submitRequest({
      employeeId: request.employeeId,
      locationId: request.locationId,
      startDate: request.startDate,
      endDate: request.endDate,
      daysRequested: Number(request.daysRequested),
      requestId: request.id,
    });

    // Update request and balance atomically
    await this.requestRepo.update(id, {
      status: TimeOffStatus.APPROVED,
      hcmTransactionId: hcmResponse.hcmTransactionId,
    });

    if (balance) {
      await this.balanceService.decrementPendingAndHcm(balance.id, Number(request.daysRequested));
    }

    return this.requestRepo.findOne({ where: { id } });
  }

  async rejectRequest(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    if (request.status !== TimeOffStatus.PENDING) {
      throw new UnprocessableEntityException(
        `Cannot reject a request with status ${request.status}. Only PENDING requests can be rejected.`,
      );
    }

    await this.requestRepo.update(id, { status: TimeOffStatus.REJECTED });

    // Release pending balance
    const balance = await this.balanceRepo.findOne({
      where: { employeeId: request.employeeId, locationId: request.locationId },
    });
    if (balance) {
      await this.balanceService.decrementPending(balance.id, Number(request.daysRequested));
    }

    return this.requestRepo.findOne({ where: { id } });
  }
}
