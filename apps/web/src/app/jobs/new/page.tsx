'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Field, Select } from '@/components/field';
import { MetricEditor } from '@/components/metric-editor';
import { Shell } from '@/components/shell';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { emptyMetric, toMetricPayload, type MetricDraft } from '@/lib/metrics';
import { browserZone, fromDateTimeLocal, toDateTimeLocal } from '@/lib/time';
import type { JobDetail, Page, VendorAccount } from '@/lib/types';

export default function NewJobPage() {
  return (
    <Shell>
      <NewJobScreen />
    </Shell>
  );
}

function NewJobScreen() {
  const auth = useAuth();
  const router = useRouter();
  const [accounts, setAccounts] = useState<VendorAccount[]>([]);
  const [name, setName] = useState('Checkout traffic');
  const [timezone, setTimezone] = useState('UTC');
  const [virtualUserCount, setVirtualUserCount] = useState('1000');
  const [peakRatePerSecond, setPeakRatePerSecond] = useState('10');
  const [successProbability, setSuccessProbability] = useState('0.9');
  const [errorProbability, setErrorProbability] = useState('0.05');
  const [tickIntervalMs, setTickIntervalMs] = useState('1000');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<MetricDraft[]>([emptyMetric('successes')]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTimezone(browserZone());
    const start = new Date(Date.now() + 5 * 60 * 1000);
    setStartTime(toDateTimeLocal(start.toISOString()));
  }, []);

  useEffect(() => {
    if (auth.status !== 'ready') {
      return;
    }
    void auth
      .call<Page<VendorAccount>>('/api/v1/vendor-accounts')
      .then((page) => {
        setAccounts(page.items.filter((account) => account.isActive));
        setReady(true);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not load accounts');
        setReady(true);
      });
  }, [auth]);

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const job = await auth.call<JobDetail>('/api/v1/jobs', {
        method: 'POST',
        body: {
          name,
          timezone,
          virtualUserCount: Number(virtualUserCount),
          peakRatePerSecond: Number(peakRatePerSecond),
          successProbability: Number(successProbability),
          errorProbability: Number(errorProbability),
          tickIntervalMs: Number(tickIntervalMs),
          startTime: fromDateTimeLocal(startTime),
          endTime: endTime ? fromDateTimeLocal(endTime) : null,
          fanoutMode: 'replicate',
          vendorAccountIds: selected,
          definitions: metrics.map(toMetricPayload),
        },
      });
      router.replace(`/jobs/${job.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the job');
      setPending(false);
    }
  }

  const blocked = accounts.length === 0;

  return (
    <form
      className="mx-auto flex max-w-3xl flex-col gap-6"
      onSubmit={(event) => void onSubmit(event)}
    >
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">New job</h1>
        <Button variant="ghost" asChild>
          <Link href="/jobs">Back</Link>
        </Button>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {ready && blocked ? (
        <Alert>
          Add a vendor account before creating a job.{' '}
          <Link href="/accounts" className="underline">
            Go to accounts
          </Link>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input required value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Timezone">
            <Input
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </Field>
          <Field label="Tick interval (ms)" hint="1000–30000">
            <Input
              required
              inputMode="numeric"
              value={tickIntervalMs}
              onChange={(event) => setTickIntervalMs(event.target.value)}
            />
          </Field>
          <Field label="Virtual users">
            <Input
              required
              inputMode="numeric"
              value={virtualUserCount}
              onChange={(event) => setVirtualUserCount(event.target.value)}
            />
          </Field>
          <Field label="Peak rate / second">
            <Input
              required
              inputMode="decimal"
              value={peakRatePerSecond}
              onChange={(event) => setPeakRatePerSecond(event.target.value)}
            />
          </Field>
          <Field label="Success probability">
            <Input
              required
              inputMode="decimal"
              value={successProbability}
              onChange={(event) => setSuccessProbability(event.target.value)}
            />
          </Field>
          <Field label="Error probability">
            <Input
              required
              inputMode="decimal"
              value={errorProbability}
              onChange={(event) => setErrorProbability(event.target.value)}
            />
          </Field>
          <Field label="Start">
            <Input
              required
              type="datetime-local"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </Field>
          <Field label="End" hint="Optional.">
            <Input
              type="datetime-local"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </Field>
          <Field label="Fanout">
            <Select value="replicate" disabled>
              <option value="replicate">replicate</option>
            </Select>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Vendor accounts</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {accounts.map((account) => (
            <label key={account.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(account.id)}
                onChange={() => toggle(account.id)}
              />
              {account.label}
              <span className="text-muted-foreground">
                {account.vendorType} · {account.credentialHint}
              </span>
            </label>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <MetricEditor value={metrics} onChange={setMetrics} />
        </CardContent>
      </Card>
      <Button type="submit" disabled={pending || blocked || selected.length === 0}>
        {pending ? 'Creating…' : 'Create job'}
      </Button>
    </form>
  );
}
