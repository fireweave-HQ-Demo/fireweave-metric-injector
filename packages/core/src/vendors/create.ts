import type { VendorAdapter } from '../metrics.js';
import type { VendorHttp } from '../http.js';
import type { VendorCredentials } from './credentials.js';
import { createDatadogAdapter } from './datadog.js';
import { createOpenObserveAdapter } from './openobserve.js';
import { createSentryAdapter } from './sentry.js';

export function createVendorAdapter(input: {
  accountId: string;
  credentials: VendorCredentials;
  http: VendorHttp;
}): VendorAdapter {
  if (input.credentials.vendorType === 'openobserve') {
    return createOpenObserveAdapter({
      accountId: input.accountId,
      credentials: input.credentials.credentials,
      http: input.http,
    });
  }
  if (input.credentials.vendorType === 'datadog') {
    return createDatadogAdapter({
      accountId: input.accountId,
      credentials: input.credentials.credentials,
      http: input.http,
    });
  }
  return createSentryAdapter({
    accountId: input.accountId,
    credentials: input.credentials.credentials,
    http: input.http,
  });
}
