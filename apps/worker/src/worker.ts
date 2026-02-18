import { describeInvocation } from "@draftsman/core";

const DEFAULT_WORKER_POLL_MS = 5000;

export function resolveWorkerPollMs(envValue: string | undefined): number {
  const parsed = Number(envValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WORKER_POLL_MS;
  }

  return parsed;
}

export function getWorkerModeSupportLine(): string {
  return `[worker] mode support: ${describeInvocation()}`;
}

type WorkerRunOptions = {
  pollMs?: number;
  logger?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export async function runWorker(options: WorkerRunOptions = {}) {
  const pollMs = options.pollMs ?? resolveWorkerPollMs(Bun.env.WORKER_POLL_MS);
  const logger = options.logger ?? console.log;
  const sleep = options.sleep ?? Bun.sleep;

  logger("[worker] started");
  logger(getWorkerModeSupportLine());

  while (true) {
    logger("[worker] idle tick");
    await sleep(pollMs);
  }
}

if (import.meta.main) {
  runWorker().catch((error) => {
    console.error("[worker] fatal error", error);
    process.exit(1);
  });
}
