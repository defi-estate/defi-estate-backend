import { and, asc, count, desc, eq, gte, type SQL } from 'drizzle-orm';
import {
  allowedTransitions,
  computeSharePriceUsdCents,
  HttpError,
  type CreatePropertyInput,
  type Paginated,
  type Property,
  type PropertyImage,
  type PropertyQueryInput,
  type UpdatePropertyInput,
} from '../shared';
import type { Database } from '../db';
import { properties, propertyImages, type PropertyRow } from '../db/schema';

export interface AddPropertyImageInput {
  storageKey: string;
  url: string;
  contentType: string;
  sizeBytes: number;
}

export interface PropertyRepository {
  list(query: PropertyQueryInput): Promise<Paginated<Property>>;
  get(id: string): Promise<Property | null>;
  create(input: CreatePropertyInput): Promise<Property>;
  update(id: string, input: UpdatePropertyInput): Promise<Property | null>;
  addImage(propertyId: string, input: AddPropertyImageInput): Promise<PropertyImage>;
  listImages(propertyId: string): Promise<PropertyImage[]>;
}

function assertValidTransition(
  current: Pick<Property, 'status' | 'tokenContractId'>,
  input: UpdatePropertyInput,
): void {
  if (input.status === undefined || input.status === current.status) return;
  const allowed = allowedTransitions[current.status] ?? [];
  if (!allowed.includes(input.status)) {
    throw new HttpError(
      409,
      'INVALID_STATUS_TRANSITION',
      `Cannot transition status from '${current.status}' to '${input.status}'`,
    );
  }
  if (input.status === 'tokenized') {
    const tokenContractId = input.tokenContractId ?? current.tokenContractId;
    if (!tokenContractId) {
      throw new HttpError(
        409,
        'INVALID_STATUS_TRANSITION',
        "A tokenContractId is required to transition status to 'tokenized'",
      );
    }
  }
}

function compareBySort(
  sort: PropertyQueryInput['sort'],
): (a: Property, b: Property) => number {
  if (sort === 'yield_desc') {
    return (a, b) => b.expectedYieldBps - a.expectedYieldBps;
  }
  return (a, b) => b.createdAt.localeCompare(a.createdAt);
}

function matchesQuery(property: Property, query: PropertyQueryInput): boolean {
  if (query.city && property.city !== query.city) return false;
  if (query.country && property.country !== query.country) return false;
  if (query.type && property.type !== query.type) return false;
  if (query.status && property.status !== query.status) return false;
  if (query.minYield !== undefined && property.expectedYieldBps < query.minYield) return false;
  return true;
}

function toProperty(row: PropertyRow): Property {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPropertyImage(row: typeof propertyImages.$inferSelect): PropertyImage {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

function withSharePrice<T extends Partial<CreatePropertyInput>>(
  input: T,
  current?: Pick<Property, 'valuationUsdCents' | 'totalShares'>,
) {
  const valuation = input.valuationUsdCents ?? current?.valuationUsdCents;
  const shares = input.totalShares ?? current?.totalShares;
  if (valuation === undefined || shares === undefined) return input;
  return { ...input, sharePriceUsdCents: computeSharePriceUsdCents(valuation, shares) };
}

export class DrizzlePropertyRepository implements PropertyRepository {
  constructor(private readonly db: Database) {}

  async list(query: PropertyQueryInput): Promise<Paginated<Property>> {
    const { page, pageSize, sort } = query;
    const conditions: SQL[] = [];
    if (query.city) conditions.push(eq(properties.city, query.city));
    if (query.country) conditions.push(eq(properties.country, query.country));
    if (query.type) conditions.push(eq(properties.type, query.type));
    if (query.status) conditions.push(eq(properties.status, query.status));
    if (query.minYield !== undefined) {
      conditions.push(gte(properties.expectedYieldBps, query.minYield));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const orderBy =
      sort === 'yield_desc'
        ? [desc(properties.expectedYieldBps), desc(properties.createdAt)]
        : [desc(properties.createdAt)];
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(properties)
        .where(where)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(properties).where(where),
    ]);
    return { items: rows.map(toProperty), page, pageSize, total: totals[0]?.total ?? 0 };
  }

  async get(id: string): Promise<Property | null> {
    const [row] = await this.db.select().from(properties).where(eq(properties.id, id));
    return row ? toProperty(row) : null;
  }

  async create(input: CreatePropertyInput): Promise<Property> {
    const values = withSharePrice(input) as typeof properties.$inferInsert;
    const [row] = await this.db.insert(properties).values(values).returning();
    return toProperty(row!);
  }

  async update(id: string, input: UpdatePropertyInput): Promise<Property | null> {
    const current = await this.get(id);
    if (!current) return null;
    assertValidTransition(current, input);
    const [row] = await this.db
      .update(properties)
      .set({ ...withSharePrice(input, current), updatedAt: new Date() })
      .where(eq(properties.id, id))
      .returning();
    return row ? toProperty(row) : null;
  }

  async addImage(propertyId: string, input: AddPropertyImageInput): Promise<PropertyImage> {
    const [row] = await this.db
      .insert(propertyImages)
      .values({ ...input, propertyId })
      .returning();
    return toPropertyImage(row!);
  }

  async listImages(propertyId: string): Promise<PropertyImage[]> {
    const rows = await this.db
      .select()
      .from(propertyImages)
      .where(eq(propertyImages.propertyId, propertyId))
      .orderBy(asc(propertyImages.createdAt));
    return rows.map(toPropertyImage);
  }
}

/** Used in tests and when DATABASE_URL is unset during local UI work. */
export class InMemoryPropertyRepository implements PropertyRepository {
  private readonly items = new Map<string, Property>();
  private readonly images = new Map<string, PropertyImage[]>();

  async list(query: PropertyQueryInput): Promise<Paginated<Property>> {
    const { page, pageSize, sort } = query;
    const all = [...this.items.values()]
      .filter((property) => matchesQuery(property, query))
      .sort(compareBySort(sort));
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), page, pageSize, total: all.length };
  }

  async get(id: string): Promise<Property | null> {
    return this.items.get(id) ?? null;
  }

  async create(input: CreatePropertyInput): Promise<Property> {
    const now = new Date().toISOString();
    const property: Property = {
      ...input,
      id: crypto.randomUUID(),
      status: 'draft',
      sharePriceUsdCents: computeSharePriceUsdCents(input.valuationUsdCents, input.totalShares),
      tokenContractId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(property.id, property);
    return property;
  }

  async update(id: string, input: UpdatePropertyInput): Promise<Property | null> {
    const current = this.items.get(id);
    if (!current) return null;
    assertValidTransition(current, input);
    const next: Property = {
      ...current,
      ...withSharePrice(input, current),
      location: input.location ?? current.location,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(id, next);
    return next;
  }

  async addImage(propertyId: string, input: AddPropertyImageInput): Promise<PropertyImage> {
    const image: PropertyImage = {
      ...input,
      id: crypto.randomUUID(),
      propertyId,
      createdAt: new Date().toISOString(),
    };
    const existing = this.images.get(propertyId) ?? [];
    this.images.set(propertyId, [...existing, image]);
    return image;
  }

  async listImages(propertyId: string): Promise<PropertyImage[]> {
    return this.images.get(propertyId) ?? [];
  }
}
