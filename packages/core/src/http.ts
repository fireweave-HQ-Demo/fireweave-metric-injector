export class VendorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorInputError';
  }
}

export type VendorRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type VendorResponse = {
  status: number;
  body: string;
};

export type VendorHttp = {
  request(input: VendorRequest): Promise<VendorResponse>;
};

export function createFetchHttp(): VendorHttp {
  return {
    async request(input) {
      assertSafeVendorUrl(input.url);
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        redirect: 'manual',
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

export function assertSafeVendorUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VendorInputError('Vendor URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new VendorInputError('Vendor URL must use https');
  }
  if (url.username || url.password) {
    throw new VendorInputError('Vendor URL must not include credentials');
  }
  if (url.search || url.hash) {
    throw new VendorInputError('Vendor URL must not include a query or hash');
  }
  assertSafeHost(url.hostname);
  return url;
}

export function assertSafeHost(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host.length === 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    throw new VendorInputError('Vendor URL host is not allowed');
  }
  if (isBlockedAddress(host)) {
    throw new VendorInputError('Vendor URL host is not allowed');
  }
}

function isBlockedAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part > 255)) {
      return true;
    }
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return true;
    }
    return false;
  }
  return (
    host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  );
}
