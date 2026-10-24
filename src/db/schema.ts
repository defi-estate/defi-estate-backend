import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { PROPERTY_STATUSES, PROPERTY_TYPES } from '../shared';

export const propertyStatus = pgEnum('property_status', PROPERTY_STATUSES);
export const propertyType = pgEnum('property_type', PROPERTY_TYPES);

export const userRole = pgEnum('user_role', ['investor', 'operator']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicKey: text('public_key').notNull().unique(),
  role: userRole('role').notNull().default('investor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const KYC_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const kycStatus = pgEnum('kyc_status', KYC_STATUSES);

export const properties = pgTable('properties', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  type: propertyType('type').notNull(),
  status: propertyStatus('status').notNull().default('draft'),
  location: jsonb('location').$type<{ address: string; city: string; country: string }>().notNull(),
  valuationUsdCents: integer('valuation_usd_cents').notNull(),
  totalShares: integer('total_shares').notNull(),
  sharePriceUsdCents: integer('share_price_usd_cents').notNull(),
  expectedYieldBps: integer('expected_yield_bps').notNull(),
  tokenContractId: text('token_contract_id'),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const kycSubmissions = pgTable('kyc_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  status: kycStatus('status').notNull().default('pending'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  before: jsonb('before').$type<Record<string, unknown> | null>(),
  after: jsonb('after').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PropertyRow = typeof properties.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type KycSubmissionRow = typeof kycSubmissions.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AuditEntryRow = typeof auditLog.$inferSelect;
export type NewAuditEntryRow = typeof auditLog.$inferInsert;

export const DISTRIBUTION_STATUSES = ['pending', 'submitted', 'completed', 'failed'] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];

export const distributionStatus = pgEnum('distribution_status', DISTRIBUTION_STATUSES);

export const distributions = pgTable('distributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id')
    .notNull()
    .references(() => properties.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),
  grossAmount: text('gross_amount').notNull(),
  snapshotLedger: integer('snapshot_ledger').notNull(),
  allocations: jsonb('allocations').$type<Record<string, string>>().notNull(),
  txHashes: jsonb('tx_hashes').$type<string[]>().notNull().default([]),
  status: distributionStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DistributionRow = typeof distributions.$inferSelect;
export type NewDistributionRow = typeof distributions.$inferInsert;

export const TRANSACTION_STATUSES = ['pending', 'submitted', 'confirmed', 'failed'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const transactionStatus = pgEnum('transaction_status', TRANSACTION_STATUSES);

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  distributionId: uuid('distribution_id').references(() => distributions.id, { onDelete: 'cascade' }),
  propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
  txHash: text('tx_hash'),
  status: transactionStatus('status').notNull().default('pending'),
  batchIndex: integer('batch_index'),
  holderCount: integer('holder_count'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;
