import { swagger } from '@elysiajs/swagger';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createDatabase } from './db';
import {
  DrizzlePropertyRepository,
  InMemoryPropertyRepository,
} from './repositories/PropertyRepository';
import { CachedPropertyRepository } from './repositories/CachedPropertyRepository';
import { CacheService } from './services/CacheService';
import { DrizzleHolderBalanceRepository } from './repositories/HolderBalanceRepository';
import { startEventIndexer } from './workers/eventIndexer';
import { startNotificationWorker } from './workers/notificationWorker';

const env = loadEnv();

const db = env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : undefined;

let properties = db ? new DrizzlePropertyRepository(db) : new InMemoryPropertyRepository();

if (!env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set: using the in-memory repository, data will not persist');
}

let cache: CacheService | undefined;
if (env.REDIS_URL) {
  cache = new CacheService(env.REDIS_URL);
  properties = new CachedPropertyRepository(properties, cache);
} else {
  console.warn('REDIS_URL is not set: property reads will not be cached');
}

const holderBalances = db ? new DrizzleHolderBalanceRepository(db) : undefined;

const server = createApp({
  properties,
  holderBalances,
  corsOrigins: env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
})
  .use(
    swagger({
      path: '/docs',
      documentation: {
        info: {
          title: 'defi-estate API',
          version: '0.1.0',
          description: 'Real estate tokenization and rental yield platform on Stellar',
        },
        tags: [
          { name: 'Health', description: 'Service health' },
          { name: 'Properties', description: 'Property listings and tokenization' },
        ],
      },
    }),
  )
  .listen(env.PORT);

if (db && env.SOROBAN_RPC_URL) {
  startEventIndexer({ db, rpcUrl: env.SOROBAN_RPC_URL });
} else {
  console.warn('SOROBAN_RPC_URL or DATABASE_URL is not set: event indexer will not run');
}

if (db && env.EMAIL_PROVIDER_KEY) {
  startNotificationWorker({ db, providerKey: env.EMAIL_PROVIDER_KEY });
} else {
  console.warn('EMAIL_PROVIDER_KEY or DATABASE_URL is not set: notification worker will not run');
}

console.info(`defi-estate API listening on http://localhost:${env.PORT} (docs at /docs)`);

const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.info(`Received ${signal} but shutdown is already in progress, ignoring`);
    return;
  }
  shuttingDown = true;

  console.info(`Received ${signal}: starting graceful shutdown`);

  try {
    console.info('Stopping server: no longer accepting new requests');
    await Promise.race([
      server.stop(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn(
            `In-flight requests did not finish within ${SHUTDOWN_TIMEOUT_MS}ms, forcing shutdown`,
          );
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    console.info('Server stopped');

    if (db) {
      console.info('Closing database client');
      await db.close();
      console.info('Database client closed');
    } else {
      console.info('No database client to close');
    }

    console.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
