import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { rateLimit } from './middleware/rateLimit';
import { idempotency } from './middleware/idempotency';
import { healthRoutes } from './routes/health';
import { propertyRoutes } from './routes/properties';
import { distributionRoutes } from './routes/distributions';
import { kycRoutes } from './routes/kyc';
import type { PropertyRepository } from './repositories/PropertyRepository';
import type { KycRepository } from './repositories/KycRepository';
import type { StellarService } from './services/StellarService';
import type { DistributionService } from './services/DistributionService';
import type { IdempotencyStore } from './middleware/idempotency';

export interface AppDeps {
  properties: PropertyRepository;
  kyc: KycRepository;
  corsOrigins: string[];
  stellar?: StellarService;
  distributions?: DistributionService;
  rateLimitPerMinute?: number;
  idempotencyStore?: IdempotencyStore;
}

/** Base app without swagger, so tests can import it cheaply. */
export function createApp({
  properties,
  kyc,
  corsOrigins,
  stellar,
  distributions,
  rateLimitPerMinute,
  idempotencyStore,
}: AppDeps) {
  let app = new Elysia()
    .use(cors({ origin: corsOrigins }))
    .use(requestLogger)
    .use(rateLimit({ limitPerMinute: rateLimitPerMinute }))
    .use(idempotency({ store: idempotencyStore }))
    .use(errorHandler)
    .use(healthRoutes)
    .use(propertyRoutes(properties, stellar))
    .use(kycRoutes({ kyc }));

  if (distributions) {
    app = app.use(distributionRoutes(distributions));
  }

  return app;
}