import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { compactVerify, decodeJwt, jwtVerify, SignJWT } from 'jose';

export const ACCESS_ISSUER = 'fireweave';
export const ACCESS_AUDIENCE = 'fireweave-api';
export const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AccessClaims = {
  id: string;
  email: string;
  role: 'admin' | 'user';
};

export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function newRefreshSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

export function refreshExpiry(now = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TTL_MS);
}

export function newChainId(): string {
  return randomUUID();
}

export function hashUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) {
    return null;
  }
  return createHash('sha256').update(userAgent).digest('hex');
}

export async function signAccessToken(claims: AccessClaims, secret: string): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.id)
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key(secret));
}

export async function verifyAccessToken(
  authorizationHeader: string,
  secret: string,
): Promise<AccessClaims> {
  const token = bearerToken(authorizationHeader);
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ACCESS_ISSUER,
    audience: ACCESS_AUDIENCE,
  });
  return claimsFromPayload(payload.sub, payload.email, payload.role);
}

/**
 * Signature, issuer, and audience are checked. Expiration is ignored so a
 * caller can refresh with an expired access token and still prove `sub`.
 */
export async function readAccessSubjectIgnoringExpiry(
  authorizationHeader: string,
  secret: string,
): Promise<string> {
  try {
    const token = bearerToken(authorizationHeader);
    await compactVerify(token, key(secret));
    const payload = decodeJwt(token);
    if (payload.iss !== ACCESS_ISSUER) {
      throw new Error('Invalid access token');
    }
    const audience = payload.aud;
    const audiences = Array.isArray(audience) ? audience : audience ? [audience] : [];
    if (!audiences.includes(ACCESS_AUDIENCE)) {
      throw new Error('Invalid access token');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('Invalid access token');
    }
    return payload.sub;
  } catch {
    throw new Error('Invalid access token');
  }
}

function bearerToken(authorizationHeader: string): string {
  const match = /^Bearer (\S+)$/.exec(authorizationHeader);
  const token = match?.[1];
  if (!token) {
    throw new Error('Invalid access token');
  }
  return token;
}

function claimsFromPayload(sub: unknown, email: unknown, role: unknown): AccessClaims {
  if (typeof sub !== 'string' || typeof email !== 'string') {
    throw new Error('Invalid access token');
  }
  if (role !== 'admin' && role !== 'user') {
    throw new Error('Invalid access token');
  }
  return { id: sub, email, role };
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
