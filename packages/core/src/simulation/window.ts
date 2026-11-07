export type SimulationWindow = {
  windowStart: Date;
  windowEnd: Date;
  lagging: boolean;
  lagSeconds: number;
  consecutiveLagTicks: number;
  autoFail: boolean;
};

export function resolveWindow(input: {
  now: Date;
  tickIntervalMs: number;
  lastSimulatedAt: Date | null;
  consecutiveLagTicks: number;
}): SimulationWindow {
  const delta = input.tickIntervalMs;
  let windowStart = input.now;
  let lagging = false;
  let lagSeconds = 0;
  if (input.lastSimulatedAt) {
    const behindMs = input.now.getTime() - input.lastSimulatedAt.getTime();
    if (behindMs > delta) {
      lagging = true;
      lagSeconds = behindMs / 1000;
      windowStart = input.now;
    } else {
      windowStart = input.lastSimulatedAt;
    }
  }
  const consecutiveLagTicks = lagSeconds > 30 ? input.consecutiveLagTicks + 1 : 0;
  return {
    windowStart,
    windowEnd: new Date(windowStart.getTime() + delta),
    lagging,
    lagSeconds,
    consecutiveLagTicks,
    autoFail: consecutiveLagTicks >= 3,
  };
}
