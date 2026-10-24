import { db } from '../db/client';
import type { Paginated } from '../shared/types/api';

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface AuditLogInput {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditLogQuery {
  entityType?: string;
  entityId?: string;
  page: number;
  pageSize: number;
}

export interface AuditService {
  log(input: AuditLogInput): Promise<void>;
  list(query: AuditLogQuery): Promise<Paginated<AuditLogRow>>;
}

export class DbAuditService implements AuditService {
  async log(input: AuditLogInput): Promise<void> {
    await db('audit_log').insert({
      actor: input.actor,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      before: input.before === undefined ? null : JSON.stringify(input.before),
      after: input.after === undefined ? null : JSON.stringify(input.after),
      created_at: new Date(),
    });
  }

  async list(query: AuditLogQuery): Promise<Paginated<AuditLogRow>> {
    const page = Math.max(1, Math.floor(query.page) || 1);
    const pageSize = Math.max(1, Math.floor(query.pageSize) || 20);

    const base = db('audit_log');
    if (query.entityType !== undefined) {
      base.where('entity_type', query.entityType);
    }
    if (query.entityId !== undefined) {
      base.where('entity_id', query.entityId);
    }

    const countRow = await base.clone().count<{ count: string }[]>({ count: '*' });
    const total = Number(countRow[0]?.count ?? 0);

    const rows = await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items: AuditLogRow[] = rows.map((row: any) => ({
      id: String(row.id),
      actor: row.actor,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: parseJson(row.before),
      after: parseJson(row.after),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    }));

    return { items, page, pageSize, total };
  }
}

export class InMemoryAuditService implements AuditService {
  private entries: AuditLogRow[] = [];
  private nextId = 1;

  async log(input: AuditLogInput): Promise<void> {
    this.entries.push({
      id: String(this.nextId++),
      actor: input.actor,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      createdAt: new Date(),
    });
  }

  async list(query: AuditLogQuery): Promise<Paginated<AuditLogRow>> {
    const page = Math.max(1, Math.floor(query.page) || 1);
    const pageSize = Math.max(1, Math.floor(query.pageSize) || 20);

    const filtered = this.entries
      .filter((entry) => query.entityType === undefined || entry.entityType === query.entityType)
      .filter((entry) => query.entityId === undefined || entry.entityId === query.entityId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);

    return { items, page, pageSize, total };
  }

  reset(): void {
    this.entries = [];
    this.nextId = 1;
  }
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export const auditService: AuditService = new DbAuditService();