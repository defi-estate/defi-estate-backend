# defi-estate-backend

REST API for [defi-estate](https://github.com/defi-estate), a real estate tokenization and rental yield platform on Stellar. Built with Elysia on Bun and Drizzle ORM on PostgreSQL.

## Related repositories

- [defi-estate-frontend](https://github.com/defi-estate/defi-estate-frontend): Next.js webapp that consumes this API
- [defi-estate-contract](https://github.com/defi-estate/defi-estate-contract): Soroban contracts this API administers

## Quick start

Requirements: [Bun](https://bun.sh) 1.3+ and Docker.

```bash
bun install
bun run db:up          # Postgres + Redis
cp .env.example .env
bun run db:push        # create tables from src/db/schema.ts
bun run db:seed        # load demo properties (safe to run twice)
bun run dev            # http://localhost:3001, Swagger at /docs
```

Without `DATABASE_URL` the API uses an in-memory repository, which is enough for frontend work.

## Endpoints

| Method | Path                          | Description                                |
| ------ | ----------------------------- | ------------------------------------------ |
| GET    | `/health`                     | liveness                                   |
| GET    | `/properties?page=&pageSize=` | paginated list                             |
| GET    | `/properties/:id`             | one property                               |
| POST   | `/properties`                 | create a draft property                    |
| PATCH  | `/properties/:id`             | update fields, status or token contract ID |
| POST   | `/properties/:id/images`      | upload property images (multipart, max 5 MB) |

Responses use the `ApiResponse<T>` envelope from `src/shared/types/api.ts`.

## Layout

| Path                | What it is                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| `src/app.ts`        | `createApp(deps)`, the Elysia app without Swagger (used by tests)               |
| `src/index.ts`      | entry point: env, database, Swagger, listen                                     |
| `src/routes/`       | route plugins                                                                   |
| `src/repositories/` | persistence behind an interface (Drizzle and in-memory)                         |
| `src/db/`           | Drizzle schema and client; migrations in `drizzle/`                             |
| `src/shared/`       | domain types, zod schemas, contract-ID registry (mirrored in the frontend repo) |

## Commands

```bash
make check             # same as CI
bun test
bun run db:generate    # write a migration after changing src/db/schema.ts
make fix               # prettier
```

More: [docs/architecture.md](docs/architecture.md).
