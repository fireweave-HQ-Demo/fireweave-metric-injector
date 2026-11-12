import { describe, expect, it } from 'vitest';
import { createVendorAdapter } from '../src/index.js';
import type { MetricPoint } from '../src/metrics.js';
import type { VendorHttp, VendorRequest } from '../src/http.js';
import { normalizeVendorCredentials } from '../src/vendors/credentials.js';

const batchId = '11111111-1111-4111-8111-111111111111';
const at = new Date('2026-01-02T03:04:05.000Z');

function recorder(status = 200, body = '{"valid":true}') {
  const calls: VendorRequest[] = [];
  const http: VendorHttp = {
    async request(input) {
      calls.push(input);
      return { status, body };
    },
  };
  return { calls, http };
}

function point(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    name: 'orders.completed',
    type: 'counter',
    value: 1,
    timestamp: at,
    tags: { service: 'checkout' },
    ...overrides,
  };
}

describe('vendor adapters', () => {
  it('sends OpenObserve basic auth and a flat metrics JSON document', async () => {
    const { calls, http } = recorder();
    const credentials = normalizeVendorCredentials({
      vendorType: 'openobserve',
      credentials: {
        baseUrl: 'https://oo.example/',
        organization: 'default',
        email: 'Metrics-User@example.com',
        password: 'oo-password-SECRET',
      },
    });
    const adapter = createVendorAdapter({ accountId: 'acct-oo', credentials, http });
    await expect(adapter.validateCredentials()).resolves.toBe(true);
    const ingested = await adapter.ingestMetrics(
      [point({ type: 'histogram', name: 'checkout.latency', value: 12.5 })],
      { batchId },
    );

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://oo.example/api/default/');
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('metrics-user@example.com:oo-password-SECRET').toString('base64')}`,
    );
    expect(calls[1]?.url).toBe('https://oo.example/api/default/ingest/metrics/_json');
    expect(JSON.parse(calls[1]?.body ?? '[]')).toEqual([
      {
        __name__: 'checkout_latency',
        __type__: 'histogram',
        service: 'checkout',
        _timestamp: at.getTime(),
        value: 12.5,
      },
    ]);
    expect(ingested).toMatchObject({ accountId: 'acct-oo', ok: true, acceptedCount: 1 });
  });

  it('treats an OpenObserve 200 with failed points as a failed ingest', async () => {
    const { http } = recorder(
      200,
      JSON.stringify({
        code: 200,
        status: [{ name: 'checkout_latency', successful: 1, failed: 2 }],
      }),
    );
    const adapter = createVendorAdapter({
      accountId: 'acct-oo',
      credentials: normalizeVendorCredentials({
        vendorType: 'openobserve',
        credentials: {
          baseUrl: 'https://oo.example',
          organization: 'default',
          email: 'metrics-user@example.com',
          password: 'oo-password-SECRET',
        },
      }),
      http,
    });
    const ingested = await adapter.ingestMetrics([point(), point({ name: 'other' })], { batchId });
    expect(ingested).toMatchObject({
      accountId: 'acct-oo',
      ok: false,
      statusCode: 200,
      acceptedCount: 1,
    });
    expect(ingested.error).toMatch(/rejected 2/);
  });

  it('sends Datadog series and distribution points without the application key', async () => {
    const { calls, http } = recorder(202, '{}');
    const credentials = normalizeVendorCredentials({
      vendorType: 'datadog',
      credentials: {
        apiKey: 'dd-api-key-0123456789abcd',
        appKey: 'dd-app-key-ffffffffffffffff',
        site: 'datadog.test',
      },
    });
    const adapter = createVendorAdapter({ accountId: 'acct-dd', credentials, http });
    const ingested = await adapter.ingestMetrics(
      [
        point({ type: 'counter', value: 2 }),
        point({ type: 'gauge', name: 'queue.depth', value: 4 }),
        point({ type: 'histogram', name: 'checkout.latency', value: 12.5 }),
      ],
      { batchId },
    );

    const series = calls.find((call) => call.url.endsWith('/api/v2/series'));
    const distribution = calls.find((call) => call.url.endsWith('/api/v1/distribution_points'));
    expect(series?.url).toBe('https://api.datadog.test/api/v2/series');
    expect(distribution?.url).toBe('https://api.datadog.test/api/v1/distribution_points');
    expect(series?.headers['dd-api-key']).toBe('dd-api-key-0123456789abcd');
    expect(series?.headers).not.toHaveProperty('dd-application-key');
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('dd-app-key-ffffffffffffffff');
    expect(JSON.parse(series?.body ?? '{}')).toEqual({
      series: [
        {
          metric: 'orders.completed',
          type: 1,
          points: [{ timestamp: 1767323045, value: 2 }],
          tags: ['service:checkout'],
        },
        {
          metric: 'queue.depth',
          type: 3,
          points: [{ timestamp: 1767323045, value: 4 }],
          tags: ['service:checkout'],
        },
      ],
    });
    expect(JSON.parse(distribution?.body ?? '{}')).toEqual({
      series: [
        {
          metric: 'checkout.latency',
          points: [[1767323045, [12.5]]],
          tags: ['service:checkout'],
        },
      ],
    });
    expect(ingested).toMatchObject({
      accountId: 'acct-dd',
      ok: true,
      acceptedCount: 3,
      statusCode: 202,
    });
  });

  it('sends a Sentry trace_metric envelope and rejects a statsd item', async () => {
    const { calls, http } = recorder();
    const credentials = normalizeVendorCredentials({
      vendorType: 'sentry',
      credentials: {
        dsn: 'https://sntry-public-key-ABCDEF@o123.ingest.sentry.io/42',
        organization: 'acme',
        project: 'web',
        orgAuthToken: 'sntrys-org-token-SECRET999',
      },
    });
    const adapter = createVendorAdapter({ accountId: 'acct-se', credentials, http });
    await expect(adapter.validateCredentials()).resolves.toBe(true);
    await adapter.ingestMetrics(
      [point(), point({ type: 'histogram', name: 'checkout.latency', value: 12.5 })],
      { batchId },
    );

    expect(calls[0]?.url).toBe('https://sentry.io/api/0/projects/acme/web/');
    expect(calls[0]?.headers.authorization).toBe('Bearer sntrys-org-token-SECRET999');
    expect(calls[1]?.url).toBe('https://o123.ingest.sentry.io/api/42/envelope/');
    expect(calls[1]?.headers['x-sentry-auth']).toBe(
      'Sentry sentry_version=7, sentry_key=sntry-public-key-ABCDEF, sentry_client=fireweave-metric-injector/0.1',
    );
    expect(calls[1]?.headers.authorization).toBeUndefined();
    const [headerLine, itemLine, payloadLine] = (calls[1]?.body ?? '').trim().split('\n');
    const item = JSON.parse(itemLine ?? '{}') as {
      type?: string;
      item_count?: number;
      content_type?: string;
    };
    const payload = JSON.parse(payloadLine ?? '{}') as {
      version?: number;
      items?: Array<{ type?: string }>;
    };
    expect(JSON.parse(headerLine ?? '{}')).toMatchObject({
      event_id: '11111111111141118111111111111111',
    });
    expect(item).toEqual({
      type: 'trace_metric',
      item_count: 2,
      content_type: 'application/vnd.sentry.items.trace-metric+json',
    });
    expect(payload.version).toBe(2);
    expect(payload.items?.map((entry) => entry.type)).toEqual(['counter', 'distribution']);
    expect(calls[1]?.body).not.toMatch(/statsd/i);
  });

  it('treats Datadog valid:false as a failed credential check', async () => {
    const { http } = recorder(200, '{"valid":false}');
    const adapter = createVendorAdapter({
      accountId: 'acct-dd',
      credentials: normalizeVendorCredentials({
        vendorType: 'datadog',
        credentials: {
          apiKey: 'dd-api-key-0123456789abcd',
          appKey: 'dd-app-key-ffffffffffffffff',
          site: 'datadoghq.com',
        },
      }),
      http,
    });
    await expect(adapter.validateCredentials()).resolves.toBe(false);
  });
});
