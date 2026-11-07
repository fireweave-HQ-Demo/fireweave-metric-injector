import { createFetchHttp, createVendorAdapter, type VendorCredentials } from '@fireweave/core';

const http = createFetchHttp();

function required(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function configured(names: string[]): { present: string[]; missing: string[] } {
  const present = names.filter((name) => required(name));
  const missing = names.filter((name) => !required(name));
  return { present, missing };
}

async function check(label: string, credentials: VendorCredentials): Promise<void> {
  const adapter = createVendorAdapter({ accountId: 'sandbox', credentials, http });
  const accepted = await adapter.validateCredentials();
  if (!accepted) {
    throw new Error(`${label} rejected the credentials`);
  }
  const sent = await adapter.ingestMetrics(
    [
      {
        name: 'fireweave.sandbox',
        type: 'counter',
        value: 1,
        timestamp: new Date(),
        tags: { source: 'fireweave-sandbox' },
      },
    ],
    { batchId: 'sandbox' },
  );
  if (!sent.ok) {
    throw new Error(`${label} ingest failed with status ${sent.statusCode}`);
  }
  console.log(`${label} accepted one sandbox point`);
}

async function main(): Promise<void> {
  const vendors: Array<{ label: string; names: string[]; credentials: () => VendorCredentials }> =
    [];

  const datadog = configured([
    'SANDBOX_DATADOG_API_KEY',
    'SANDBOX_DATADOG_APP_KEY',
    'SANDBOX_DATADOG_SITE',
  ]);
  if (datadog.present.length > 0 && datadog.missing.length > 0) {
    throw new Error(`Datadog sandbox is missing ${datadog.missing.join(', ')}`);
  }
  if (datadog.missing.length === 0) {
    vendors.push({
      label: 'Datadog',
      names: datadog.present,
      credentials: () => ({
        vendorType: 'datadog',
        credentials: {
          apiKey: required('SANDBOX_DATADOG_API_KEY') ?? '',
          appKey: required('SANDBOX_DATADOG_APP_KEY') ?? '',
          site: required('SANDBOX_DATADOG_SITE') ?? '',
        },
      }),
    });
  }

  const openObserveBase = configured(['SANDBOX_OPENOBSERVE_BASE_URL', 'SANDBOX_OPENOBSERVE_ORG']);
  const openObserveToken = required('SANDBOX_OPENOBSERVE_TOKEN');
  const openObserveEmail = required('SANDBOX_OPENOBSERVE_EMAIL');
  const openObservePassword = required('SANDBOX_OPENOBSERVE_PASSWORD');
  const openObserveTouched =
    openObserveBase.present.length > 0 ||
    openObserveToken ||
    openObserveEmail ||
    openObservePassword;
  if (openObserveTouched) {
    if (openObserveBase.missing.length > 0) {
      throw new Error(`OpenObserve sandbox is missing ${openObserveBase.missing.join(', ')}`);
    }
    if (openObserveToken) {
      vendors.push({
        label: 'OpenObserve',
        names: [...openObserveBase.present, 'SANDBOX_OPENOBSERVE_TOKEN'],
        credentials: () => ({
          vendorType: 'openobserve',
          credentials: {
            baseUrl: required('SANDBOX_OPENOBSERVE_BASE_URL') ?? '',
            organization: required('SANDBOX_OPENOBSERVE_ORG') ?? '',
            token: openObserveToken,
          },
        }),
      });
    } else if (openObserveEmail && openObservePassword) {
      vendors.push({
        label: 'OpenObserve',
        names: [
          ...openObserveBase.present,
          'SANDBOX_OPENOBSERVE_EMAIL',
          'SANDBOX_OPENOBSERVE_PASSWORD',
        ],
        credentials: () => ({
          vendorType: 'openobserve',
          credentials: {
            baseUrl: required('SANDBOX_OPENOBSERVE_BASE_URL') ?? '',
            organization: required('SANDBOX_OPENOBSERVE_ORG') ?? '',
            email: openObserveEmail,
            password: openObservePassword,
          },
        }),
      });
    } else {
      throw new Error(
        'OpenObserve sandbox needs SANDBOX_OPENOBSERVE_TOKEN or both SANDBOX_OPENOBSERVE_EMAIL and SANDBOX_OPENOBSERVE_PASSWORD',
      );
    }
  }

  const sentry = configured([
    'SANDBOX_SENTRY_DSN',
    'SANDBOX_SENTRY_ORG',
    'SANDBOX_SENTRY_PROJECT',
    'SANDBOX_SENTRY_TOKEN',
  ]);
  if (sentry.present.length > 0 && sentry.missing.length > 0) {
    throw new Error(`Sentry sandbox is missing ${sentry.missing.join(', ')}`);
  }
  if (sentry.missing.length === 0) {
    vendors.push({
      label: 'Sentry',
      names: sentry.present,
      credentials: () => ({
        vendorType: 'sentry',
        credentials: {
          dsn: required('SANDBOX_SENTRY_DSN') ?? '',
          organization: required('SANDBOX_SENTRY_ORG') ?? '',
          project: required('SANDBOX_SENTRY_PROJECT') ?? '',
          orgAuthToken: required('SANDBOX_SENTRY_TOKEN') ?? '',
        },
      }),
    });
  }

  if (vendors.length === 0) {
    console.log(
      'Vendor sandbox skipped. Set SANDBOX_DATADOG_*, SANDBOX_OPENOBSERVE_*, or SANDBOX_SENTRY_* to send one live point. This script is manual and is not part of pnpm test.',
    );
    return;
  }

  for (const vendor of vendors) {
    await check(vendor.label, vendor.credentials());
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Vendor sandbox failed');
  process.exit(1);
});
