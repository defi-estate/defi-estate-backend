import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { InMemoryPropertyRepository } from '../../src/repositories/InMemoryPropertyRepository';
import { DrizzlePropertyRepository } from '../../src/repositories/DrizzlePropertyRepository';
import { CachedPropertyRepository } from '../../src/repositories/CachedPropertyRepository';
import type { PropertyRepository } from '../../src/repositories/PropertyRepository';
import type { NewProperty } from '../../src/db/schema';

const hasDatabase = Boolean(process.env.DATABASE_URL);

function makeProperty(overrides: Partial<NewProperty> = {}): NewProperty {
  return {
    name: 'Sunset Apartments',
    address: '123 Main St',
    city: 'Springfield',
    ...overrides,
  } as NewProperty;
}

function runRepositoryCases(
  label: string,
  getRepository: () => Promise<PropertyRepository> | PropertyRepository,
) {
  describe(label, () => {
    let repository: PropertyRepository;

    beforeAll(async () => {
      repository = await getRepository();
    });

    it('creates a property and returns it with an id', async () => {
      const created = await repository.create(makeProperty());

      expect(created).toBeDefined();
      expect(created.id).toBeDefined();
      expect(created.name).toBe('Sunset Apartments');
      expect(created.address).toBe('123 Main St');
      expect(created.city).toBe('Springfield');
    });

    it('finds a property by id', async () => {
      const created = await repository.create(makeProperty({ name: 'Find Me' }));

      const found = await repository.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe('Find Me');
    });

    it('returns null when a property does not exist', async () => {
      const found = await repository.findById('00000000-0000-0000-0000-000000000000');

      expect(found).toBeNull();
    });

    it('lists all properties', async () => {
      const before = await repository.findAll();

      await repository.create(makeProperty({ name: 'Listed One' }));
      await repository.create(makeProperty({ name: 'Listed Two' }));

      const after = await repository.findAll();

      expect(after.length).toBe(before.length + 2);
      const names = after.map((property) => property.name);
      expect(names).toContain('Listed One');
      expect(names).toContain('Listed Two');
    });

    it('updates an existing property', async () => {
      const created = await repository.create(makeProperty({ name: 'Old Name' }));

      const updated = await repository.update(created.id, { name: 'New Name' });

      expect(updated).not.toBeNull();
      expect(updated?.id).toBe(created.id);
      expect(updated?.name).toBe('New Name');

      const found = await repository.findById(created.id);
      expect(found?.name).toBe('New Name');
    });

    it('returns null when updating a non-existent property', async () => {
      const updated = await repository.update('00000000-0000-0000-0000-000000000000', {
        name: 'Ghost',
      });

      expect(updated).toBeNull();
    });

    it('deletes an existing property', async () => {
      const created = await repository.create(makeProperty({ name: 'Delete Me' }));

      const deleted = await repository.delete(created.id);

      expect(deleted).toBe(true);

      const found = await repository.findById(created.id);
      expect(found).toBeNull();
    });

    it('returns false when deleting a non-existent property', async () => {
      const deleted = await repository.delete('00000000-0000-0000-0000-000000000000');

      expect(deleted).toBe(false);
    });
  });
}

runRepositoryCases('InMemoryPropertyRepository', () => new InMemoryPropertyRepository());

function createMockCache() {
  const store = new Map<string, string>();

  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteByPrefix: vi.fn(async (prefix: string) => {
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    }),
  };
}

describe('CachedPropertyRepository', () => {
  it('serves the second list read from cache', async () => {
    const inner = new InMemoryPropertyRepository();
    const cache = createMockCache();
    const repository = new CachedPropertyRepository(inner, cache as never);

    await repository.create(makeProperty({ name: 'Cached List' }));

    const findAllSpy = vi.spyOn(inner, 'findAll');
    const first = await repository.findAll();
    const second = await repository.findAll();

    expect(findAllSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(cache.set).toHaveBeenCalled();
  });

  it('serves the second get-by-id read from cache', async () => {
    const inner = new InMemoryPropertyRepository();
    const cache = createMockCache();
    const repository = new CachedPropertyRepository(inner, cache as never);

    const created = await repository.create(makeProperty({ name: 'Cached Get' }));

    const findByIdSpy = vi.spyOn(inner, 'findById');
    const first = await repository.findById(created.id);
    const second = await repository.findById(created.id);

    expect(findByIdSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second?.name).toBe('Cached Get');
  });

  it('invalidates the cache on create', async () => {
    const inner = new InMemoryPropertyRepository();
    const cache = createMockCache();
    const repository = new CachedPropertyRepository(inner, cache as never);

    await repository.findAll();
    expect(cache.store.size).toBeGreaterThan(0);

    await repository.create(makeProperty({ name: 'Invalidate Create' }));

    expect(cache.deleteByPrefix).toHaveBeenCalled();
    expect(cache.store.size).toBe(0);

    const findAllSpy = vi.spyOn(inner, 'findAll');
    const after = await repository.findAll();
    expect(findAllSpy).toHaveBeenCalledTimes(1);
    expect(after.map((property) => property.name)).toContain('Invalidate Create');
  });

  it('invalidates the cache on update', async () => {
    const inner = new InMemoryPropertyRepository();
    const cache = createMockCache();
    const repository = new CachedPropertyRepository(inner, cache as never);

    const created = await repository.create(makeProperty({ name: 'Before Update' }));
    await repository.findById(created.id);
    await repository.findAll();
    expect(cache.store.size).toBeGreaterThan(0);

    await repository.update(created.id, { name: 'After Update' });

    expect(cache.deleteByPrefix).toHaveBeenCalled();
    expect(cache.store.size).toBe(0);

    const found = await repository.findById(created.id);
    expect(found?.name).toBe('After Update');
  });

  it('falls back to the inner repository when no cache is provided', async () => {
    const inner = new InMemoryPropertyRepository();
    const repository = new CachedPropertyRepository(inner, null);

    const created = await repository.create(makeProperty({ name: 'No Cache' }));

    const found = await repository.findById(created.id);
    expect(found?.name).toBe('No Cache');

    const all = await repository.findAll();
    expect(all.map((property) => property.name)).toContain('No Cache');
  });
});

describe.skipIf(!hasDatabase)('DrizzlePropertyRepository (Postgres)', () => {
  let repository: DrizzlePropertyRepository;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const { createDatabase } = await import('../../src/db/client');
    const { db, pool } = createDatabase(process.env.DATABASE_URL as string);
    repository = new DrizzlePropertyRepository(db);
    close = async () => {
      await pool.end();
    };
  });

  afterAll(async () => {
    if (close) {
      await close();
    }
  });

  runRepositoryCases('DrizzlePropertyRepository', () => repository);
});
</｜｜DSML｜｜ parameter>