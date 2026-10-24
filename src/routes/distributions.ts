import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DistributionService } from '../services/DistributionService';
import { AuditService } from '../services/AuditService';
import { requireOperator } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { NotFoundError } from '../errors';

const router = Router();

const createDistributionSchema = z.object({
  body: z.object({
    grossAmount: z
      .union([z.string(), z.number()])
      .transform((val) => BigInt(val))
      .refine((val) => val > 0n, { message: 'grossAmount must be positive' }),
    snapshotLedger: z
      .union([z.string(), z.number()])
      .transform((val) => Number(val))
      .refine((val) => Number.isInteger(val) && val >= 0, {
        message: 'snapshotLedger must be a non-negative integer',
      }),
    period: z.string().min(1).optional(),
  }),
});

type CreateDistributionBody = z.infer<typeof createDistributionSchema>['body'];

router.post(
  '/properties/:id/distributions',
  requireOperator,
  validate(createDistributionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const propertyId = req.params.id;
      const { grossAmount, snapshotLedger, period } = req.body as CreateDistributionBody;

      const property = await DistributionService.getProperty(propertyId);
      if (!property) {
        throw new NotFoundError(`Property ${propertyId} not found`);
      }

      const distribution = await DistributionService.computeAndSubmit({
        propertyId,
        grossAmount,
        snapshotLedger,
        period,
      });

      await AuditService.log({
        actor: req.operator!.address,
        action: 'distribution.create',
        entityType: 'distribution',
        entityId: distribution.id,
        after: distribution,
      });

      res.status(201).json({
        success: true,
        data: distribution,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;