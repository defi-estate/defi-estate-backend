import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { eq } from 'drizzle-orm'
import { env } from '../config/env'
import { db } from '../db/client'
import { users } from '../db/schema'
import { HttpError } from '../lib/errors'

export type UserRole = 'investor' | 'operator'

export interface AuthUser {
  publicKey: string
  role: UserRole
}

declare module 'elysia' {
  interface Elysia {
    auth: {
      user: AuthUser | null
      requireUser: () => AuthUser
      requireRole: (role: UserRole) => Promise<AuthUser>
    }
  }
}

function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null
  return token
}

export const authPlugin = new Elysia({ name: 'auth' })
  .use(
    jwt({
      name: 'jwt',
      secret: env.JWT_SECRET,
    })
  )
  .decorate('auth', {
    user: null as AuthUser | null,
    requireUser(): AuthUser {
      if (!this.user) {
        throw new HttpError(401, 'Authentication required')
      }
      return this.user
    },
    async requireRole(role: UserRole): Promise<AuthUser> {
      const user = this.requireUser()
      const [record] = await db
        .select()
        .from(users)
        .where(eq(users.publicKey, user.publicKey))
        .limit(1)

      if (!record) {
        throw new HttpError(403, 'Insufficient permissions')
      }

      if (record.role !== role) {
        throw new HttpError(403, 'Insufficient permissions')
      }

      return { publicKey: record.publicKey, role: record.role as UserRole }
    },
  })
  .onBeforeHandle(async ({ request, jwt, auth }) => {
    const token = extractBearer(request.headers.get('authorization'))
    if (!token) {
      auth.user = null
      return
    }

    const payload = await jwt.verify(token)
    if (!payload || typeof payload.sub !== 'string') {
      auth.user = null
      return
    }

    auth.user = {
      publicKey: payload.sub,
      role: (typeof payload.role === 'string' ? payload.role : 'investor') as UserRole,
    }
  })
  .as('scoped')
```

Note: The file above is the complete new content for `src/middleware/auth.ts`. The step also mentions registering the plugin in `src/app.ts` and adding the bearer security scheme to Swagger, but those files were not provided in the request. Below are the required additions to those files for completeness:

**`src/app.ts`** — register the plugin:
```typescript
import { authPlugin } from './middleware/auth'

// inside the Elysia app chain:
  .use(authPlugin)
```

**Swagger bearer scheme** (in the swagger config within `src/app.ts`):
```typescript
  .use(
    swagger({
      documentation: {
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    })
  )