import { beforeEach, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import type { KycSubmission, Paginated, Property } from '../src/shared';
import { createApp } from '../src/app';
import { InMemoryPropertyRepository } from '../src/repositories/PropertyRepository';
import { InMemoryAuthRepository } from '../src/repositories/AuthRepository';
import type { StellarService } from '../src/services/StellarService';
import type { DistributionService } from '../src/services/DistributionService';
import { InMemoryKycRepository } from '../src/repositories/KycRepository';
import { InMemoryAuditService } from '../src/services/AuditService';

const payload = {
  name: 'Lekki Garden Apartments',
  type: 'residential',
  location: { address: '12 Admiralty Way', city: 'Lagos', country: 'NG' },
  valuationUsdCents: 50_000_000,
  totalShares: 10_000,
  expectedYieldBps: 750,
};

type Envelope = {
  status?: string;
  data: Property & Paginated<Property>;
  error: { code: string };
};

type AuthEnvelope = {
  data: { challenge?: string; nonce?: string; token?: string };
  error: { code: string };
};

const read = (res: Response) => res.json() as Promise<Envelope>;
const readAuth = (res: Response) => res.json() as Promise<AuthEnvelope>;

function json(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signIn(app: ReturnType<typeof createApp>, keypair: Keypair): Promise<string> {
  const challengeRes = await app.handle(
    json('POST', '/auth/challenge', { publicKey: keypair.publicKey() }),
  );
  const challenge = (await readAuth(challengeRes)).data;
  const signature = keypair.sign(Buffer.from(challenge.challenge ?? challenge.nonce ?? '')).toString('base64');
  const verifyRes = await app.handle(
    json('POST', '/auth/verify', {
      publicKey: keypair.publicKey(),
      nonce: challenge.nonce,
      signature,
    }),
  );
  return (await readAuth(verifyRes)).data.token as string;
}

function fakeStellar() {
  const calls: { method: string; args: unknown[] }[] = [];
  const service = {
    setWhitelisted: async (...args: unknown[]) => {
      calls.push({ method: 'setWhitelisted', args });
      return { hash: 'whitelist-hash', status: 'SUCCESS' };
    },
    mint: async (...args: unknown[]) => {
      calls.push({ method: 'mint', args });
      return { hash: 'mint-hash', status: 'SUCCESS' };
    },
    distribute: async (...args: unknown[]) => {
      calls.push({ method: 'distribute', args });
      return { hash: 'distribute-hash', status: 'SUCCESS' };
    },
  } as unknown as StellarService;
  return { service, calls };
}

function fakeDistributions() {
  const calls: unknown[][] = [];
  const service = {
    createDistribution: async (...args: unknown[]) => {
      calls.push(args);
      return { id: 'dist-1', batches: [{ hash: 'distribute-hash', status: 'SUCCESS' }] };
    },
  } as unknown as DistributionService;
  return { service, calls };
}

describe('properties API', () => {
  let app: ReturnType<typeof createApp>;
  let operator: Keypair;
  let investor: Keypair;
  let operatorToken: string;
  let investorToken: string;

  beforeEach(async () => {
    operator = Keypair.random();
    investor = Keypair.random();
    const auth = new InMemoryAuthRepository();
    auth.seedUser({ publicKey: operator.publicKey(), role: 'operator' });
    auth.seedUser({ publicKey: investor.publicKey(), role: 'investor' });
    app = createApp({
      properties: new InMemoryPropertyRepository(),
      auth,
      corsOrigins: ['*'],
      jwtSecret: 'test-secret',
    });
    operatorToken = await signIn(app, operator);
    investorToken = await signIn(app, investor);
  });

  it('reports health', async () => {
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect((await read(res)).status).toBe('ok');
  });

  it('creates a property and derives the share price', async () => {
    const res = await app.handle(json('POST', '/properties', payload, operatorToken));
    expect(res.status).toBe(201);
    const { data } = await read(res);
    expect(data.status).toBe('draft');
    expect(data.sharePriceUsdCents).toBe(5_000);
  });

  it('rejects an invalid property', async () => {
    const res = await app.handle(
      json('POST', '/properties', { ...payload, totalShares: -1 }, operatorToken),
    );
    expect(res.status).toBe(400);
    expect((await read(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('lists, fetches and updates properties', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;

    const list = await read(await app.handle(json('GET', '/properties?pageSize=5')));
    expect(list.data.total).toBe(1);
    expect(list.data.pageSize).toBe(5);

    const updated = await app.handle(
      json(
        'PATCH',
        `/properties/${created.id}`,
        { totalShares: 20_000, status: 'pending_review' },
        operatorToken,
      ),
    );
    const { data } = await read(updated);
    expect(data.sharePriceUsdCents).toBe(2_500);
    expect(data.status).toBe('pending_review');
  });

  it('rejects anonymous writes', async () => {
    const create = await app.handle(json('POST', '/properties', payload));
    expect(create.status).toBe(401);

    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;
    const patch = await app.handle(
      json('PATCH', `/properties/${created.id}`, { totalShares: 20_000 }),
    );
    expect(patch.status).toBe(401);
  });

  it('forbids investor writes', async () => {
    const create = await app.handle(json('POST', '/properties', payload, investorToken));
    expect(create.status).toBe(403);

    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;
    const patch = await app.handle(
      json('PATCH', `/properties/${created.id}`, { totalShares: 20_000 }, investorToken),
    );
    expect(patch.status).toBe(403);
  });

  it('allows operator writes', async () => {
    const create = await app.handle(json('POST', '/properties', payload, operatorToken));
    expect(create.status).toBe(201);
    const created = (await read(create)).data;

    const patch = await app.handle(
      json('PATCH', `/properties/${created.id}`, { totalShares: 20_000 }, operatorToken),
    );
    expect(patch.status).toBe(200);
  });

  it('allows every valid status transition', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;

    const draftToReview = await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'pending_review' }, operatorToken),
    );
    expect(draftToReview.status).toBe(200);

    const reviewToDraft = await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'draft' }, operatorToken),
    );
    expect(reviewToDraft.status).toBe(200);

    await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'pending_review' }, operatorToken),
    );
    const reviewToTokenized = await app.handle(
      json(
        'PATCH',
        `/properties/${created.id}`,
        { status: 'tokenized', tokenContractId: 'CABC123' },
        operatorToken,
      ),
    );
    expect(reviewToTokenized.status).toBe(200);

    const tokenizedToArchived = await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'archived' }, operatorToken),
    );
    expect(tokenizedToArchived.status).toBe(200);
  });

  it('rejects forbidden status transitions', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;

    const draftToTokenized = await app.handle(
      json(
        'PATCH',
        `/properties/${created.id}`,
        { status: 'tokenized', tokenContractId: 'CABC123' },
        operatorToken,
      ),
    );
    expect(draftToTokenized.status).toBe(409);
    expect((await read(draftToTokenized)).error.code).toBe('INVALID_STATUS_TRANSITION');

    const draftToArchived = await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'archived' }, operatorToken),
    );
    expect(draftToArchived.status).toBe(409);

    await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'pending_review' }, operatorToken),
    );
    const reviewToArchived = await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'archived' }, operatorToken),
    );
    expect(reviewToArchived.status).toBe(409);
  });

  it('requires a token contract when tokenizing', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;
    await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'pending_review' }, operatorToken),
    );

    const res = await app.handle(
      json('PATCH', `/properties/${created.id}`, { status: 'tokenized' }, operatorToken),
    );
    expect(res.status).toBe(400);
    expect((await read(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('filters the property list', async () => {
    await app.handle(
      json(
        'POST',
        '/properties',
        { ...payload, name: 'Lagos One', location: { address: 'A', city: 'Lagos', country: 'NG' } },
        operatorToken,
      ),
    );
    await app.handle(
      json(
        'POST',
        '/properties',
        {
          ...payload,
          name: 'Nairobi Two',
          type: 'commercial',
          expectedYieldBps: 900,
          location: { address: 'B', city: 'Nairobi', country: 'KE' },
        },
        operatorToken,
      ),
    );

    const byCity = await read(await app.handle(json('GET', '/properties?city=Lagos')));
    expect(byCity.data.total).toBe(1);

    const byCountry = await read(await app.handle(json('GET', '/properties?country=KE')));
    expect(byCountry.data.total).toBe(1);

    const byType = await read(await app.handle(json('GET', '/properties?type=commercial')));
    expect(byType.data.total).toBe(1);

    const byStatus = await read(await app.handle(json('GET', '/properties?status=draft')));
    expect(byStatus.data.total).toBe(2);

    const byYield = await read(await app.handle(json('GET', '/properties?minYieldBps=800')));
    expect(byYield.data.total).toBe(1);

    const combined = await read(
      await app.handle(json('GET', '/properties?city=Lagos&type=residential')),
    );
    expect(combined.data.total).toBe(1);
  });

  it('sorts the property list', async () => {
    await app.handle(
      json('POST', '/properties', { ...payload, expectedYieldBps: 500 }, operatorToken),
    );
    await app.handle(
      json('POST', '/properties', { ...payload, expectedYieldBps: 900 }, operatorToken),
    );

    const byYield = await read(await app.handle(json('GET', '/properties?sort=yield_desc')));
    expect(byYield.data.items[0]?.expectedYieldBps).toBe(900);

    const newest = await read(await app.handle(json('GET', '/properties?sort=newest')));
    expect(newest.data.items).toHaveLength(2);
  });

  it('rejects invalid query values', async () => {
    const res = await app.handle(json('GET', '/properties?sort=bogus'));
    expect(res.status).toBe(400);
    expect((await read(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown property', async () => {
    const res = await app.handle(json('GET', `/properties/${crypto.randomUUID()}`));
    expect(res.status).toBe(404);
    expect((await read(res)).error.code).toBe('PROPERTY_NOT_FOUND');
  });
});

describe('audit API', () => {
  let app: ReturnType<typeof createApp>;
  let operator: Keypair;
  let investor: Keypair;
  let operatorToken: string;
  let investorToken: string;

  type AuditEntry = {
    id: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before: unknown;
    after: unknown;
    createdAt: string;
  };

  type AuditEnvelope = {
    status?: string;
    data: AuditEntry & Paginated<AuditEntry>;
    error: { code: string };
  };

  const readAudit = (res: Response) => res.json() as Promise<AuditEnvelope>;

  beforeEach(async () => {
    operator = Keypair.random();
    investor = Keypair.random();
    const auth = new InMemoryAuthRepository();
    auth.seedUser({ publicKey: operator.publicKey(), role: 'operator' });
    auth.seedUser({ publicKey: investor.publicKey(), role: 'investor' });
    app = createApp({
      properties: new InMemoryPropertyRepository(),
      auth,
      audit: new InMemoryAuditService(),
      corsOrigins: ['*'],
      jwtSecret: 'test-secret',
    });
    operatorToken = await signIn(app, operator);
    investorToken = await signIn(app, investor);
  });

  it('records an entry for each property update', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;

    const patch = await app.handle(
      json('PATCH', `/properties/${created.id}`, { totalShares: 20_000 }, operatorToken),
    );
    expect(patch.status).toBe(200);

    const res = await app.handle(
      json(
        'GET',
        `/audit?entityType=property&entityId=${created.id}`,
        undefined,
        operatorToken,
      ),
    );
    expect(res.status).toBe(200);
    const { data } = await readAudit(res);
    expect(data.total).toBe(1);
    expect(data.items).toHaveLength(1);
    const entry = data.items[0] as AuditEntry;
    expect(entry.action).toBe('property.update');
    expect(entry.entityType).toBe('property');
    expect(entry.entityId).toBe(created.id);
    expect(entry.actor).toBe(operator.publicKey());
    expect((entry.before as Property).totalShares).toBe(payload.totalShares);
    expect((entry.after as Property).totalShares).toBe(20_000);
  });

  it('enforces access control on the audit log', async () => {
    const anonymous = await app.handle(json('GET', '/audit'));
    expect(anonymous.status).toBe(401);

    const forbidden = await app.handle(json('GET', '/audit', undefined, investorToken));
    expect(forbidden.status).toBe(403);
  });

  it('does not allow audit rows to be mutated through the API', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;
    await app.handle(
      json('PATCH', `/properties/${created.id}`, { totalShares: 20_000 }, operatorToken),
    );
    const entry = (
      await readAudit(
        await app.handle(
          json(
            'GET',
            `/audit?entityType=property&entityId=${created.id}`,
            undefined,
            operatorToken,
          ),
        ),
      )
    ).data.items[0] as AuditEntry;

    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const collection = await app.handle(json(method, '/audit', {}, operatorToken));
      expect([404, 405]).toContain(collection.status);

      const single = await app.handle(json(method, `/audit/${entry.id}`, {}, operatorToken));
      expect([404, 405]).toContain(single.status);
    }

    const after = await readAudit(
      await app.handle(
        json(
          'GET',
          `/audit?entityType=property&entityId=${created.id}`,
          undefined,
          operatorToken,
        ),
      ),
    );
    expect(after.data.total).toBe(1);
    expect((after.data.items[0] as AuditEntry).action).toBe('property.update');
  });

  it('returns pagination fields', async () => {
    const created = (
      await read(await app.handle(json('POST', '/properties', payload, operatorToken)))
    ).data;
    await app.handle(
      json('PATCH', `/properties/${created.id}`, { totalShares: 20_000 }, operatorToken),
    );
    await app.handle(
      json('PATCH', `/properties/${created.id}`, { expectedYieldBps: 800 }, operatorToken),
    );

    const res = await app.handle(
      json('GET', '/audit?page=1&pageSize=1', undefined, operatorToken),
    );
    expect(res.status).toBe(200);
    const { data } = await readAudit(res);
    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(1);
    expect(data.total).toBe(2);
    expect(data.items).toHaveLength(1);
  });
});

describe('auth API', () => {
  let app: ReturnType<typeof createApp>;
  let auth: InMemoryAuthRepository;

  beforeEach(() => {
    auth = new InMemoryAuthRepository();
    app = createApp({
      properties: new InMemoryPropertyRepository(),
      auth,
      corsOrigins: ['*'],
      jwtSecret: 'test-secret',
    });
  });

  it('issues a challenge for a public key', async () => {
    const keypair = Keypair.random();
    const res = await app.handle(json('POST', '/auth/challenge', { publicKey: keypair.publicKey() }));
    expect(res.status).toBe(200);
    const { data } = await readAuth(res);
    expect(data.challenge ?? data.nonce).toBeTruthy();
  });

  it('verifies a valid signature', async () => {
    const keypair = Keypair.random();
    const challenge = (
      await readAuth(
        await app.handle(json('POST', '/auth/challenge', { publicKey: keypair.publicKey() })),
      )
    ).data;
    const signature = keypair
      .sign(Buffer.from(challenge.challenge ?? challenge.nonce ?? ''))
      .toString('base64');

    const res = await app.handle(
      json('POST', '/auth/verify', {
        publicKey: keypair.publicKey(),
        nonce: challenge.nonce,
        signature,
      }),
    );
    expect(res.status).toBe(200);
    expect((await readAuth(res)).data.token).toBeTruthy();
  });

  it('rejects a wrong signature', async () => {
    const keypair = Keypair.random();
    const other = Keypair.random();
    const challenge = (
      await readAuth(
        await app.handle(json('POST', '/auth/challenge', { publicKey: keypair.publicKey() })),
      )
    ).data;
    const signature = other
      .sign(Buffer.from(challenge.challenge ?? challenge.nonce ?? ''))
      .toString('base64');

    const res = await app.handle(
      json('POST', '/auth/verify', {
        publicKey: keypair.publicKey(),
        nonce: challenge.nonce,
        signature,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects an expired challenge', async () => {
    const keypair = Keypair.random();
    const challenge = (
      await readAuth(
        await app.handle(json('POST', '/auth/challenge', { publicKey: keypair.publicKey() })),
      )
    ).data;
    const signature = keypair
      .sign(Buffer.from(challenge.challenge ?? challenge.nonce ?? ''))
      .toString('base64');

    auth.expireChallenges();

    const res = await app.handle(
      json('POST', '/auth/verify', {
        publicKey: keypair.publicKey(),
        nonce: challenge.nonce,
        signature,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a reused nonce', async () => {
    const keypair = Keypair.random();
    const challenge = (
      await readAuth(
        await app.handle(json('POST', '/auth/challenge', { publicKey: keypair.publicKey() })),
      )
    ).data;
    const signature = keypair
      .sign(Buffer.from(challenge.challenge ?? challenge.nonce ?? ''))
      .toString('base64');

    const body = {
      publicKey: keypair.publicKey(),
      nonce: challenge.nonce,
      signature,
    };
    const first = await app.handle(json('POST', '/auth/verify', body));
    expect(first.status).toBe(200);

    const second = await app.handle(json('POST', '/auth/verify', body));
    expect(second.status).toBe(401);
  });
});

describe('request logging and rate limiting', () => {
  it('sets an x-request-id header when none is provided', async () => {
    const app = createApp({ properties: new InMemoryPropertyRepository(), corsOrigins: ['*'] });
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('reuses an incoming x-request-id', async () => {
    const app = createApp({ properties: new InMemoryPropertyRepository(), corsOrigins: ['*'] });
    const res = await app.handle(
      new Request('http://localhost/health', { headers: { 'x-request-id': 'abc-123' } }),
    );
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });

  it('returns 429 with the standard error envelope once the limit is exceeded', async () => {
    const app = createApp({
      properties: new InMemoryPropertyRepository(),
      corsOrigins: ['*'],
      rateLimitPerMinute: 2,
    });
    const first = await app.handle(json('GET', '/properties'));
    const second = await app.handle(json('GET', '/properties'));
    const third = await app.handle(json('GET', '/properties'));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    const body = await read(third);
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('leaves /health out of rate limiting', async () => {
    const app = createApp({
      properties: new InMemoryPropertyRepository(),
      corsOrigins: ['*'],
      rateLimitPerMinute: 1,
    });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.handle(new Request('http://localhost/health'));
      expect(res.status).toBe(200);
    }
  });
});

describe('whitelist and mint routes', () => {
  let app: ReturnType<typeof createApp>;
  let stellar: ReturnType<typeof fakeStellar>;
  let propertyId: string;

  beforeEach(async () => {
    stellar = fakeStellar();
    app = createApp({
      properties: new InMemoryPropertyRepository(),
      corsOrigins: ['*'],
      stellar: stellar.service,
    });
    const created = await read(await app.handle(json('POST', '/properties', payload)));
    propertyId = created.data.id;
  });

  it('whitelists an approved investor and stores the transaction hash', async () => {
    const res = await app.handle(
      json('POST', `/properties/${propertyId}/whitelist`, {
        address: 'GABC',
        kycStatus: 'approved',
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await read(res);
    expect(data.txHash).toBe('whitelist-hash');
    expect(stellar.calls[0]?.method).toBe('setWhitelisted');
  });

  it('rejects whitelisting an investor whose KYC is not approved', async () => {
    const res = await app.handle(
      json('POST', `/properties/${propertyId}/whitelist`, {
        address: 'GABC',
        kycStatus: 'pending',
      }),
    );
    expect(res.status).toBe(403);
    expect((await read(res)).error.code).toBe('KYC_NOT_APPROVED');
    expect(stellar.calls).toHaveLength(0);
  });

  it('mints shares and stores the transaction hash', async () => {
    const res = await app.handle(
      json('POST', `/properties/${propertyId}/mint`, { address: 'GABC', amount: 100 }),
    );
    expect(res.status).toBe(200);
    const { data } = await read(res);
    expect(data.txHash).toBe('mint-hash');
    expect(stellar.calls[0]?.method).toBe('mint');
  });
});

describe('distributions route', () => {
  it('submits a distribution and returns the batch results', async () => {
    const distributions = fakeDistributions();
    const app = createApp({
      properties: new InMemoryPropertyRepository(),
      corsOrigins: ['*'],
      distributions: distributions.service,
    });
    const created = await read(await app.handle(json('POST', '/properties', payload)));
    const res = await app.handle(
      json('POST', `/properties/${created.data.id}/distributions`, {
        period: '2024-01',
        grossAmount: 1_000_000,
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await read(res);
    expect(data.id).toBe('dist-1');
    expect(distributions.calls).toHaveLength(1);
  });
});

type KycEnvelope = {
  status?: string;
  data: KycSubmission & Paginated<KycSubmission>;
  error: { code: string };
};

const readKyc = (res: Response) => res.json() as Promise<KycEnvelope>;

function kycRequest(method: string, path: string, role: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-role': role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('kyc API', () => {
  let app: ReturnType<typeof createApp>;
  let kyc: InMemoryKycRepository;

  beforeEach(() => {
    kyc = new InMemoryKycRepository();
    app = createApp({
      properties: new InMemoryPropertyRepository(),
      kyc,
      corsOrigins: ['*'],
    });
  });

  it('lets an investor submit a KYC record that starts pending', async () => {
    const res = await app.handle(
      kycRequest('POST', '/kyc', 'investor', { notes: 'Passport attached' }),
    );
    expect(res.status).toBe(201);
    const { data } = await readKyc(res);
    expect(data.status).toBe('pending');
    expect(data.reviewedBy).toBeNull();
    expect(data.reviewedAt).toBeNull();
  });

  it('lists pending submissions for operators', async () => {
    await app.handle(kycRequest('POST', '/kyc', 'investor', {}));
    const res = await app.handle(kycRequest('GET', '/kyc?status=pending', 'operator'));
    expect(res.status).toBe(200);
    const { data } = await readKyc(res);
    expect(data.total).toBe(1);
    expect(data.items[0]?.status).toBe('pending');
  });

  it('approves a submission and writes an audit log entry', async () => {
    const created = (
      await readKyc(await app.handle(kycRequest('POST', '/kyc', 'investor', {})))
    ).data;

    const res = await app.handle(
      kycRequest('POST', `/kyc/${created.id}/review`, 'operator', { status: 'approved' }),
    );
    expect(res.status).toBe(200);
    const { data } = await readKyc(res);
    expect(data.status).toBe('approved');
    expect(data.reviewedBy).toBeTruthy();
    expect(data.reviewedAt).toBeTruthy();

    const audit = kyc.auditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('kyc.review');
    expect(audit[0]?.entityId).toBe(created.id);
  });

  it('rejects a submission with notes and writes an audit log entry', async () => {
    const created = (
      await readKyc(await app.handle(kycRequest('POST', '/kyc', 'investor', {})))
    ).data;

    const res = await app.handle(
      kycRequest('POST', `/kyc/${created.id}/review`, 'operator', {
        status: 'rejected',
        notes: 'Document expired',
      }),
    );
    expect(res.status).toBe(200);
    const { data } = await readKyc(res);
    expect(data.status).toBe('rejected');
    expect(data.notes).toBe('Document expired');
    expect(kyc.auditLog()).toHaveLength(1);
  });

  it('enforces access control', async () => {
    const created = (
      await readKyc(await app.handle(kycRequest('POST', '/kyc', 'investor', {})))
    ).data;

    const list = await app.handle(kycRequest('GET', '/kyc?status=pending', 'investor'));
    expect(list.status).toBe(403);

    const review = await app.handle(
      kycRequest('POST', `/kyc/${created.id}/review`, 'investor', { status: 'approved' }),
    );
    expect(review.status).toBe(403);

    const submit = await app.handle(kycRequest('POST', '/kyc', 'operator', {}));
    expect(submit.status).toBe(403);
  });

  it('returns 404 when reviewing an unknown submission', async () => {
    const res = await app.handle(
      kycRequest('POST', `/kyc/${crypto.randomUUID()}/review`, 'operator', {
        status: 'approved',
      }),
    );
    expect(res.status).toBe(404);
    expect((await readKyc(res)).error.code).toBe('KYC_NOT_FOUND');
  });
});
