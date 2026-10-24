import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { rateLimit } from './middleware/rateLimit';
import { healthRoutes } from './routes/health';
import { propertyRoutes } from './routes/properties';
import { distributionRoutes } from './routes/distributions';
import { kycRoutes } from './routes/kyc';
import { auditRoutes } from './routes/audit';
import { authPlugin } from './middleware/auth';
import type { PropertyRepository } from './repositories/PropertyRepository';
import type { KycRepository } from './repositories/KycRepository';
import type { StellarService } from './services/StellarService';
import type { DistributionService } from './services/DistributionService';
import type { AuditService } from './services/AuditService';

export interface AppDeps {
  properties: PropertyRepository;
  kyc: KycRepository;
  corsOrigins: string[];
  stellar?: StellarService;
  distributions?: DistributionService;
  audit?: AuditService;
  rateLimitPerMinute?: number;
}

/** Base app without swagger, so tests can import it cheaply. */
export function createApp({
  properties,
  kyc,
  corsOrigins,
  stellar,
  distributions,
  audit,
  rateLimitPerMinute,
}: AppDeps) {
  let app = new Elysia()
    .use(cors({ origin: corsOrigins }))
    .use(requestLogger)
    .use(rateLimit({ limitPerMinute: rateLimitPerMinute }))
    .use(errorHandler)
    .use(authPlugin)
    .use(healthRoutes)
    .use(propertyRoutes(properties, stellar))
    .use(kycRoutes({ kyc }));

  if (distributions) {
    app = app.use(distributionRoutes(distributions));
  }

  if (audit) {
    app = app.use(auditRoutes({ audit }));
  }

  return app;
}