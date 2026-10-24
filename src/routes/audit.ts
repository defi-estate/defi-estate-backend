import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import type { AuditService } from '../services/AuditService';
import type { AuditLogRow } from '../db/schema';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AuditRoutesDeps {
  auditService: AuditService;
}

const listQuerySchema = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.string().uuid().optional(),
  page: z
    .preprocess(
      (val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : val),
      z.number().int().min(1),
    )
    .optional()
    .default(1),
  pageSize: z
    .preprocess(
      (val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : val),
      z.number().int().min(1).max(100),
    )
    .optional()
    .default(20),
});

export function auditRoutes(deps: AuditRoutesDeps): Router {
  const { auditService } = deps;
  const router = Router();

  router.get(
    '/',
    requireRole('operator'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = listQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid query parameters',
              details: parsed.error.flatten(),
            },
          });
          return;
        }

        const { entityType, entityId, page, pageSize } = parsed.data;

        const result = await auditService.list({
          entityType,
          entityId,
          page,
          pageSize,
        });

        const data: Paginated<AuditLogRow> = {
          items: result.items,
          page,
          pageSize,
          total: result.total,
          totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
        };

        res.status(200).json({ success: true, data });
      } catch (err) {
        next(err);
      }
    },
  );

  // Audit rows are immutable via the API: no POST/PATCH/PUT/DELETE routes are exposed.

  return router;
}

export default auditRoutes;