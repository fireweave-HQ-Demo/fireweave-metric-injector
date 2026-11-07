import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from '../http.js';
import { verifyAccessToken, type AccessClaims } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

export function requireAccessToken(accessSecret: string) {
  return async function requireAccessTokenHook(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    if (!header) {
      return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
    }
    try {
      request.user = await verifyAccessToken(header, accessSecret);
    } catch {
      return reply.code(401).send(errorBody('UNAUTHORIZED', 'Invalid access token'));
    }
  };
}
