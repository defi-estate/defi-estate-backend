import { SorobanRpc, xdr, scValToNative } from '@stellar/stellar-sdk';
import { db } from '../db/client';
import { contractEvents, holderBalances, properties, indexerCursors } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';

const POLL_INTERVAL_MS = Number(process.env.EVENT_INDEXER_POLL_INTERVAL_MS ?? 5000);
const BATCH_LIMIT = Number(process.env.EVENT_INDEXER_BATCH_LIMIT ?? 100);

export interface ContractEventRecord {
  id: string;
  ledger: number;
  contractId: string;
  type: string;
  topic: string[];
  value: unknown;
  txHash: string;
  pagingToken: string;
}

interface IndexerCursor {
  contractId: string;
  lastLedger: number;
  lastPagingToken: string | null;
}

let running = false;
let stopRequested = false;
let timer: NodeJS.Timeout | null = null;

function getRpcServer(): SorobanRpc.Server {
  const url = process.env.SOROBAN_RPC_URL;
  if (!url) {
    throw new Error('SOROBAN_RPC_URL is not configured');
  }
  return new SorobanRpc.Server(url, { allowHttp: url.startsWith('http://') });
}

/**
 * Decode a base64 XDR ScVal into a native JS value, returning the raw string on failure.
 */
function decodeScVal(base64: string): unknown {
  try {
    const scVal = xdr.ScVal.fromXDR(base64, 'base64');
    return scValToNative(scVal);
  } catch {
    return base64;
  }
}

/**
 * Normalize a raw Soroban RPC event into our storage record.
 */
function normalizeEvent(raw: SorobanRpc.Api.EventResponse): ContractEventRecord {
  const topics = (raw.topic ?? []).map((t) => {
    const decoded = decodeScVal(t);
    return typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
  });

  return {
    id: raw.id,
    ledger: raw.ledger,
    contractId: raw.contractId?.toString() ?? '',
    type: raw.type ?? 'contract',
    topic: topics,
    value: decodeScVal(raw.value),
    txHash: raw.txHash ?? '',
    pagingToken: raw.pagingToken ?? raw.id,
  };
}

/**
 * Extract the event name (first topic symbol) from a normalized event.
 */
function eventName(event: ContractEventRecord): string {
  return (event.topic[0] ?? '').toLowerCase();
}

/**
 * Extract an address-like string from a native value.
 */
function asAddress(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.address === 'string') return obj.address;
    if (typeof obj.account === 'string') return obj.account;
  }
  return null;
}

/**
 * Extract an amount-like bigint from a native value.
 */
function asAmount(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.amount !== undefined) return asAmount(obj.amount);
  }
  return null;
}

/**
 * Apply a single event to holder_balances within an existing transaction.
 */
async function applyHolderBalance(
  tx: typeof db,
  propertyId: string,
  event: ContractEventRecord,
): Promise<void> {
  const name = eventName(event);
  const value = event.value as Record<string, unknown> | null;

  let from: string | null = null;
  let to: string | null = null;
  let amount: bigint | null = null;

  if (name === 'mint') {
    // topics: [mint, to]; value: amount
    to = asAddress(event.topic[1]) ?? asAddress(value);
    amount = asAmount(value);
  } else if (name === 'burn') {
    // topics: [burn, from]; value: amount
    from = asAddress(event.topic[1]) ?? asAddress(value);
    amount = asAmount(value);
  } else if (name === 'transfer') {
    // topics: [transfer, from, to]; value: amount
    from = asAddress(event.topic[1]);
    to = asAddress(event.topic[2]);
    amount = asAmount(value);
  } else {
    return;
  }

  if (amount === null) return;

  if (from) {
    await adjustBalance(tx, propertyId, from, -amount);
  }
  if (to) {
    await adjustBalance(tx, propertyId, to, amount);
  }
}

async function adjustBalance(
  tx: typeof db,
  propertyId: string,
  holder: string,
  delta: bigint,
): Promise<void> {
  const existing = await tx
    .select()
    .from(holderBalances)
    .where(and(eq(holderBalances.propertyId, propertyId), eq(holderBalances.holder, holder)))
    .limit(1);

  if (existing.length === 0) {
    const initial = delta < 0n ? 0n : delta;
    await tx.insert(holderBalances).values({
      propertyId,
      holder,
      balance: initial.toString(),
      updatedAt: new Date(),
    });
    return;
  }

  const current = BigInt(existing[0].balance ?? '0');
  const next = current + delta;
  await tx
    .update(holderBalances)
    .set({ balance: (next < 0n ? 0n : next).toString(), updatedAt: new Date() })
    .where(and(eq(holderBalances.propertyId, propertyId), eq(holderBalances.holder, holder)));
}

