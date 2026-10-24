import { t } from 'elysia';
import { z } from 'zod';
import { PROPERTY_STATUSES, PROPERTY_TYPES } from '../types/property';

const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export const createPropertySchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(5000).default(''),
  type: z.enum(PROPERTY_TYPES),
  location: z.object({
    address: z.string().trim().min(3).max(200),
    city: z.string().trim().min(2).max(100),
    country: z.string().trim().length(2, 'Use an ISO 3166-1 alpha-2 country code'),
  }),
  valuationUsdCents: z.number().int().positive(),
  totalShares: z.number().int().positive().max(1_000_000_000),
  expectedYieldBps: z.number().int().min(0).max(10_000),
  imageUrl: z.string().url().nullable().default(null),
});
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

export const updatePropertySchema = createPropertySchema.partial().extend({
  status: z.enum(PROPERTY_STATUSES).optional(),
  tokenContractId: z.string().regex(STELLAR_CONTRACT_ID, 'Invalid Soroban contract ID').optional(),
});
export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const PROPERTY_SORTS = ['yield_desc', 'newest'] as const;

export const propertyQuerySchema = paginationSchema.extend({
  city: z.string().trim().min(1).max(100).optional(),
  country: z.string().trim().length(2, 'Use an ISO 3166-1 alpha-2 country code').optional(),
  type: z.enum(PROPERTY_TYPES).optional(),
  status: z.enum(PROPERTY_STATUSES).optional(),
  minYield: z.coerce.number().int().min(0).max(10_000).optional(),
  sort: z.enum(PROPERTY_SORTS).optional(),
});
export type PropertyQueryInput = z.infer<typeof propertyQuerySchema>;

/** Share price in USD cents, rounded down so shares never exceed the valuation. */
export function computeSharePriceUsdCents(valuationUsdCents: number, totalShares: number): number {
  if (totalShares <= 0) throw new Error('totalShares must be positive');
  return Math.floor(valuationUsdCents / totalShares);
}

/** Elysia schema for a serialized property, used in route `response` maps. */
export const propertyResponseSchema = t.Object({
  id: t.String(),
  name: t.String(),
  description: t.String(),
  type: t.UnionEnum(PROPERTY_TYPES),
  status: t.UnionEnum(PROPERTY_STATUSES),
  location: t.Object({
    address: t.String(),
    city: t.String(),
    country: t.String(),
  }),
  valuationUsdCents: t.Number(),
  totalShares: t.Number(),
  sharePriceUsdCents: t.Number(),
  expectedYieldBps: t.Number(),
  tokenContractId: t.Union([t.String(), t.Null()]),
  imageUrl: t.Union([t.String(), t.Null()]),
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type PropertyResponse = typeof propertyResponseSchema.static;

/** Elysia schema for a page of properties. */
export const paginatedPropertiesResponseSchema = t.Object({
  items: t.Array(propertyResponseSchema),
  page: t.Number(),
  pageSize: t.Number(),
  total: t.Number(),
  totalPages: t.Number(),
});
export type PaginatedPropertiesResponse = typeof paginatedPropertiesResponseSchema.static;
