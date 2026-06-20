// Type augmentation: the JWT claim shape and the `authenticate` preHandler the
// server decorates onto the Fastify instance.
import '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthTokenPayload } from '@eishera/shared';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthTokenPayload;
    user: AuthTokenPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
