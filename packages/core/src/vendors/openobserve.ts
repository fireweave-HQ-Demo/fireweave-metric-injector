import type { IngestionResult, MetricPoint, VendorAdapter } from '../metrics.js';
import type { VendorHttp } from '../http.js';
import {
  assertSlug,
  basicAuthorization,
  type OpenObservePasswordCredentials,
  type OpenObserveTokenCredentials,
} from './credentials.js';

export function createOpenObserveAdapter(input: {
  accountId: string;
  credentials: OpenObservePasswordCredentials | OpenObserveTokenCredentials;
  http: VendorHttp;
}): VendorAdapter {
  const authorization = openObserveAuthorization(input.credentials);
  const organization = assertSlug(input.credentials.organization, 'Organization');
  const root = input.credentials.baseUrl.replace(/\/+$/, '');

  return {
    async validateCredentials() {
      const response = await input.http.request({
        method: 'GET',
        url: `${root}/api/${encodeURIComponent(organization)}/`,
        headers: { authorization },
      });
      return response.status === 200;
    },
    async ingestMetrics(metrics, _options) {
      if (metrics.length === 0) {
        return emptyResult(input.accountId);
      }
      const response = await input.http.request({
        method: 'POST',
        url: `${root}/api/${encodeURIComponent(organization)}/ingest/metrics/_json`,
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(metrics.map(toOpenObserveRecord)),
      });
      return resultFromResponse(input.accountId, response.status, response.body, metrics.length);
    },
  };
}

function openObserveAuthorization(
  credentials: OpenObservePasswordCredentials | OpenObserveTokenCredentials,
): string {
  if ('token' in credentials) {
    return basicAuthorization(credentials.token, '');
  }
  return basicAuthorization(credentials.email, credentials.password);
}

function toOpenObserveRecord(metric: MetricPoint): Record<string, string | number> {
  const record: Record<string, string | number> = {
    __name__: metric.name,
    __type__: metric.type,
  };
  for (const [key, value] of sortedTags(metric.tags)) {
    if (
      key === '__name__' ||
      key === '__type__' ||
      key === 'value' ||
      key === '_timestamp' ||
      key === '@timestamp'
    ) {
      continue;
    }
    record[key] = value;
  }
  record._timestamp = metric.timestamp.getTime();
  record.value = metric.value;
  return record;
}

function sortedTags(tags: Record<string, string>): Array<[string, string]> {
  return Object.entries(tags).sort(([left], [right]) => left.localeCompare(right));
}

function emptyResult(accountId: string): IngestionResult {
  return { accountId, ok: true, statusCode: 204, acceptedCount: 0 };
}

function resultFromResponse(
  accountId: string,
  statusCode: number,
  body: string,
  sentCount: number,
): IngestionResult {
  const report = readIngestReport(body);
  const acceptedCount =
    report?.successful ?? (statusCode >= 200 && statusCode < 300 ? sentCount : 0);
  if (statusCode < 200 || statusCode >= 300 || (report !== null && report.failed > 0)) {
    const detail =
      report && report.failed > 0
        ? `Vendor accepted ${report.successful} points and rejected ${report.failed}`
        : `Vendor request failed with status ${statusCode}`;
    return { accountId, ok: false, statusCode, acceptedCount, error: detail };
  }
  return { accountId, ok: true, statusCode, acceptedCount };
}

function readIngestReport(body: string): { successful: number; failed: number } | null {
  try {
    const parsed = JSON.parse(body) as {
      status?: Array<{ successful?: unknown; failed?: unknown }>;
    };
    if (!Array.isArray(parsed.status)) {
      return null;
    }
    return parsed.status.reduce(
      (totals, row) => ({
        successful: totals.successful + countField(row.successful),
        failed: totals.failed + countField(row.failed),
      }),
      { successful: 0, failed: 0 },
    );
  } catch {
    return null;
  }
}

function countField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
