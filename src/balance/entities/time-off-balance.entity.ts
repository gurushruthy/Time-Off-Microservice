import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('time_off_balance')
@Unique(['employeeId', 'locationId'])
export class TimeOffBalance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', nullable: false })
  employeeId: string;

  @Column({ type: 'varchar', nullable: false })
  locationId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: false })
  hcmAvailableBalance: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  pendingBalance: number;

  @Column({ type: 'datetime', nullable: true })
  lastSyncedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  version: number;
}
