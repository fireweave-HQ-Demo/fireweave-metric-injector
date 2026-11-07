import { Badge } from '@/components/ui/badge';
import type { JobStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const styles: Record<JobStatus, string> = {
  scheduled: 'border-stone-300 bg-stone-100 text-stone-700',
  active: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  paused: 'border-amber-300 bg-amber-50 text-amber-900',
  completed: 'border-sky-300 bg-sky-50 text-sky-900',
  failed: 'border-red-300 bg-red-50 text-red-800',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <Badge className={cn('capitalize', styles[status])}>{status}</Badge>;
}