/**
 * Load the persisted cursor for a contract, if any.
 */
async function loadCursor(contractId: string): Promise<IndexerCursor | null> {
  const rows = await db
    .select()
    .from(indexerCursors)
    .where(eq(indexerCursors.contractId, contractId))
    .limit(1);

  if (rows.length === 0) return null;
  return {
    contractId: rows[0].contractId,
    lastLedger: rows[0].lastLedger,
    lastPagingToken: rows[0].lastPagingToken ?? null,
  };
}

/**
 * Persist the cursor for a contract.
 */
async function saveCursor(cursor: IndexerCursor): Promise<void> {
  await db
    .insert(indexerCursors)
    .values({
      contractId: cursor.contractId,
      lastLedger: cursor.lastLedger,
      lastPagingToken: cursor.lastPagingToken,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: indexerCursors.contractId,
      set: {
        lastLedger: cursor.lastLedger,
        lastPagingToken: cursor.lastPagingToken,
        updatedAt: new Date(),
      },
    });
}

/**
 * Poll and process events for a single contract.
 */
async function indexContract(
  server: SorobanRpc.Server,
  propertyId: string,
  contractId: string,
): Promise<void> {
  const cursor = await loadCursor(contractId);
  const startLedger = cursor ? cursor.lastLedger + 1 : 1;

  let pagingToken: string | undefined = undefined;
  let highestLedger = cursor?.lastLedger ?? 0;

  // Loop through pages until exhausted.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await server.getEvents({
      startLedger: pagingToken ? undefined : startLedger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: BATCH_LIMIT,
      cursor: pagingToken,
    });

    const events = (response.events ?? []).map(normalizeEvent);
    if (events.length === 0) break;

    await db.transaction(async (tx) => {
      for (const event of events) {
        // Dedupe by event id.
        const existing = await tx
          .select({ id: contractEvents.id })
          .from(contractEvents)
          .where(eq(contractEvents.eventId, event.id))
          .limit(1);

        if (existing.length > 0) {
          continue;
        }

        await tx.insert(contractEvents).values({
          eventId: event.id,
          propertyId,
          contractId: event.contractId || contractId,
          ledger: event.ledger,
          type: event.type,
          topic: event.topic,
          value: event.value as unknown as Record<string, unknown>,
          txHash: event.txHash,
          pagingToken: event.pagingToken,
          createdAt: new Date(),
        });

        await applyHolderBalance(tx, propertyId, event);

        if (event.ledger > highestLedger) {
          highestLedger = event.ledger;
        }
      }
    });

    const lastEvent = events[events.length - 1];
    pagingToken = lastEvent.pagingToken;

    // Persist cursor after each batch so restarts resume without duplication.
    await saveCursor({
      contractId,
      lastLedger: highestLedger,
      lastPagingToken: pagingToken ?? null,
    });

    if (events.length < BATCH_LIMIT) break;
  }
}

/**
 * Run one full indexing pass over all tokenized properties.
 */
export async function runIndexerPass(): Promise<void> {
  const server = getRpcServer();

  const rows = await db
    .select({
      id: properties.id,
      tokenContractId: properties.tokenContractId,
      distributorContractId: properties.distributorContractId,
    })
    .from(properties)
    .where(eq(properties.tokenized, true));

  for (const row of rows) {
    if (stopRequested) break;

    const contracts: string[] = [];
    if (row.tokenContractId) contracts.push(row.tokenContractId);
    if (row.distributorContractId) contracts.push(row.distributorContractId);

    for (const contractId of contracts) {
      if (stopRequested) break;
      try {
        await indexContract(server, row.id, contractId);
      } catch (err) {
        // Log and continue; a single contract failure should not halt the pass.
        console.error(`[eventIndexer] failed to index contract ${contractId}:`, err);
      }
    }
  }
}

/**
 * Start the background event indexer worker.
 */
export function startEventIndexer(): void {
  if (running) return;
  running = true;
  stopRequested = false;

  const tick = async () => {
    if (stopRequested) return;
    try {
      await runIndexerPass();
    } catch (err) {
      console.error('[eventIndexer] pass failed:', err);
    }
    if (!stopRequested) {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  timer = setTimeout(tick, 0);
  console.log('[eventIndexer] started');
}

/**
 * Stop the background event indexer worker.
 */
export async function stopEventIndexer(): Promise<void> {
  stopRequested = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  running = false;
  console.log('[eventIndexer] stopped');
}

export function isEventIndexerRunning(): boolean {
  return running;
}