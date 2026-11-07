'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Field, Select } from '@/components/field';
import { MetricEditor } from '@/components/metric-editor';
import { Shell } from '@/components/shell';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { draftsFromDefinitions, toMetricPayload, type MetricDraft } from '@/lib/metrics';
import { formatStamp, fromDateTimeLocal, toDateTimeLocal } from '@/lib/time';
import type { JobDetail, Page, VendorAccount } from '@/lib/types';

export default function JobDetailPage() {
  return (
    <Shell>
      <JobDetailScreen />
    </Shell>
  );
}

function JobDetailScreen() {
  const params = useParams<{ id: string }>();
  const auth = useAuth();
  const router = useRouter();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [accounts, setAccounts] = useState<VendorAccount[]>([]);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [virtualUserCount, setVirtualUserCount] = useState('');
  const [peakRatePerSecond, setPeakRatePerSecond] = useState('');
  const [successProbability, setSuccessProbability] = useState('');
  const [errorProbability, setErrorProbability] = useState('');
  const [tickIntervalMs, setTickIntervalMs] = useState('');
  const [endTime, setEndTime] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<MetricDraft[]>([]);
  const [injectId, setInjectId] = useState('');
  const [injectValue, setInjectValue] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<'save' | 'inject' | 'action' | null>(null);

  const apply = useCallback((next: JobDetail) => {
    setJob(next);
    setName(next.name);
    setTimezone(next.timezone);
    setVirtualUserCount(String(next.virtualUserCount));
    setPeakRatePerSecond(String(next.peakRatePerSecond));
    setSuccessProbability(String(next.successProbability));
    setErrorProbability(String(next.errorProbability));
    setTickIntervalMs(String(next.tickIntervalMs));
    setEndTime(next.endTime ? toDateTimeLocal(next.endTime) : '');
    setSelected(next.vendorAccountIds);
    const drafts = draftsFromDefinitions(next.definitions);
    setMetrics(drafts);
    setInjectId((current) =>
      next.definitions.some((definition) => definition.id === current)
        ? current
        : (next.definitions[0]?.id ?? ''),
    );
  }, []);

  const load = useCallback(async () => {
    const [detail, page] = await Promise.all([
      auth.call<JobDetail>(`/api/v1/jobs/${params.id}`),
      auth.call<Page<VendorAccount>>('/api/v1/vendor-accounts'),
    ]);
    setAccounts(page.items);
    apply(detail);
  }, [apply, auth, params.id]);

  useEffect(() => {
    if (auth.status !== 'ready') {
      return;
    }
    void load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the job');
    });
  }, [auth.status, load]);

  async function act(
    path: string,
    method: string,
    body?: unknown,
    kind: 'save' | 'action' = 'action',
  ) {
    setPending(kind);
    setError(null);
    setNotice(null);
    try {
      if (method === 'DELETE') {
        await auth.call(path, { method });
        router.replace('/jobs');
        return;
      }
      const next = await auth.call<JobDetail>(path, { method, body });
      if (next && typeof next === 'object' && 'id' in next) {
        apply(next);
      } else {
        await load();
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Request failed');
    } finally {
      setPending(null);
    }
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!job) {
      return;
    }
    const structural = job.status !== 'active';
    const body: Record<string, unknown> = {
      name,
      timezone,
      virtualUserCount: Number(virtualUserCount),
      peakRatePerSecond: Number(peakRatePerSecond),
      successProbability: Number(successProbability),
      errorProbability: Number(errorProbability),
      tickIntervalMs: Number(tickIntervalMs),
      endTime: endTime ? fromDateTimeLocal(endTime) : null,
    };
    if (structural) {
      try {
        body.vendorAccountIds = selected;
        body.definitions = metrics.map(toMetricPayload);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Metrics are invalid');
        return;
      }
    }
    await act(`/api/v1/jobs/${job.id}`, 'PATCH', body, 'save');
  }

  async function onInject(event: FormEvent) {
    event.preventDefault();
    if (!job) {
      return;
    }
    const value = Number(injectValue);
    if (!Number.isFinite(value)) {
      setError('Inject a finite number');
      return;
    }
    setPending('inject');
    setError(null);
    setNotice(null);
    try {
      await auth.call(`/api/v1/jobs/${job.id}/inject`, {
        method: 'POST',
        body: { metricDefinitionId: injectId, value },
      });
      setNotice('Point queued.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Inject failed');
    } finally {
      setPending(null);
    }
  }

  if (!job) {
    return <p className="text-sm text-muted-foreground">{error ?? 'Loading job…'}</p>;
  }

  const locked = job.status === 'active';
  const canPause = job.status === 'scheduled' || job.status === 'active';
  const canResume = job.status === 'paused';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{job.name}</h1>
        <StatusBadge status={job.status} />
        <Button className="sm:ml-auto" variant="ghost" asChild>
          <Link href="/jobs">Back</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Last simulated {formatStamp(job.lastSimulatedAt)} · started {formatStamp(job.startTime)}
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!canPause || pending !== null}
          onClick={() => void act(`/api/v1/jobs/${job.id}/pause`, 'POST')}
        >
          Pause
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!canResume || pending !== null}
          onClick={() => void act(`/api/v1/jobs/${job.id}/resume`, 'POST')}
        >
          Resume
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending !== null}
          onClick={() => {
            if (window.confirm(`Delete ${job.name}?`)) {
              void act(`/api/v1/jobs/${job.id}`, 'DELETE');
            }
          }}
        >
          Delete
        </Button>
      </div>
      <form className="flex flex-col gap-6" onSubmit={(event) => void onSave(event)}>
        {locked ? (
          <Alert>
            Pause the job to replace metrics or vendor accounts. Rates and the schedule can still
            change.
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
            <Field label="Tick interval (ms)">
              <Input
                required
                value={tickIntervalMs}
                onChange={(event) => setTickIntervalMs(event.target.value)}
              />
            </Field>
            <Field label="Virtual users">
              <Input
                required
                value={virtualUserCount}
                onChange={(event) => setVirtualUserCount(event.target.value)}
              />
            </Field>
            <Field label="Peak rate / second">
              <Input
                required
                value={peakRatePerSecond}
                onChange={(event) => setPeakRatePerSecond(event.target.value)}
              />
            </Field>
            <Field label="Success probability">
              <Input
                required
                value={successProbability}
                onChange={(event) => setSuccessProbability(event.target.value)}
              />
            </Field>
            <Field label="Error probability">
              <Input
                required
                value={errorProbability}
                onChange={(event) => setErrorProbability(event.target.value)}
              />
            </Field>
            <Field label="End" hint="Clear and save to remove the end time.">
              <Input
                type="datetime-local"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
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
                  disabled={locked}
                  checked={selected.includes(account.id)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(account.id)
                        ? current.filter((item) => item !== account.id)
                        : [...current, account.id],
                    )
                  }
                />
                {account.label}
                <span className="text-muted-foreground">{account.vendorType}</span>
              </label>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricEditor value={metrics} onChange={setMetrics} disabled={locked} />
          </CardContent>
        </Card>
        <Button type="submit" disabled={pending !== null}>
          {pending === 'save' ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>Inject a point</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_8rem_auto]"
            onSubmit={(event) => void onInject(event)}
          >
            <Select value={injectId} onChange={(event) => setInjectId(event.target.value)}>
              {job.definitions.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.name}
                </option>
              ))}
            </Select>
            <Input
              inputMode="decimal"
              value={injectValue}
              onChange={(event) => setInjectValue(event.target.value)}
            />
            <Button type="submit" disabled={pending !== null || !injectId}>
              {pending === 'inject' ? 'Injecting…' : 'Inject'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent failures</CardTitle>
        </CardHeader>
        <CardContent>
          {job.failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failures recorded.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {job.failures.map((failure) => (
                <li key={failure.id} className="text-sm">
                  <p className="font-medium">{failure.reason}</p>
                  <p className="text-xs text-muted-foreground">{formatStamp(failure.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
