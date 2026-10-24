import { Property, PropertyRepository } from './PropertyRepository';
import { CacheService } from '../services/CacheService';

const CACHE_PREFIX = 'properties:';
const CACHE_TTL_SECONDS = 60;

export class CachedPropertyRepository implements PropertyRepository {
  constructor(
    private readonly repository: PropertyRepository,
    private readonly cache: CacheService,
  ) {}

  async list(): Promise<Property[]> {
    const key = `${CACHE_PREFIX}list`;
    const cached = await this.cache.get<Property[]>(key);
    if (cached !== null) {
      return cached;
    }

    const properties = await this.repository.list();
    await this.cache.set(key, properties, CACHE_TTL_SECONDS);
    return properties;
  }

  async get(id: string): Promise<Property | null> {
    const key = `${CACHE_PREFIX}${id}`;
    const cached = await this.cache.get<Property>(key);
    if (cached !== null) {
      return cached;
    }

    const property = await this.repository.get(id);
    if (property !== null) {
      await this.cache.set(key, property, CACHE_TTL_SECONDS);
    }
    return property;
  }

  async create(data: Omit<Property, 'id'>): Promise<Property> {
    const property = await this.repository.create(data);
    await this.cache.deleteByPrefix(CACHE_PREFIX);
    return property;
  }

  async update(id: string, data: Partial<Omit<Property, 'id'>>): Promise<Property | null> {
    const property = await this.repository.update(id, data);
    await this.cache.deleteByPrefix(CACHE_PREFIX);
    return property;
  }
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>