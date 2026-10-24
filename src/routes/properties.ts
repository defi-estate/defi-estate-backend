import { Elysia, t } from 'elysia';
import {
  allowedTransitions,
  createPropertySchema,
  propertyQuerySchema,
  updatePropertySchema,
  type ApiSuccess,
  type Paginated,
  type Property,
  type PropertyStatus,
} from '../shared';
import { HttpError } from '../middleware/errorHandler';
import { authPlugin, requireRole } from '../middleware/auth';
import type { PropertyRepository } from '../repositories/PropertyRepository';
import type { KycRepository } from '../repositories/KycRepository';
import type { TransactionRepository } from '../repositories/TransactionRepository';
import type { StellarService } from '../services/StellarService';

const ok = <T>(data: T): ApiSuccess<T> => ({ success: true, data });

function assertValidTransition(current: PropertyStatus, next: PropertyStatus, tokenContractId?: string | null) {
  if (current === next) return;
  if (!allowedTransitions[current]?.includes(next)) {
    throw new HttpError(
      409,
      'INVALID_STATUS_TRANSITION',
      `Cannot transition property status from '${current}' to '${next}'`,
    );
  }
  if (next === 'tokenized' && !tokenContractId) {
    throw new HttpError(
      409,
      'INVALID_STATUS_TRANSITION',
      'tokenContractId is required when moving a property to tokenized',
    );
  }
}

const whitelistBodySchema = t.Object({
  investorId: t.String({ minLength: 1 }),
  walletAddress: t.String({ minLength: 1 }),
});

const mintBodySchema = t.Object({
  investorId: t.String({ minLength: 1 }),
  walletAddress: t.String({ minLength: 1 }),
  amount: t.String({ minLength: 1 }),
});

export interface PropertyRouteDeps {
  repo: PropertyRepository;
  kycRepo: KycRepository;
  txRepo: TransactionRepository;
  stellar: StellarService;
}

export function propertyRoutes({ repo, kycRepo, txRepo, stellar }: PropertyRouteDeps) {
  return new Elysia({ prefix: '/properties', detail: { tags: ['Properties'] } })
    .use(authPlugin)
    .get(
      '/',
      async ({ query }): Promise<ApiSuccess<Paginated<Property>>> =>
        ok(await repo.list(propertyQuerySchema.parse(query))),
      {
        detail: {
          summary: 'List properties',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'city', in: 'query', schema: { type: 'string' } },
            { name: 'country', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'minYield', in: 'query', schema: { type: 'number' } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['yield_desc', 'newest'] } },
          ],
        },
      },
    )
    .get(
      '/:id',
      async ({ params }) => {
        const property = await repo.get(params.id);
        if (!property) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
        return ok(property);
      },
      { detail: { summary: 'Get a property' } },
    )
    .post(
      '/',
      async ({ body, set }) => {
        const property = await repo.create(createPropertySchema.parse(body));
        set.status = 201;
        return ok(property);
      },
      {
        beforeHandle: requireRole('operator'),
        detail: { summary: 'Create a property (draft)' },
      },
    )
    .patch(
      '/:id',
      async ({ params, body }) => {
        const input = updatePropertySchema.parse(body);
        const existing = await repo.get(params.id);
        if (!existing) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
        if (input.status) {
          assertValidTransition(
            existing.status,
            input.status,
            input.tokenContractId ?? existing.tokenContractId,
          );
        }
        const property = await repo.update(params.id, input);
        if (!property) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
        return ok(property);
      },
      {
        beforeHandle: requireRole('operator'),
        detail: { summary: 'Update a property' },
      },
    )
    .post(
      '/:id/whitelist',
      async ({ params, body, set }) => {
        const property = await repo.get(params.id);
        if (!property) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
        if (!property.tokenContractId) {
          throw new HttpError(409, 'PROPERTY_NOT_TOKENIZED', 'Property has no token contract');
        }

        const kyc = await kycRepo.getByInvestor(body.investorId);
        if (!kyc || kyc.status !== 'approved') {
          throw new HttpError(403, 'KYC_NOT_APPROVED', 'Investor KYC is not approved');
        }

        const result = await stellar.setWhitelisted({
          contractId: property.tokenContractId,
          walletAddress: body.walletAddress,
        });

        const record = await txRepo.create({
          propertyId: property.id,
          investorId: body.investorId,
          type: 'whitelist',
          txHash: result.txHash,
          status: result.status,
          result: result.result,
        });

        set.status = 201;
        return ok(record);
      },
      {
        beforeHandle: requireRole('operator'),
        body: whitelistBodySchema,
        detail: { summary: 'Whitelist an investor on the property token (operator only)' },
      },
    )
    .post(
      '/:id/mint',
      async ({ params, body, set }) => {
        const property = await repo.get(params.id);
        if (!property) throw new HttpError(404, 'PROPERTY_NOT_FOUND', 'Property not found');
        if (!property.tokenContractId) {
          throw new HttpError(409, 'PROPERTY_NOT_TOKENIZED', 'Property has no token contract');
        }

        const kyc = await kycRepo.getByInvestor(body.investorId);
        if (!kyc || kyc.status !== 'approved') {
          throw new HttpError(403, 'KYC_NOT_APPROVED', 'Investor KYC is not approved');
        }

        const result = await stellar.mint({
          contractId: property.tokenContractId,
          walletAddress: body.walletAddress,
          amount: body.amount,
        });

        const record = await txRepo.create({
          propertyId: property.id,
          investorId: body.investorId,
          type: 'mint',
          txHash: result.txHash,
          status: result.status,
          result: result.result,
        });

        set.status = 201;
        return ok(record);
      },
      {
        beforeHandle: requireRole('operator'),
        body: mintBodySchema,
        detail: { summary: 'Mint property tokens to an investor (operator only)' },
      },
    );
}
