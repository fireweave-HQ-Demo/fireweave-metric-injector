'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '@/components/shell';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { formatStamp } from '@/lib/time';
import type { JobSummary, Page } from '@/lib/types';
import { useAuth } from '@/components/auth-provider';

export default function JobsPage() {
  return (
    <Shell>
      <JobsScreen />
    </Shell>
  );
}

function JobsScreen() {
  const auth = useAuth();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const page = await auth.call<Page<JobSummary>>('/api/v1/jobs');
    setJobs(page.items);
    setLoading(false);
  }, [auth]);

  useEffect(() => {
    if (auth.status !== 'ready') {
      return;
    }
    void load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not load jobs');
      setLoading(false);
    });
  }, [auth.status, load]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Simulated traffic sent to your vendor accounts.
          </p>
        </div>
        <Button asChild>
          <Link href="/jobs/new">New job</Link>
        </Button>
      </div>
      {error ? <Alert className="mt-4">{error}</Alert> : null}
      {loading ? <p className="mt-6 text-sm text-muted-foreground">Loading jobs…</p> : null}
      {!loading && jobs.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No jobs yet. Create one after a vendor account exists.
        </p>
      ) : null}
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/jobs/${job.id}`}
              className="flex flex-col gap-2 px-4 py-3 hover:bg-accent sm:flex-row sm:items-center"
            >
              <span className="font-medium">{job.name}</span>
              <StatusBadge status={job.status} />
              <span className="text-sm text-muted-foreground sm:ml-auto">
                Updated {formatStamp(job.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
