export const workerCounters = {
  tick_deadline_exceeded_total: 0,
  tick_lock_lost_total: 0,
};

export function resetWorkerCounters(): void {
  workerCounters.tick_deadline_exceeded_total = 0;
  workerCounters.tick_lock_lost_total = 0;
}
