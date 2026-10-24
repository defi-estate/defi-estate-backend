import Redis from 'ioredis';

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}

class NoopCacheService implements CacheService {
  async get<T>(_key: string): Promise<T | null> {
    return null;
  }

  async set(_key: string, _value: unknown, _ttlSeconds: number): Promise<void> {
    return;
  }

  async deleteByPrefix(_prefix: string): Promise<void> {
    return;
  }
}

class RedisCacheService implements CacheService {
  constructor(private readonly client: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      console.error(`CacheService: failed to get key "${key}"`, error);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      console.error(`CacheService: failed to set key "${key}"`, error);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      console.error(`CacheService: failed to delete keys with prefix "${prefix}"`, error);
    }
  }
}

export function createCacheService(redisUrl?: string): CacheService {
  if (!redisUrl) {
    return new NoopCacheService();
  }
  const client = new Redis(redisUrl);
  client.on('error', (error) => {
    console.error('CacheService: Redis client error', error);
  });
  return new RedisCacheService(client);
}