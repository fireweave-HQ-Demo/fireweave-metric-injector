import { assertSafeHost, assertSafeVendorUrl, VendorInputError } from '../http.js';

export type OpenObservePasswordCredentials = {
  baseUrl: string;
  organization: string;
  email: string;
  password: string;
};

export type OpenObserveTokenCredentials = {
  baseUrl: string;
  organization: string;
  token: string;
};

export type DatadogCredentials = {
  apiKey: string;
  appKey: string;
  site: string;
};

export type SentryCredentials = {
  dsn: string;
  organization: string;
  project: string;
  orgAuthToken: string;
};

export type VendorCredentials =
  | {
      vendorType: 'openobserve';
      credentials: OpenObservePasswordCredentials | OpenObserveTokenCredentials;
    }
  | { vendorType: 'datadog'; credentials: DatadogCredentials }
  | { vendorType: 'sentry'; credentials: SentryCredentials };

export type CredentialKind = 'api_key' | 'token' | 'email' | 'dsn_key';

export type ParsedSentryDsn = {
  publicKey: string;
  projectId: string;
  envelopeUrl: string;
  apiBaseUrl: string;
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeVendorCredentials(input: VendorCredentials): VendorCredentials {
  if (input.vendorType === 'openobserve') {
    const baseUrl = normalizeBaseUrl(input.credentials.baseUrl);
    const organization = assertSlug(input.credentials.organization, 'Organization');
    if ('token' in input.credentials) {
      return {
        vendorType: 'openobserve',
        credentials: { baseUrl, organization, token: input.credentials.token },
      };
    }
    return {
      vendorType: 'openobserve',
      credentials: {
        baseUrl,
        organization,
        email: input.credentials.email.toLowerCase(),
        password: input.credentials.password,
      },
    };
  }
  if (input.vendorType === 'datadog') {
    return {
      vendorType: 'datadog',
      credentials: {
        apiKey: input.credentials.apiKey,
        appKey: input.credentials.appKey,
        site: normalizeDatadogSite(input.credentials.site),
      },
    };
  }
  const parsedDsn = parseSentryDsn(input.credentials.dsn);
  return {
    vendorType: 'sentry',
    credentials: {
      dsn: canonicalDsn(input.credentials.dsn, parsedDsn),
      organization: assertSlug(input.credentials.organization, 'Organization'),
      project: assertSlug(input.credentials.project, 'Project'),
      orgAuthToken: input.credentials.orgAuthToken,
    },
  };
}

export function credentialDescriptor(input: VendorCredentials): {
  credentialHint: string;
  credentialKind: CredentialKind;
} {
  if (input.vendorType === 'datadog') {
    return { credentialKind: 'api_key', credentialHint: last4(input.credentials.apiKey) };
  }
  if (input.vendorType === 'sentry') {
    return {
      credentialKind: 'dsn_key',
      credentialHint: last4(parseSentryDsn(input.credentials.dsn).publicKey),
    };
  }
  if ('token' in input.credentials) {
    return { credentialKind: 'token', credentialHint: last4(input.credentials.token) };
  }
  return { credentialKind: 'email', credentialHint: last4(input.credentials.email) };
}

export function parseSentryDsn(dsn: string): ParsedSentryDsn {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    throw new VendorInputError('Sentry DSN is invalid');
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.password) {
    throw new VendorInputError('Sentry DSN must be an https URL with a public key and project id');
  }
  assertSafeHost(url.hostname);
  const publicKey = decodeURIComponent(url.username);
  const projectId = url.pathname.split('/').filter((part) => part.length > 0)[0];
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) {
    throw new VendorInputError('Sentry DSN must include a public key and a numeric project id');
  }
  return {
    publicKey,
    projectId,
    envelopeUrl: `${url.origin}/api/${projectId}/envelope/`,
    apiBaseUrl: sentryApiBase(url),
  };
}

export function normalizeDatadogSite(site: string): string {
  const host = site.trim().toLowerCase().replace(/\.$/, '');
  if (host.includes('://') || host.includes('/') || host.includes(':') || host.includes(' ')) {
    throw new VendorInputError('Datadog site must be a hostname such as datadoghq.com');
  }
  const bare = host.startsWith('api.') ? host.slice(4) : host;
  if (
    !/^[a-z0-9.-]+$/.test(bare) ||
    bare.startsWith('.') ||
    bare.endsWith('.') ||
    bare.includes('..')
  ) {
    throw new VendorInputError('Datadog site must be a hostname such as datadoghq.com');
  }
  assertSafeHost(bare);
  assertSafeVendorUrl(`https://api.${bare}/`);
  return bare;
}

export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function assertSlug(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SLUG.test(trimmed)) {
    throw new VendorInputError(`${label} contains unsupported characters`);
  }
  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  const url = assertSafeVendorUrl(value.trim());
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

function canonicalDsn(value: string, parsed: ParsedSentryDsn): string {
  const url = new URL(value.trim());
  return `https://${encodeURIComponent(parsed.publicKey)}@${url.host}/${parsed.projectId}`;
}

function sentryApiBase(url: URL): string {
  const match = /^o[a-z0-9]+\.ingest(?:\.([a-z0-9-]+))?\.sentry\.io$/i.exec(url.hostname);
  if (!match) {
    return url.origin;
  }
  const region = match[1];
  return region ? `https://${region}.sentry.io` : 'https://sentry.io';
}

function last4(value: string): string {
  return value.slice(-4);
}
