import { logRedact } from '@fireweave/core';
import pino, { type DestinationStream } from 'pino';

function buildLogger(stream?: DestinationStream) {
  return pino(
    {
      redact: logRedact,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  );
}

let logger = buildLogger();

export function useWorkerLogStream(stream: DestinationStream): void {
  logger = buildLogger(stream);
}

export function resetWorkerLog(): void {
  logger = buildLogger();
}

export function logEvent(fields: Record<string, unknown>, message: string): void {
  logger.info(fields, message);
}

export function workerLog(
  fields: { jobId?: string; batchId?: string; vendorAccountId?: string },
  message: string,
): void {
  logEvent(fields, message);
}
