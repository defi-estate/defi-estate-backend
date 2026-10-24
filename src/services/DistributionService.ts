import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { StellarService } from './StellarService';
import type { DistributionRepository } from '../db/repositories/DistributionRepository';
import type { BalanceRepository } from '../db/repositories/BalanceRepository';
import type { NotificationService } from './NotificationService';

export const MAX_BATCH_SIZE = 100;

export interface HolderBalance {
  holder: string;
  balance: bigint;
}

export interface Allocation {
  holder: string;
  amount: bigint;
}

export interface DistributionRecord {
  id?: string;
  propertyId: string;
  period: string;
  grossAmount: bigint;
  snapshotLedger: number;
  allocations: Allocation[];
  txHashes: string[];
  createdAt?: Date;
}

export interface CreateDistributionInput {
  propertyId: string;
  period: string;
  grossAmount: bigint;
  snapshotLedger: number;
}

export interface DistributionServiceDeps {
  stellarService: StellarService;
  distributionRepository: DistributionRepository;
  balanceRepository: BalanceRepository;
  yieldDistributorContractId: string;
  notificationService?: NotificationService;
}

/**
 * Pure allocation helper.
 *
 * Allocates `grossAmount` pro-rata across holders based on their balances,
 * rounding down each share. The remainder (from floor rounding) is assigned
 * to the largest holder so the sum of allocations equals `grossAmount` exactly.
 *
 * Holders with zero balance are excluded. If there are no holders with a
 * positive balance, an empty allocation list is returned.
 */
export function allocateProRata(
  balances: HolderBalance[],
  grossAmount: bigint,
): Allocation[] {
  if (grossAmount < 0n) {
    throw new Error('grossAmount must be non-negative');
  }

  const eligible = balances.filter((b) => b.balance > 0n);
  if (eligible.length === 0) {
    return [];
  }

  const totalBalance = eligible.reduce((sum, b) => sum + b.balance, 0n);
  if (totalBalance <= 0n) {
    return [];
  }

  const allocations: Allocation[] = eligible.map((b) => ({
    holder: b.holder,
    amount: (grossAmount * b.balance) / totalBalance,
  }));

  const allocated = allocations.reduce((sum, a) => sum + a.amount, 0n);
  const remainder = grossAmount - allocated;

  if (remainder > 0n) {
    // Assign remainder to the largest holder. Ties are broken by the first
    // encountered in the input order for determinism.
    let largestIdx = 0;
    for (let i = 1; i < eligible.length; i++) {
      if (eligible[i].balance > eligible[largestIdx].balance) {
        largestIdx = i;
      }
    }
    allocations[largestIdx].amount += remainder;
  }

  return allocations;
}

/**
 * Pure batching helper. Splits allocations into batches of at most
 * `MAX_BATCH_SIZE` entries, preserving order.
 */
export function batchAllocations(
  allocations: Allocation[],
  batchSize: number = MAX_BATCH_SIZE,
): Allocation[][] {
  if (batchSize <= 0) {
    throw new Error('batchSize must be positive');
  }
  const batches: Allocation[][] = [];
  for (let i = 0; i < allocations.length; i += batchSize) {
    batches.push(allocations.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Converts an allocation batch into the `Map<Address, i128>` ScVal expected
 * by the yield-distributor's `distribute` entrypoint.
 */
export function allocationsToScVal(batch: Allocation[]): xdr.ScVal {
  const entries = batch.map((a) => {
    const address = Address.fromString(a.holder);
    return new xdr.ScMapEntry({
      key: address.toScVal(),
      val: nativeToScVal(a.amount, { type: 'i128' }),
    });
  });
  return xdr.ScVal.scvMap(entries);
}

export class DistributionService {
  private readonly stellarService: StellarService;
  private readonly distributionRepository: DistributionRepository;
  private readonly balanceRepository: BalanceRepository;
  private readonly yieldDistributorContractId: string;
  private readonly notificationService?: NotificationService;

  constructor(deps: DistributionServiceDeps) {
    this.stellarService = deps.stellarService;
    this.distributionRepository = deps.distributionRepository;
    this.balanceRepository = deps.balanceRepository;
    this.yieldDistributorContractId = deps.yieldDistributorContractId;
    this.notificationService = deps.notificationService;
  }

  /**
   * Computes and submits a rental distribution for the given property and
   * period, based on holder balances at `snapshotLedger`.
   */
  async createDistribution(
    input: CreateDistributionInput,
  ): Promise<DistributionRecord> {
    const { propertyId, period, grossAmount, snapshotLedger } = input;

    if (grossAmount <= 0n) {
      throw new Error('grossAmount must be positive');
    }

    const balances = await this.balanceRepository.getBalancesAtLedger(
      propertyId,
      snapshotLedger,
    );

    const allocations = allocateProRata(balances, grossAmount);
    if (allocations.length === 0) {
      throw new Error('No holders with positive balance at snapshot ledger');
    }

    const batches = batchAllocations(allocations);
    const txHashes: string[] = [];

    for (const batch of batches) {
      const allocationsScVal = allocationsToScVal(batch);
      const txHash = await this.stellarService.distribute(
        this.yieldDistributorContractId,
        propertyId,
        allocationsScVal,
      );
      txHashes.push(txHash);
    }

    const record: DistributionRecord = {
      propertyId,
      period,
      grossAmount,
      snapshotLedger,
      allocations,
      txHashes,
    };

    const saved = await this.distributionRepository.save(record);

    if (this.notificationService) {
      await this.notificationService.enqueueYieldReadyNotifications({
        distributionId: saved.id,
        propertyId,
        period,
        allocations,
      });
    }

    return saved;
  }
}