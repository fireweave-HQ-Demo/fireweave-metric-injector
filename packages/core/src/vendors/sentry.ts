import { createHash } from 'node:crypto';
import type { MetricPoint, VendorAdapter } from '../metrics.js';
import type { VendorHttp } from '../http.js';
import { assertSlug, parseSentryDsn, type SentryCredentials } from './credentials.js';

const CLIENT = 'fireweave-metric-injector/0.1';

export function createSentryAdapter(input: {
  accountId: string;
  credentials: SentryCredentials;
  http: VendorHttp;
}): VendorAdapter {
  const dsn = parseSentryDsn(input.credentials.dsn);
  const organization = assertSlug(input.credentials.organization, 'Organization');
  const project = assertSlug(input.credentials.project, 'Project');

  return {
    async validateCredentials() {
      const response = await input.http.request({
        method: 'GET',
        url: `${dsn.apiBaseUrl}/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/`,
        headers: { authorization: `Bearer ${input.credentials.orgAuthToken}` },
      });
      return response.status === 200;
    },
    async ingestMetrics(metrics, options) {
      if (metrics.length === 0) {
        return { accountId: input.accountId, ok: true, statusCode: 204, acceptedCount: 0 };
      }
      const traceId = traceIdFromBatch(options.batchId);
      const items = metrics.map((metric) => toTraceMetric(metric, traceId));
      const envelopeHeader = {
        event_id: traceId,
        sent_at: new Date().toISOString(),
      };
      const itemHeader = {
        type: 'trace_metric',
        item_count: items.length,
        content_type: 'application/vnd.sentry.items.trace-metric+json',
      };
      const payload = { version: 2, items };
      const body = `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}\n`;
      const response = await input.http.request({
        method: 'POST',
        url: dsn.envelopeUrl,
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=${CLIENT}`,
        },
        body,
      });
      if (response.status >= 200 && response.status < 300) {
        return {
          accountId: input.accountId,
          ok: true,
          statusCode: response.status,
          acceptedCount: metrics.length,
        };
      }
      return {
        accountId: input.accountId,
        ok: false,
        statusCode: response.status,
        acceptedCount: 0,
        error: `Vendor request failed with status ${response.status}`,
      };
    },
  };
}

function toTraceMetric(metric: MetricPoint, traceId: string) {
  const attributes: Record<string, { value: string; type: 'string' }> = {};
  for (const [key, value] of Object.entries(metric.tags).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (key.length === 0) {
      continue;
    }
    attributes[key] = { value, type: 'string' };
  }
  return {
    timestamp: metric.timestamp.getTime() / 1000,
    trace_id: traceId,
    name: metric.name,
    type: metric.type === 'histogram' ? 'distribution' : metric.type,
    value: metric.value,
    attributes,
  };
}

function traceIdFromBatch(batchId: string): string {
  const hex = batchId.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) {
    return hex;
  }
  return createHash('sha256').update(batchId).digest('hex').slice(0, 32);
}
