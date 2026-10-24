import { Elysia, t } from 'elysia';
import { eq, and } from 'drizzle-orm';
import { kycSubmissions, auditLogs } from '../db/schema';
import type { AuditService } from '../services/AuditService';

export type KycStatus = 'pending' | 'approved' | 'rejected';

export interface KycSubmission {
  id: string;
  userId: string;
  status: KycStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KycRepository {
  createSubmission(input: { userId: string }): Promise<KycSubmission>;
  findById(id: string): Promise<KycSubmission | null>;
  listByStatus(status: KycStatus): Promise<KycSubmission[]>;
  reviewSubmission(input: {
    id: string;
    status: 'approved' | 'rejected';
    reviewedBy: string;
    reviewedAt: Date;
    notes: string | null;
  }): Promise<KycSubmission | null>;
}

export interface KycUser {
  id: string;
  role: string;
}

export interface KycRoutesDeps {
  kycRepository: KycRepository;
  auditService: AuditService;
  getCurrentUser: (context: { request: Request }) => Promise<KycUser | null> | KycUser | null;
}

const statusSchema = t.Union([
  t.Literal('pending'),
  t.Literal('approved'),
  t.Literal('rejected'),
]);

const reviewBodySchema = t.Object({
  status: t.Union([t.Literal('approved'), t.Literal('rejected')]),
  notes: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
});

export function kycRoutes(deps: KycRoutesDeps) {
  const { kycRepository, auditService, getCurrentUser } = deps;

  return new Elysia({ prefix: '/kyc' })
    .post(
      '/',
      async ({ request, body, set }) => {
        const user = await getCurrentUser({ request });
        if (!user) {
          set.status = 401;
          return { error: 'Unauthorized' };
        }
        if (user.role !== 'investor') {
          set.status = 403;
          return { error: 'Forbidden' };
        }

        const submission = await kycRepository.createSubmission({ userId: user.id });
        set.status = 201;
        return submission;
      },
      {
        body: t.Optional(t.Object({})),
      },
    )
    .get(
      '/',
      async ({ request, query, set }) => {
        const user = await getCurrentUser({ request });
        if (!user) {
          set.status = 401;
          return { error: 'Unauthorized' };
        }
        if (user.role !== 'operator') {
          set.status = 403;
          return { error: 'Forbidden' };
        }

        const status = (query.status ?? 'pending') as KycStatus;
        if (status !== 'pending' && status !== 'approved' && status !== 'rejected') {
          set.status = 400;
          return { error: 'Invalid status' };
        }

        return kycRepository.listByStatus(status);
      },
      {
        query: t.Object({
          status: t.Optional(statusSchema),
        }),
      },
    )
    .post(
      '/:id/review',
      async ({ request, params, body, set }) => {
        const user = await getCurrentUser({ request });
        if (!user) {
          set.status = 401;
          return { error: 'Unauthorized' };
        }
        if (user.role !== 'operator') {
          set.status = 403;
          return { error: 'Forbidden' };
        }

        const existing = await kycRepository.findById(params.id);
        if (!existing) {
          set.status = 404;
          return { error: 'Submission not found' };
        }

        const reviewedAt = new Date();
        const notes = body.notes ?? null;

        const updated = await kycRepository.reviewSubmission({
          id: params.id,
          status: body.status,
          reviewedBy: user.id,
          reviewedAt,
          notes,
        });

        if (!updated) {
          set.status = 404;
          return { error: 'Submission not found' };
        }

        await auditService.log({
          actor: user.id,
          action: 'kyc.review',
          entityType: 'kyc_submission',
          entityId: updated.id,
          before: existing,
          after: updated,
        });

        return updated;
      },
      {
        params: t.Object({
          id: t.String({ minLength: 1 }),
        }),
        body: reviewBodySchema,
      },
    );
}

export default kycRoutes;