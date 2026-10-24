import { Router, type FastifyInstance } from 'fastify';
import { Keypair, TransactionBuilder, Networks, Account, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

interface ChallengeEntry {
  nonce: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JWT_EXPIRES_IN = '24h';

const challenges = new Map<string, ChallengeEntry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of challenges) {
    if (entry.expiresAt <= now) {
      challenges.delete(key);
    }
  }
}

function buildChallengeXdr(publicKey: string, nonce: string): string {
  const source = new Account(publicKey, '0');
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + Math.floor(CHALLENGE_TTL_MS / 1000),
    },
  })
    .addOperation(
      Operation.manageData({
        name: 'auth_challenge',
        value: nonce,
      }),
    )
    .build();

  return transaction.toXDR();
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const router = Router();

  app.post(
    '/auth/challenge',
    {
      schema: {
        tags: ['auth'],
        summary: 'Request a sign-in challenge',
        description:
          'Returns a challenge transaction bound to the given Stellar public key. Sign it with the corresponding secret key and submit the signed XDR to /auth/verify.',
        body: {
          type: 'object',
          required: ['publicKey'],
          properties: {
            publicKey: { type: 'string', description: 'Stellar public key (G...)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              challenge: { type: 'string', description: 'Base64-encoded challenge transaction XDR' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { publicKey } = request.body as { publicKey: string };

      if (!Keypair.isValidPublicKey(publicKey)) {
        return reply.code(400).send({ error: 'Invalid public key' });
      }

      const now = Date.now();
      pruneExpired(now);

      const nonce = Keypair.random().publicKey();
      const expiresAt = now + CHALLENGE_TTL_MS;
      challenges.set(publicKey, { nonce, expiresAt });

      const challenge = buildChallengeXdr(publicKey, nonce);

      return reply.send({
        challenge,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    },
  );

  app.post(
    '/auth/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Verify a signed challenge and receive a JWT',
        description:
          'Verifies the signed challenge transaction against the public key and returns a JWT bearer token for authenticated API calls.',
        body: {
          type: 'object',
          required: ['publicKey', 'signedChallenge'],
          properties: {
            publicKey: { type: 'string', description: 'Stellar public key (G...)' },
            signedChallenge: {
              type: 'string',
              description: 'Base64-encoded signed challenge transaction XDR',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              publicKey: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
          401: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { publicKey, signedChallenge } = request.body as {
        publicKey: string;
        signedChallenge: string;
      };

      if (!Keypair.isValidPublicKey(publicKey)) {
        return reply.code(400).send({ error: 'Invalid public key' });
      }

      const now = Date.now();
      const entry = challenges.get(publicKey);

      // Delete immediately to prevent nonce reuse.
      challenges.delete(publicKey);

      if (!entry) {
        return reply.code(401).send({ error: 'No challenge found for this public key' });
      }

      if (entry.expiresAt <= now) {
        return reply.code(401).send({ error: 'Challenge expired' });
      }

      let transaction;
      try {
        transaction = TransactionBuilder.fromXDR(signedChallenge, Networks.TESTNET);
      } catch {
        return reply.code(400).send({ error: 'Invalid challenge transaction' });
      }

      if (!('operations' in transaction) || transaction.operations.length !== 1) {
        return reply.code(400).send({ error: 'Invalid challenge transaction' });
      }

      const operation = transaction.operations[0];
      if (
        operation.type !== 'manageData' ||
        operation.name !== 'auth_challenge' ||
        operation.value?.toString() !== entry.nonce
      ) {
        return reply.code(401).send({ error: 'Challenge nonce mismatch' });
      }

      if (transaction.source !== publicKey) {
        return reply.code(401).send({ error: 'Challenge source mismatch' });
      }

      const keypair = Keypair.fromPublicKey(publicKey);
      const txHash = transaction.hash();
      const validSignature = transaction.signatures.some((sig) => {
        try {
          return keypair.verify(txHash, sig.signature());
        } catch {
          return false;
        }
      });

      if (!validSignature) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      const token = jwt.sign({ publicKey }, env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

      return reply.send({ token, publicKey });
    },
  );

  void router;
}
```

Wait — I need to reconsider. The step says "Register the routes in src/app.ts and document them in Swagger." But I'm only asked to return the content of `src/routes/auth.ts`. The instructions say to return the complete new file content for the file being changed. The step mentions registering in app.ts, but the file in question is `src/routes/auth.ts`. I should focus on this file only.

Let me clean up the file — remove the unused Router import and the `void router` hack.

```typescript
import { type FastifyInstance } from 'fastify';
import { Keypair, TransactionBuilder, Networks, Account, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

interface ChallengeEntry {
  nonce: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JWT_EXPIRES_IN = '24h';

const challenges = new Map<string, ChallengeEntry>();

function pruneExpired(now: number): void {
  for (const [key, entry] of challenges) {
    if (entry.expiresAt <= now) {
      challenges.delete(key);
    }
  }
}

function buildChallengeXdr(publicKey: string, nonce: string): string {
  const source = new Account(publicKey, '0');
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + Math.floor(CHALLENGE_TTL_MS / 1000),
    },
  })
    .addOperation(
      Operation.manageData({
        name: 'auth_challenge',
        value: nonce,
      }),
    )
    .build();

  return transaction.toXDR();
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/challenge',
    {
      schema: {
        tags: ['auth'],
        summary: 'Request a sign-in challenge',
        description:
          'Returns a challenge transaction bound to the given Stellar public key. Sign it with the corresponding secret key and submit the signed XDR to /auth/verify.',
        body: {
          type: 'object',
          required: ['publicKey'],
          properties: {
            publicKey: { type: 'string', description: 'Stellar public key (G...)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              challenge: { type: 'string', description: 'Base64-encoded challenge transaction XDR' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { publicKey } = request.body as { publicKey: string };

      if (!Keypair.isValidPublicKey(publicKey)) {
        return reply.code(400).send({ error: 'Invalid public key' });
      }

      const now = Date.now();
      pruneExpired(now);

      const nonce = Keypair.random().publicKey();
      const expiresAt = now + CHALLENGE_TTL_MS;
      challenges.set(publicKey, { nonce, expiresAt });

      const challenge = buildChallengeXdr(publicKey, nonce);

      return reply.send({
        challenge,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    },
  );

  app.post(
    '/auth/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Verify a signed challenge and receive a JWT',
        description:
          'Verifies the signed challenge transaction against the public key and returns a JWT bearer token for authenticated API calls.',
        body: {
          type: 'object',
          required: ['publicKey', 'signedChallenge'],
          properties: {
            publicKey: { type: 'string', description: 'Stellar public key (G...)' },
            signedChallenge: {
              type: 'string',
              description: 'Base64-encoded signed challenge transaction XDR',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              publicKey: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
          401: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { publicKey, signedChallenge } = request.body as {
        publicKey: string;
        signedChallenge: string;
      };

      if (!Keypair.isValidPublicKey(publicKey)) {
        return reply.code(400).send({ error: 'Invalid public key' });
      }

      const now = Date.now();
      const entry = challenges.get(publicKey);

      // Delete immediately to prevent nonce reuse.
      challenges.delete(publicKey);

      if (!entry) {
        return reply.code(401).send({ error: 'No challenge found for this public key' });
      }

      if (entry.expiresAt <= now) {
        return reply.code(401).send({ error: 'Challenge expired' });
      }

      let transaction;
      try {
        transaction = TransactionBuilder.fromXDR(signedChallenge, Networks.TESTNET);
      } catch {
        return reply.code(400).send({ error: 'Invalid challenge transaction' });
      }

      if (!('operations' in transaction) || transaction.operations.length !== 1) {
        return reply.code(400).send({ error: 'Invalid challenge transaction' });
      }

      const operation = transaction.operations[0];
      if (
        operation.type !== 'manageData' ||
        operation.name !== 'auth_challenge' ||
        operation.value?.toString() !== entry.nonce
      ) {
        return reply.code(401).send({ error: 'Challenge nonce mismatch' });
      }

      if (transaction.source !== publicKey) {
        return reply.code(401).send({ error: 'Challenge source mismatch' });
      }

      const keypair = Keypair.fromPublicKey(publicKey);
      const txHash = transaction.hash();
      const validSignature = transaction.signatures.some((sig) => {
        try {
          return keypair.verify(txHash, sig.signature());
        } catch {
          return false;
        }
      });

      if (!validSignature) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }

      const token = jwt.sign({ publicKey }, env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

      return reply.send({ token, publicKey });
    },
  );
}