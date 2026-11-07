'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Field, Select } from '@/components/field';
import { Shell } from '@/components/shell';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { formatStamp } from '@/lib/time';
import type { Page, VendorAccount } from '@/lib/types';

type VendorType = 'openobserve' | 'datadog' | 'sentry';
type OpenObserveMode = 'password' | 'token';

const empty = {
  label: '',
  vendorType: 'datadog' as VendorType,
  mode: 'password' as OpenObserveMode,
  baseUrl: 'http://localhost:5080',
  organization: '',
  email: '',
  password: '',
  token: '',
  apiKey: '',
  appKey: '',
  site: 'datadoghq.com',
  dsn: '',
  project: '',
  orgAuthToken: '',
};

export default function AccountsPage() {
  return (
    <Shell>
      <AccountsScreen />
    </Shell>
  );
}

function AccountsScreen() {
  const auth = useAuth();
  const [accounts, setAccounts] = useState<VendorAccount[]>([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const page = await auth.call<Page<VendorAccount>>('/api/v1/vendor-accounts');
    setAccounts(page.items);
    setLoading(false);
  }, [auth]);

  useEffect(() => {
    if (auth.status !== 'ready') {
      return;
    }
    void load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not load accounts');
      setLoading(false);
    });
  }, [auth.status, load]);

  function patch<K extends keyof typeof empty>(key: K, value: (typeof empty)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function credentials() {
    if (form.vendorType === 'datadog') {
      return { apiKey: form.apiKey, appKey: form.appKey, site: form.site };
    }
    if (form.vendorType === 'sentry') {
      return {
        dsn: form.dsn,
        organization: form.organization,
        project: form.project,
        orgAuthToken: form.orgAuthToken,
      };
    }
    if (form.mode === 'token') {
      return { baseUrl: form.baseUrl, organization: form.organization, token: form.token };
    }
    return {
      baseUrl: form.baseUrl,
      organization: form.organization,
      email: form.email,
      password: form.password,
    };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await auth.call('/api/v1/vendor-accounts', {
        method: 'POST',
        body: { vendorType: form.vendorType, label: form.label, credentials: credentials() },
      });
      setForm(empty);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the account');
    } finally {
      setPending(false);
    }
  }

  async function remove(account: VendorAccount) {
    if (!window.confirm(`Delete ${account.label}?`)) {
      return;
    }
    setError(null);
    try {
      await auth.call(`/api/v1/vendor-accounts/${account.id}`, { method: 'DELETE' });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the account');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Vendor accounts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Credentials stay on the server. This page shows a hint, the kind, and when they last
          validated.
        </p>
        {error ? <Alert className="mt-4">{error}</Alert> : null}
        {loading ? <p className="mt-6 text-sm text-muted-foreground">Loading accounts…</p> : null}
        {!loading && accounts.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">No vendor accounts yet.</p>
        ) : null}
        <ul className="mt-4 flex flex-col gap-3">
          {accounts.map((account) => (
            <li key={account.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-medium">{account.label}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {account.vendorType} · {account.credentialKind} · ends{' '}
                      {account.credentialHint}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Validated {formatStamp(account.validatedAt)}
                      {account.isActive ? '' : ' · inactive'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void remove(account)}
                  >
                    Delete
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Add account</CardTitle>
          <CardDescription>A real vendor check runs before anything is stored.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
            <Field label="Label">
              <Input
                required
                value={form.label}
                onChange={(event) => patch('label', event.target.value)}
              />
            </Field>
            <Field label="Vendor">
              <Select
                value={form.vendorType}
                onChange={(event) => patch('vendorType', event.target.value as VendorType)}
              >
                <option value="datadog">Datadog</option>
                <option value="openobserve">OpenObserve</option>
                <option value="sentry">Sentry</option>
              </Select>
            </Field>
            {form.vendorType === 'datadog' ? (
              <>
                <Field label="API key">
                  <Input
                    required
                    value={form.apiKey}
                    onChange={(event) => patch('apiKey', event.target.value)}
                  />
                </Field>
                <Field label="Application key">
                  <Input
                    required
                    value={form.appKey}
                    onChange={(event) => patch('appKey', event.target.value)}
                  />
                </Field>
                <Field label="Site" hint="Public hostname, such as datadoghq.com.">
                  <Input
                    required
                    value={form.site}
                    onChange={(event) => patch('site', event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            {form.vendorType === 'openobserve' ? (
              <>
                <Field label="Auth">
                  <Select
                    value={form.mode}
                    onChange={(event) => patch('mode', event.target.value as OpenObserveMode)}
                  >
                    <option value="password">Email and password</option>
                    <option value="token">Token</option>
                  </Select>
                </Field>
                <Field label="Base URL">
                  <Input
                    required
                    value={form.baseUrl}
                    onChange={(event) => patch('baseUrl', event.target.value)}
                  />
                </Field>
                <Field label="Organization">
                  <Input
                    required
                    value={form.organization}
                    onChange={(event) => patch('organization', event.target.value)}
                  />
                </Field>
                {form.mode === 'password' ? (
                  <>
                    <Field label="Email">
                      <Input
                        type="email"
                        required
                        value={form.email}
                        onChange={(event) => patch('email', event.target.value)}
                      />
                    </Field>
                    <Field label="Password">
                      <Input
                        type="password"
                        required
                        value={form.password}
                        onChange={(event) => patch('password', event.target.value)}
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="Token">
                    <Input
                      required
                      value={form.token}
                      onChange={(event) => patch('token', event.target.value)}
                    />
                  </Field>
                )}
              </>
            ) : null}
            {form.vendorType === 'sentry' ? (
              <>
                <Field label="DSN">
                  <Input
                    required
                    value={form.dsn}
                    onChange={(event) => patch('dsn', event.target.value)}
                  />
                </Field>
                <Field label="Organization">
                  <Input
                    required
                    value={form.organization}
                    onChange={(event) => patch('organization', event.target.value)}
                  />
                </Field>
                <Field label="Project">
                  <Input
                    required
                    value={form.project}
                    onChange={(event) => patch('project', event.target.value)}
                  />
                </Field>
                <Field label="Org auth token">
                  <Input
                    required
                    value={form.orgAuthToken}
                    onChange={(event) => patch('orgAuthToken', event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Checking vendor…' : 'Save account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
