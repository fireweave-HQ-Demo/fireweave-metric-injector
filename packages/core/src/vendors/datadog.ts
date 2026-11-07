import type { MetricPoint, VendorAdapter } from '../metrics.js';
import type { VendorHttp } from '../http.js';
import { type DatadogCredentials } from './credentials.js';

const COUNT = 1;
const GAUGE = 3;

export function createDatadogAdapter(input: {
  accountId: string;
  credentials: DatadogCredentials;
  http: VendorHttp;
}): VendorAdapter {
  const base = `https://api.${input.credentials.site}`;
  const headers = {
    'content-type': 'application/json',
    'dd-api-key': input.credentials.apiKey,
  };

  return {
    async validateCredentials() {
      const response = await input.http.request({
        method: 'GET',
        url: `${base}/api/v1/validate`,
        headers: { 'dd-api-key': input.credentials.apiKey },
      });
      if (response.status !== 200) {
        return false;
      }
      try {
        const parsed = JSON.parse(response.body) as { valid?: unknown };
        return parsed.valid === true;
      } catch {
        return false;
      }
    },
    async ingestMetrics(metrics, _options) {
      if (metrics.length === 0) {
        return { accountId: input.accountId, ok: true, statusCode: 204, acceptedCount: 0 };
      }
      const series = metrics.filter((metric) => metric.type !== 'histogram');
      const distributions = metrics.filter((metric) => metric.type === 'histogram');
      let acceptedCount = 0;
      let failure: number | null = null;

      if (series.length > 0) {
        const response = await input.http.request({
          method: 'POST',
          url: `${base}/api/v2/series`,
          headers,
          body: JSON.stringify({ series: series.map(toSeries) }),
        });
        if (response.status >= 200 && response.status < 300) {
          acceptedCount += series.length;
        } else {
          failure = response.status;
        }
      }

      if (distributions.length > 0) {
        const response = await input.http.request({
          method: 'POST',
          url: `${base}/api/v1/distribution_points`,
          headers,
          body: JSON.stringify({ series: distributions.map(toDistribution) }),
        });
        if (response.status >= 200 && response.status < 300) {
          acceptedCount += distributions.length;
        } else if (failure === null) {
          failure = response.status;
        }
      }

      if (failure !== null) {
        return {
          accountId: input.accountId,
          ok: false,
          statusCode: failure,
          acceptedCount,
          error: `Vendor request failed with status ${failure}`,
        };
      }
      return { accountId: input.accountId, ok: true, statusCode: 202, acceptedCount };
    },
  };
}

function toSeries(metric: MetricPoint) {
  return {
    metric: metric.name,
    type: metric.type === 'gauge' ? GAUGE : COUNT,
    points: [{ timestamp: unixSeconds(metric.timestamp), value: metric.value }],
    tags: datadogTags(metric.tags),
  };
}

function toDistribution(metric: MetricPoint) {
  return {
    metric: metric.name,
    points: [[unixSeconds(metric.timestamp), [metric.value]]],
    tags: datadogTags(metric.tags),
  };
}

function datadogTags(tags: Record<string, string>): string[] {
  return Object.entries(tags)
    .filter(([key]) => key.length > 0 && !key.startsWith('__'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`);
}

function unixSeconds(timestamp: Date): number {
  return Math.floor(timestamp.getTime() / 1000);
}
