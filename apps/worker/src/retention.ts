import type { Database } from '@fireweave/db';

export const FAILURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function sweepRetention(
  db: Database,
  now = new Date(),
): Promise<{ failures: number; deliveries: number }> {
  const cutoff = new Date(now.getTime() - FAILURE_RETENTION_MS);
  const failures = await db.ingestionFailure.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  const deliveries = await db.ingestionDelivery.deleteMany({
    where: { status: 'dead', createdAt: { lt: cutoff } },
  });
  return { failures: failures.count, deliveries: deliveries.count };
}
