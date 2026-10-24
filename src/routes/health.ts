import { Elysia, t } from 'elysia';
import { sql } from 'drizzle-orm';
import { db } from '../db';

const errorEnvelope = t.Object({
  success: t.Literal(false),
  error: t.Object({
    code: t.String(),
    message: t.String(),
  }),
});

const healthResponse = t.Object({
  success: t.Literal(true),
  data: t.Object({
    status: t.Literal('ok'),
    timestamp: t.String(),
  }),
});

const readyResponse = t.Object({
  success: t.Literal(true),
  data: t.Object({
    status: t.Literal('ready'),
    database: t.Union([t.Literal('ok'), t.Literal('skipped')]),
    timestamp: t.String(),
  }),
});

const unavailableResponse = t.Object({
  success: t.Literal(false),
  error: t.Object({
    code: t.String(),
    message: t.String(),
  }),
  data: t.Object({
    status: t.Literal('unavailable'),
    database: t.Literal('error'),
    timestamp: t.String(),
  }),
});

export const healthRoutes = new Elysia()
  .get(
    '/health',
    () => ({
      success: true as const,
      data: { status: 'ok' as const, timestamp: new Date().toISOString() },
    }),
    {
      detail: { tags: ['Health'], summary: 'Liveness check' },
      response: {
        200: healthResponse,
        400: errorEnvelope,
        404: errorEnvelope,
      },
    },
  )
  .get(
    '/ready',
    async ({ set }) => {
      const timestamp = new Date().toISOString();

      if (!process.env.DATABASE_URL) {
        return {
          success: true as const,
          data: {
            status: 'ready' as const,
            database: 'skipped' as const,
            timestamp,
          },
        };
      }

      try {
        await db.execute(sql`SELECT 1`);
        return {
          success: true as const,
          data: {
            status: 'ready' as const,
            database: 'ok' as const,
            timestamp,
          },
        };
      } catch (error) {
        set.status = 503;
        return {
          success: false as const,
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: error instanceof Error ? error.message : 'Database unreachable',
          },
          data: {
            status: 'unavailable' as const,
            database: 'error' as const,
            timestamp,
          },
        };
      }
    },
    {
      detail: { tags: ['Health'], summary: 'Readiness check' },
      response: {
        200: readyResponse,
        400: errorEnvelope,
        404: errorEnvelope,
        503: unavailableResponse,
      },
    },
  );