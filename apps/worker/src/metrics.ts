import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Database } from '@fireweave/db';
import { workerCounters } from './counters.js';

export const registry = new Registry();

const jobsActive = new Gauge({
  name: 'ingestion_jobs_active',
  help: 'Ingestion jobs currently active',
  registers: [registry],
});

const metricsSent = new Counter({
  name: 'metrics_sent_total',
  help: 'Metric points accepted by a vendor',
  registers: [registry],
});

const vendorErrors = new Counter({
  name: 'vendor_errors_total',
  help: 'Vendor deliveries that ended dead',
  registers: [registry],
});

const tickDuration = new Histogram({
  name: 'simulation_tick_duration_ms',
  help: 'Tick duration from lock to completion',
  buckets: [50, 100, 250, 500, 800, 1000, 5000, 10_000],
  registers: [registry],
});

const lagSeconds = new Gauge({
  name: 'simulation_lag_seconds',
  help: 'Lag of the most recent tick',
  registers: [registry],
});

const deadlineExceeded = new Counter({
  name: 'tick_deadline_exceeded_total',
  help: 'Ticks that hit the send deadline',
  registers: [registry],
});

const lockLost = new Counter({
  name: 'tick_lock_lost_total',
  help: 'Tick locks that were no longer owned at release',
  registers: [registry],
});

export function recordMetricsSent(count: number): void {
  if (count > 0) {
    metricsSent.inc(count);
  }
}

export function recordVendorError(count = 1): void {
  if (count > 0) {
    vendorErrors.inc(count);
  }
}

export function recordTick(durationMs: number, lag: number): void {
  tickDuration.observe(durationMs);
  lagSeconds.set(lag);
}

export function recordDeadlineExceeded(): void {
  workerCounters.tick_deadline_exceeded_total += 1;
  deadlineExceeded.inc();
}

export function recordLockLost(): void {
  workerCounters.tick_lock_lost_total += 1;
  lockLost.inc();
}

export async function renderMetrics(db: Database): Promise<string> {
  const active = await db.ingestionJob.count({ where: { status: 'active', deletedAt: null } });
  jobsActive.set(active);
  return registry.metrics();
}

export function startWorkerMetrics(db: Database, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.url !== '/metrics') {
      response.writeHead(404);
      response.end();
      return;
    }
    renderMetrics(db)
      .then((body) => {
        response.writeHead(200, { 'content-type': registry.contentType });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
