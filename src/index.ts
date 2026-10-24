import { swagger } from '@elysiajs/swagger';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createDatabase } from './db';
import {
  DrizzlePropertyRepository,
  InMemoryPropertyRepository,
} from './repositories/PropertyRepository';

const env = loadEnv();

const database = env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : undefined;

const properties = database
  ? new DrizzlePropertyRepository(database)
  : new InMemoryPropertyRepository();

if (!env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set: using the in-memory repository, data will not persist');
}

const server = createApp({
  properties,
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

    if (database) {
      console.info('Closing database client');
      await database.close();
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