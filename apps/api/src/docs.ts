import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

export async function registerDocs(app: FastifyInstance): Promise<void> {
  app.setValidatorCompiler(() => () => true);
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Fireweave',
        description: 'Durable simulated traffic for OpenObserve, Datadog, and Sentry.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
}

export function requestSchema(input: {
  tags: string[];
  auth?: boolean;
  body?: ZodTypeAny;
  querystring?: ZodTypeAny;
  params?: boolean;
}): { schema: FastifySchema } {
  const schema: FastifySchema = { tags: input.tags };
  if (input.auth) {
    schema.security = [{ bearerAuth: [] }];
  }
  if (input.body) {
    schema.body = toJsonSchema(input.body);
  }
  if (input.querystring) {
    schema.querystring = toJsonSchema(input.querystring);
  }
  if (input.params) {
    schema.params = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } },
    };
  }
  return { schema };
}

function toJsonSchema(schema: ZodTypeAny): FastifySchema['body'] {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
  if (json && typeof json === 'object' && '$schema' in json) {
    delete json.$schema;
  }
  return json;
}
