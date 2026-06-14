import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum TimeOffStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity('time_off_request')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true, nullable: false })
  idempotencyKey: string;

  @Column({ type: 'varchar', nullable: false })
  employeeId: string;

  @Column({ type: 'varchar', nullable: false })
  locationId: string;

  @Column({ type: 'varchar', nullable: false })
  startDate: string;

  @Column({ type: 'varchar', nullable: false })
  endDate: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  daysRequested: number;

  @Column({ type: 'varchar', default: TimeOffStatus.PENDING })
  status: TimeOffStatus;

  @Column({ type: 'varchar', nullable: true })
  hcmTransactionId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
