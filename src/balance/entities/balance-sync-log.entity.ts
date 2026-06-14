import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

export enum SyncSource {
  REALTIME_PULL = 'REALTIME_PULL',
  BATCH_CRON = 'BATCH_CRON',
  BATCH_MANUAL = 'BATCH_MANUAL',
  REQUEST = 'REQUEST',
}

@Entity('balance_sync_log')
export class BalanceSyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  employeeId: string;

  @Column({ type: 'varchar', nullable: true })
  locationId: string;

  @Column({ type: 'varchar' })
  source: SyncSource;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  previousBalance: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  newBalance: number;

  @CreateDateColumn()
  syncedAt: Date;
}
