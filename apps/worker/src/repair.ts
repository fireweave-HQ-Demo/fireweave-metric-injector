import type { Database } from '@fireweave/db';

export async function repairOnStartup(db: Database, now = new Date()): Promise<void> {
  const jobs = await db.ingestionJob.findMany({
    where: { deletedAt: null },
    select: { id: true, tickIntervalMs: true },
  });
  for (const job of jobs) {
    const staleBefore = new Date(now.getTime() - 2 * job.tickIntervalMs);
    const stale = await db.ingestionBatch.findMany({
      where: { jobId: job.id, status: 'in_flight', createdAt: { lt: staleBefore } },
      select: { id: true },
    });
    if (stale.length > 0) {
      const ids = stale.map((batch) => batch.id);
      await db.ingestionBatch.updateMany({
        where: { id: { in: ids } },
        data: { status: 'abandoned', completedAt: now },
      });
      await db.ingestionDelivery.updateMany({
        where: { batchId: { in: ids }, status: 'pending' },
        data: { status: 'dead', error: 'abandoned' },
      });
    }
    const latest = await db.ingestionBatch.findFirst({
      where: { jobId: job.id, status: { in: ['abandoned', 'completed'] } },
      orderBy: { windowEnd: 'desc' },
    });
    if (!latest) {
      continue;
    }
    await db.ingestionJob.updateMany({
      where: {
        id: job.id,
        OR: [{ lastSimulatedAt: null }, { lastSimulatedAt: { lt: latest.windowEnd } }],
      },
      data: { lastSimulatedAt: latest.windowEnd },
    });
  }
}
