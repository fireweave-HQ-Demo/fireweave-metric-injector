import type { Database } from '@fireweave/db';
import { Prisma } from '@fireweave/db';
import {
  ACCESS_TTL_SECONDS,
  hashRefreshToken,
  hashUserAgent,
  newChainId,
  newRefreshSecret,
  refreshExpiry,
  signAccessToken,
  type AccessClaims,
} from './tokens.js';

export class AuthError extends Error {
  constructor(message = 'Invalid refresh token') {
    super(message);
    this.name = 'AuthError';
  }
}

type SessionUser = {
  id: string;
  email: string;
  role: 'admin' | 'user';
};

export type IssuedSession = {
  accessToken: string;
  refreshRaw: string;
  expiresIn: number;
  user: SessionUser;
};

export async function issueSession(
  db: Database,
  user: SessionUser,
  userAgent: string | undefined,
  accessSecret: string,
): Promise<IssuedSession> {
  const refresh = newRefreshSecret();
  await db.refreshToken.create({
    data: {
      userId: user.id,
      chainId: newChainId(),
      tokenHash: refresh.hash,
      userAgentHash: hashUserAgent(userAgent),
      expiresAt: refreshExpiry(),
    },
  });
  const accessToken = await signAccessToken(toClaims(user), accessSecret);
  return { accessToken, refreshRaw: refresh.raw, expiresIn: ACCESS_TTL_SECONDS, user };
}

export async function rotateSession(
  db: Database,
  rawToken: string,
  options: {
    accessSecret: string;
    userAgent: string | undefined;
    accessSubject?: string;
  },
): Promise<IssuedSession> {
  const tokenHash = hashRefreshToken(rawToken);
  const now = new Date();

  const outcome = await db.$transaction(async (tx) => {
    const current = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!current) {
      return { kind: 'invalid' as const };
    }
    if (options.accessSubject !== undefined && options.accessSubject !== current.userId) {
      return { kind: 'mismatch' as const };
    }
    if (current.expiresAt <= now) {
      return { kind: 'expired' as const };
    }
    if (current.revokedAt || current.replacedById) {
      await revokeChain(tx, current.chainId, now);
      return { kind: 'revoked' as const };
    }

    const refresh = newRefreshSecret();
    const child = await tx.refreshToken.create({
      data: {
        userId: current.userId,
        chainId: current.chainId,
        parentId: current.id,
        tokenHash: refresh.hash,
        userAgentHash: hashUserAgent(options.userAgent),
        expiresAt: refreshExpiry(now),
      },
    });
    const claimed = await tx.refreshToken.updateMany({
      where: { id: current.id, replacedById: null, revokedAt: null },
      data: { replacedById: child.id },
    });
    if (claimed.count !== 1) {
      await tx.refreshToken.delete({ where: { id: child.id } });
      await revokeChain(tx, current.chainId, now);
      return { kind: 'revoked' as const };
    }

    const user = toSessionUser(current.user);
    const accessToken = await signAccessToken(toClaims(user), options.accessSecret);
    return {
      kind: 'issued' as const,
      session: { accessToken, refreshRaw: refresh.raw, expiresIn: ACCESS_TTL_SECONDS, user },
    };
  });

  if (outcome.kind === 'issued') {
    return outcome.session;
  }
  if (outcome.kind === 'mismatch') {
    throw new AuthError('Refresh token subject mismatch');
  }
  if (outcome.kind === 'expired') {
    throw new AuthError('Refresh token expired');
  }
  if (outcome.kind === 'revoked') {
    throw new AuthError('Refresh token revoked');
  }
  throw new AuthError();
}

export async function revokeSession(db: Database, rawToken: string | undefined): Promise<void> {
  if (!rawToken) {
    return;
  }
  const tokenHash = hashRefreshToken(rawToken);
  const current = await db.refreshToken.findUnique({ where: { tokenHash } });
  if (!current) {
    return;
  }
  await db.refreshToken.updateMany({
    where: { chainId: current.chainId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function revokeChain(
  tx: Prisma.TransactionClient,
  chainId: string,
  now: Date,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { chainId, revokedAt: null },
    data: { revokedAt: now },
  });
}

function toSessionUser(user: { id: string; email: string; role: string }): SessionUser {
  if (user.role !== 'admin' && user.role !== 'user') {
    throw new AuthError('Invalid refresh token');
  }
  return { id: user.id, email: user.email, role: user.role };
}

function toClaims(user: SessionUser): AccessClaims {
  return { id: user.id, email: user.email, role: user.role };
}
