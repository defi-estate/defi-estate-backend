import { t } from 'elysia';

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Reusable Elysia schema for the error branch of the `ApiResponse<T>` envelope.
 */
export const apiErrorSchema = t.Object({
  success: t.Literal(false),
  error: t.Object({
    code: t.String(),
    message: t.String(),
    details: t.Optional(t.Unknown()),
  }),
});

/**
 * Build an Elysia schema for the success branch of the `ApiResponse<T>` envelope.
 */
export const apiSuccessSchema = <T extends ReturnType<typeof t.Object> | ReturnType<typeof t.Array>>(
  dataSchema: T,
) =>
  t.Object({
    success: t.Literal(true),
    data: dataSchema,
  });

/**
 * Build an Elysia schema for the full `ApiResponse<T>` envelope (success or error).
 */
export const apiResponseSchema = <
  T extends ReturnType<typeof t.Object> | ReturnType<typeof t.Array>,
>(
  dataSchema: T,
) =>
  t.Union([apiSuccessSchema(dataSchema), apiErrorSchema]);

/**
 * Schema for a single property resource.
 */
export const propertySchema = t.Object({
  id: t.String(),
  title: t.String(),
  description: t.String(),
  price: t.Number(),
  location: t.String(),
  createdAt: t.String(),
  updatedAt: t.String(),
});

/**
 * Schema for a paginated list of properties.
 */
export const paginatedPropertySchema = t.Object({
  items: t.Array(propertySchema),
  page: t.Number(),
  pageSize: t.Number(),
  total: t.Number(),
});

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  page?: number;
  pageSize?: number;
}
