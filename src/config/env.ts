import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  OPERATOR_PUBLIC_KEY: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'OPERATOR_PUBLIC_KEY must be a valid Stellar public key')
    .optional(),
  STELLAR_ADMIN_SECRET: z.string().min(1).optional(),
  STELLAR_RPC_URL: z.string().url().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // S3-compatible storage for property image uploads. All optional so the API
  // still boots without storage configured; uploads fail at request time.
  S3_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

const DEFAULT_RPC_URLS: Record<ApiEnv['STELLAR_NETWORK'], string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban.stellar.org',
};

export function loadEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid API environment:\n${issues.join('\n')}`);
  }
  const data = parsed.data;
  return {
    ...data,
    STELLAR_RPC_URL: data.STELLAR_RPC_URL ?? DEFAULT_RPC_URLS[data.STELLAR_NETWORK],
  };
}
```

.env.example:

```
# API
PORT=3001
DATABASE_URL=postgres://postgres:postgres@localhost:5432/stellar_estate
CORS_ALLOWED_ORIGINS=http://localhost:3000
STELLAR_NETWORK=testnet

# Auth
# Secret used to sign JWT session tokens. Must be at least 32 characters.
JWT_SECRET=change-me-to-a-long-random-secret-value

# Operator seed
# Stellar public key of the first operator account created by the seed script.
OPERATOR_PUBLIC_KEY=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF

# S3-compatible storage (required for property image uploads)
# Bucket where uploaded property images are stored.
S3_BUCKET=stellar-estate-images
# Endpoint of the S3-compatible service (e.g. MinIO, R2, AWS S3).
S3_ENDPOINT=http://localhost:9000
# Region for the storage service (use "auto" for Cloudflare R2).
S3_REGION=us-east-1
# Credentials used to sign upload requests.
S3_ACCESS_KEY_ID=change-me
S3_SECRET_ACCESS_KEY=change-me
