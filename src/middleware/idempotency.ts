import { Elysia } from 'elysia'
import { createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { idempotencyKeys } from '../db/schema'

const IDEMPOTENCY_HEADER = 'idempotency-key'
const EXPIRY_MS = 24 * 60 * 60 * 1000

export interface IdempotencyDb {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  delete: (...args: any[]) => any
}

export interface StoredIdempotencyResponse {
  status: number
  body: unknown
}

function hashBody(body: unknown): string {
  const serialized =
    typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return createHash('sha256').update(serialized).digest('hex')
}

function getHeader(headers: Record<string, string | undefined>): string | undefined {
  const key = headers[IDEMPOTENCY_HEADER] ?? headers['Idempotency-Key']
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * Deletes idempotency key rows whose expiry is in the past.
 * Intended to be called from a periodic job or a startup interval.
 */
export async function cleanupExpiredIdempotencyKeys(
  db: IdempotencyDb,
  now: Date = new Date()
): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, now))
}

export interface IdempotencyOptions {
  db: IdempotencyDb
  /**
   * Optional override for the current time, useful for testing.
   */
  now?: () => Date
}

/**
 * Elysia plugin that provides Idempotency-Key support for POST requests.
 *
 * - Replays the stored status code and body for an exact retry.
 * - Returns 422 (IDEMPOTENCY_KEY_REUSED) when the same key is reused with a
 *   different request body.
 * - Records the response with a 24-hour expiry after the handler completes.
 */
export function idempotency({ db, now = () => new Date() }: IdempotencyOptions) {
  return new Elysia({ name: 'idempotency' }).onBeforeHandle(
    { as: 'global' },
    async (ctx) => {
      const { request, set, store } = ctx as any

      if (request.method !== 'POST') return

      const key = getHeader(request.headers as Record<string, string | undefined>)
      if (!key) return

      const route = new URL(request.url).pathname
      const bodyHash = hashBody((ctx as any).body)

      const existing = await db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.route, route)
          )
        )
        .limit(1)

      const record = Array.isArray(existing) ? existing[0] : existing

      if (record) {
        const expired =
          record.expiresAt instanceof Date
            ? record.expiresAt.getTime() <= now().getTime()
            : new Date(record.expiresAt).getTime() <= now().getTime()

        if (!expired) {
          if (record.requestHash !== bodyHash) {
            set.status = 422
            return {
              code: 'IDEMPOTENCY_KEY_REUSED',
              message:
                'This Idempotency-Key was already used with a different request body.'
            }
          }

          set.status = record.status ?? 200
          return record.response
        }
      }

      // Mark this request so the after-handle hook can persist the response.
      store.idempotency = { key, route, bodyHash }
    }
  ).onAfterHandle({ as: 'global' }, async (ctx) => {
    const { request, set, store } = ctx as any
    const pending = store?.idempotency as
      | { key: string; route: string; bodyHash: string }
      | undefined

    if (!pending) return

    const status = typeof set.status === 'number' ? set.status : 200
    const response = (ctx as any).response ?? null
    const expiresAt = new Date(now().getTime() + EXPIRY_MS)

    await db.insert(idempotencyKeys).values({
      key: pending.key,
      route: pending.route,
      requestHash: pending.bodyHash,
      status,
      response,
      expiresAt
    })
  })
}

export default idempotency