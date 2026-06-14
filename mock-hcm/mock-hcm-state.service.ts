import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export interface BalanceRecord {
  employeeId: string;
  locationId: string;
  hcmAvailableBalance: number;
}

export interface Transaction {
  employeeId: string;
  locationId: string;
  daysRequested: number;
}

const SEED_DATA: BalanceRecord[] = [
  { employeeId: 'employee-1', locationId: 'location-1', hcmAvailableBalance: 10 },
  { employeeId: 'employee-1', locationId: 'location-2', hcmAvailableBalance: 5 },
  { employeeId: 'employee-2', locationId: 'location-1', hcmAvailableBalance: 8 },
];

@Injectable()
export class HcmStateService {
  private balances: BalanceRecord[] = JSON.parse(JSON.stringify(SEED_DATA));
  private transactions: Map<string, Transaction> = new Map();
  private errorMode: boolean = false;
  private errorCount: number = 0;
  private silentBadBalance: boolean = false;

  reset() {
    this.balances = JSON.parse(JSON.stringify(SEED_DATA));
    this.transactions = new Map();
    this.errorMode = false;
    this.errorCount = 0;
    this.silentBadBalance = false;
  }

  getState() {
    return {
      balances: this.balances,
      transactions: Object.fromEntries(this.transactions),
      errorMode: this.errorMode,
      errorCount: this.errorCount,
      silentBadBalance: this.silentBadBalance,
    };
  }

  setErrorMode(enabled: boolean, count: number = 0) {
    this.errorMode = enabled;
    this.errorCount = count;
  }

  setSilentBadBalance(enabled: boolean) {
    this.silentBadBalance = enabled;
  }

  shouldError(): boolean {
    if (this.errorMode && this.errorCount > 0) {
      this.errorCount--;
      return true;
    }
    if (this.errorMode && this.errorCount === 0) {
      return true;
    }
    return false;
  }

  isSilentBadBalance(): boolean {
    return this.silentBadBalance;
  }

  getBalance(employeeId: string, locationId: string): BalanceRecord | undefined {
    return this.balances.find(
      b => b.employeeId === employeeId && b.locationId === locationId,
    );
  }

  getAllBalances(): BalanceRecord[] {
    return this.balances;
  }

  submitRequest(employeeId: string, locationId: string, daysRequested: number, requestId: string): string {
    const balance = this.getBalance(employeeId, locationId);
    if (!balance) {
      throw new Error(`No balance found for ${employeeId}/${locationId}`);
    }
    balance.hcmAvailableBalance -= daysRequested;
    const hcmTransactionId = uuidv4();
    this.transactions.set(hcmTransactionId, { employeeId, locationId, daysRequested });
    return hcmTransactionId;
  }

  cancelTransaction(hcmTransactionId: string): boolean {
    const tx = this.transactions.get(hcmTransactionId);
    if (!tx) return false;
    const balance = this.getBalance(tx.employeeId, tx.locationId);
    if (balance) {
      balance.hcmAvailableBalance += tx.daysRequested;
    }
    this.transactions.delete(hcmTransactionId);
    return true;
  }

  simulateAnniversary(employeeId: string, locationId: string, bonusDays: number) {
    const balance = this.getBalance(employeeId, locationId);
    if (balance) {
      balance.hcmAvailableBalance += bonusDays;
    } else {
      this.balances.push({ employeeId, locationId, hcmAvailableBalance: bonusDays });
    }
  }

  simulateYearReset(locationId: string, newBalance: number) {
    for (const b of this.balances) {
      if (b.locationId === locationId) {
        b.hcmAvailableBalance = newBalance;
      }
    }
  }
}
