const WEEKDAY = 1;
const WEEKEND = 0.45;
const RAMP_MINUTES = 120;

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function diurnal(hour: number): number {
  return 0.15 + 0.85 * (bump(hour) / bump(14));
}

export function weekendBlend(at: Date, timeZone: string): number {
  const clock = localClock(at, timeZone);
  const minutes = clock.hour * 60 + clock.minute + clock.second / 60 + clock.millisecond / 60_000;
  if (clock.weekday === 5 && minutes >= 23 * 60) {
    return lerp(WEEKDAY, WEEKEND, (minutes - 23 * 60) / RAMP_MINUTES);
  }
  if (clock.weekday === 6 && minutes < 60) {
    return lerp(WEEKDAY, WEEKEND, (60 + minutes) / RAMP_MINUTES);
  }
  if (clock.weekday === 0 && minutes >= 23 * 60) {
    return lerp(WEEKEND, WEEKDAY, (minutes - 23 * 60) / RAMP_MINUTES);
  }
  if (clock.weekday === 1 && minutes < 60) {
    return lerp(WEEKEND, WEEKDAY, (60 + minutes) / RAMP_MINUTES);
  }
  if (clock.weekday === 6 || clock.weekday === 0) {
    return WEEKEND;
  }
  return WEEKDAY;
}

export function localHour(at: Date, timeZone: string): number {
  const clock = localClock(at, timeZone);
  return clock.hour + clock.minute / 60 + clock.second / 3600 + clock.millisecond / 3_600_000;
}

export function instantaneousRate(input: {
  at: Date;
  timeZone: string;
  peakRatePerSecond: number;
  multiplier: number;
}): number {
  return (
    input.peakRatePerSecond *
    diurnal(localHour(input.at, input.timeZone)) *
    weekendBlend(input.at, input.timeZone) *
    input.multiplier
  );
}

function bump(hour: number): number {
  let total = 0;
  for (const shift of [-1, 0, 1]) {
    const distance = hour - 14 + 24 * shift;
    total += Math.exp(-(distance * distance) / 24.5);
  }
  return total;
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function localClock(
  at: Date,
  timeZone: string,
): {
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    fractionalSecondDigits: 3,
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAYS[value('weekday')];
  if (weekday === undefined) {
    throw new Error(`Unable to read the local weekday for ${timeZone}`);
  }
  let hour = Number(value('hour'));
  if (hour === 24) {
    hour = 0;
  }
  return {
    weekday,
    hour,
    minute: Number(value('minute')),
    second: Number(value('second')),
    millisecond: Number(value('fractionalSecond') || '0'),
  };
}
