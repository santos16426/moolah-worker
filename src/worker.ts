import { randomUUID } from "node:crypto";
import type { WorkerConfig } from "./config.js";
import type { WorkerLogger } from "./logger.js";

export interface AutoPostResult {
  examined: number;
  posted: number;
  disabled: number;
  skipped: number;
  capped: boolean;
}

export interface WorkerDependencies {
  fetch: typeof globalThis.fetch;
  logger: WorkerLogger;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  createRunId: () => string;
}

export class AutoPostWorkerError extends Error {
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly apiErrorCode: string | undefined;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      retryAfterMs?: number;
      apiErrorCode?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AutoPostWorkerError";
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.apiErrorCode = options.apiErrorCode;
  }
}

const defaultDependencies: WorkerDependencies = {
  fetch: globalThis.fetch,
  logger: {
    info: () => undefined,
    error: () => undefined,
  },
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: Math.random,
  createRunId: randomUUID,
};

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 30_000);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.min(Math.max(dateMs - Date.now(), 0), 30_000);
}

async function readApiErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      !isRecord(body.error) ||
      typeof body.error.code !== "string" ||
      !/^[A-Z0-9_]{1,64}$/.test(body.error.code)
    ) {
      return undefined;
    }
    return body.error.code;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isAutoPostResult(value: unknown): value is AutoPostResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.examined === "number" &&
    typeof value.posted === "number" &&
    typeof value.disabled === "number" &&
    typeof value.skipped === "number" &&
    typeof value.capped === "boolean"
  );
}

async function executeAttempt(
  config: WorkerConfig,
  runId: string,
  attempt: number,
  fetchImplementation: typeof globalThis.fetch
): Promise<AutoPostResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImplementation(config.endpointUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.secret}`,
        "User-Agent": "moolah-auto-post-worker/0.1.0",
        "X-Request-Id": `${runId}-${attempt}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after")
      );
      const apiErrorCode = await readApiErrorCode(response);
      throw new AutoPostWorkerError(
        `Moolah API returned HTTP ${response.status}`,
        {
          statusCode: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(apiErrorCode !== undefined ? { apiErrorCode } : {}),
        }
      );
    }

    const body: unknown = await response.json();
    if (!isRecord(body) || !isAutoPostResult(body.result)) {
      throw new AutoPostWorkerError("Moolah API returned an invalid response");
    }
    return body.result;
  } catch (error) {
    if (error instanceof AutoPostWorkerError) throw error;
    if (controller.signal.aborted) {
      throw new AutoPostWorkerError(
        `Moolah API request timed out after ${config.timeoutMs}ms`
      );
    }
    throw new AutoPostWorkerError("Moolah API request failed", {
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryable(error: AutoPostWorkerError): boolean {
  return (
    error.statusCode === undefined ||
    error.statusCode === 429 ||
    error.statusCode >= 500
  );
}

function retryDelayMs(
  attempt: number,
  random: () => number,
  retryAfterMs: number | undefined
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exponentialMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
  return Math.round(exponentialMs * (0.75 + random() * 0.5));
}

export async function runAutoPostWorker(
  config: WorkerConfig,
  overrides: Partial<WorkerDependencies> = {}
): Promise<AutoPostResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const runId = dependencies.createRunId();
  const startedAt = Date.now();

  dependencies.logger.info("auto_post_started", {
    runId,
    apiOrigin: new URL(config.endpointUrl).origin,
    maxAttempts: config.maxAttempts,
  });

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const result = await executeAttempt(
        config,
        runId,
        attempt,
        dependencies.fetch
      );
      dependencies.logger.info("auto_post_completed", {
        runId,
        attempt,
        durationMs: Date.now() - startedAt,
        ...result,
      });
      return result;
    } catch (error) {
      const workerError =
        error instanceof AutoPostWorkerError
          ? error
          : new AutoPostWorkerError("Unexpected worker failure");
      const hasNextAttempt = attempt < config.maxAttempts;

      if (!hasNextAttempt || !isRetryable(workerError)) {
        dependencies.logger.error("auto_post_failed", {
          runId,
          attempt,
          durationMs: Date.now() - startedAt,
          statusCode: workerError.statusCode,
          apiErrorCode: workerError.apiErrorCode,
          message: workerError.message,
        });
        throw workerError;
      }

      const delayMs = retryDelayMs(
        attempt,
        dependencies.random,
        workerError.retryAfterMs
      );
      dependencies.logger.info("auto_post_retrying", {
        runId,
        attempt,
        delayMs,
        statusCode: workerError.statusCode,
      });
      await dependencies.sleep(delayMs);
    }
  }

  throw new AutoPostWorkerError("Worker exhausted without a result");
}
