import { credentialsSchema } from '@fireweave/contracts';
import { requestSchema } from '../docs.js';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { Prisma, writeAudit, type Database } from '@fireweave/db';
import type { Config } from '../config.js';
import { errorBody } from '../http.js';
import {
  assertPasswordAcceptable,
  hashPassword,
  PasswordRejectedError,
  verifyPassword,
} from '../auth/passwords.js';
import { AuthError, issueSession, revokeSession, rotateSession } from '../auth/sessions.js';
import { readAccessSubjectIgnoringExpiry } from '../auth/tokens.js';

const REFRESH_COOKIE = 'refresh_token';
const REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type AuthDeps = {
  db: Database;
  config: Config;
  denylist: Set<string>;
  dummyPasswordHash: string;
};

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, {
        max: deps.config.authRateLimitMax,
        timeWindow: '1 minute',
        errorResponseBuilder: (_request, context) => {
          const error = new Error('Too many requests') as Error & { statusCode: number };
          error.statusCode = context.statusCode;
          return error;
        },
      });

      scope.post(
        '/signup',
        requestSchema({ tags: ['auth'], body: credentialsSchema }),
        async (request, reply) => {
          const parsed = credentialsSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply
              .code(400)
              .send(errorBody('VALIDATION', 'Invalid request', parsed.error.flatten()));
          }
          try {
            assertPasswordAcceptable(parsed.data.password, deps.denylist);
          } catch (error) {
            if (error instanceof PasswordRejectedError) {
              return reply.code(400).send(errorBody('VALIDATION', error.message));
            }
            throw error;
          }

          const email = parsed.data.email.toLowerCase();
          const passwordHash = await hashPassword(parsed.data.password);
          try {
            const user = await deps.db.user.create({
              data: { email, passwordHash },
            });
            const session = await issueSession(
              deps.db,
              user,
              request.headers['user-agent'],
              deps.config.jwtAccessSecret,
            );
            await writeAudit(deps.db, {
              userId: user.id,
              action: 'user.signed_up',
              entityType: 'user',
              entityId: user.id,
            });
            setRefreshCookie(reply, session.refreshRaw, deps.config);
            return reply.code(201).send(sessionBody(session));
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              return reply.code(409).send(errorBody('CONFLICT', 'Email already registered'));
            }
            throw error;
          }
        },
      );

      scope.post(
        '/login',
        requestSchema({ tags: ['auth'], body: credentialsSchema }),
        async (request, reply) => {
          const parsed = credentialsSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply
              .code(400)
              .send(errorBody('VALIDATION', 'Invalid request', parsed.error.flatten()));
          }
          const email = parsed.data.email.toLowerCase();
          const user = await deps.db.user.findUnique({ where: { email } });
          const ok = await verifyPassword(
            user?.passwordHash ?? deps.dummyPasswordHash,
            parsed.data.password,
          );
          if (!user || !ok) {
            return reply.code(401).send(errorBody('UNAUTHORIZED', 'Invalid email or password'));
          }
          const session = await issueSession(
            deps.db,
            user,
            request.headers['user-agent'],
            deps.config.jwtAccessSecret,
          );
          await writeAudit(deps.db, {
            userId: user.id,
            action: 'user.logged_in',
            entityType: 'user',
            entityId: user.id,
          });
          setRefreshCookie(reply, session.refreshRaw, deps.config);
          return sessionBody(session);
        },
      );

      scope.post('/refresh', requestSchema({ tags: ['auth'] }), async (request, reply) => {
        const raw = request.cookies[REFRESH_COOKIE];
        if (!raw) {
          return reply.code(401).send(errorBody('UNAUTHORIZED', 'Invalid refresh token'));
        }
        let accessSubject: string | undefined;
        if (request.headers.authorization) {
          try {
            accessSubject = await readAccessSubjectIgnoringExpiry(
              request.headers.authorization,
              deps.config.jwtAccessSecret,
            );
          } catch {
            return reply.code(401).send(errorBody('UNAUTHORIZED', 'Invalid access token'));
          }
        }
        try {
          const session = await rotateSession(deps.db, raw, {
            accessSecret: deps.config.jwtAccessSecret,
            userAgent: request.headers['user-agent'],
            ...(accessSubject !== undefined ? { accessSubject } : {}),
          });
          setRefreshCookie(reply, session.refreshRaw, deps.config);
          return sessionBody(session);
        } catch (error) {
          if (error instanceof AuthError) {
            return reply.code(401).send(errorBody('UNAUTHORIZED', error.message));
          }
          throw error;
        }
      });

      scope.post('/logout', requestSchema({ tags: ['auth'] }), async (request, reply) => {
        await revokeSession(deps.db, request.cookies[REFRESH_COOKIE]);
        reply.clearCookie(REFRESH_COOKIE, cookieOptions(deps.config));
        return reply.code(204).send();
      });
    },
    { prefix: '/auth' },
  );
}

function sessionBody(session: {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: 'admin' | 'user' };
}) {
  return {
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    user: session.user,
  };
}

function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.nodeEnv === 'production',
    path: '/auth',
    maxAge: REFRESH_MAX_AGE_SECONDS,
  };
}

function setRefreshCookie(
  reply: {
    setCookie: (name: string, value: string, options: ReturnType<typeof cookieOptions>) => void;
  },
  rawToken: string,
  config: Config,
) {
  reply.setCookie(REFRESH_COOKIE, rawToken, cookieOptions(config));
}
