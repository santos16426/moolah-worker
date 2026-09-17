import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkerConfig } from "./config.js";
import type { WorkerLogger } from "./logger.js";
import {
  AutoPostWorkerError,
  type AutoPostResult,
  runAutoPostWorker,
} from "./worker.js";

const RESULT: AutoPostResult = {
  examined: 2,
  posted: 1,
  disabled: 0,
  skipped: 1,
  capped: false,
};

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    endpointUrl:
      "https://api.example.test/internal/jobs/recurring-auto-post",
    secret: "test-secret-with-at-least-32-characters",
    timeoutMs: 100,
    maxAttempts: 3,
    ...overrides,
  };
}

function response(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function quietLogger(): WorkerLogger {
  return {
    info: () => undefined,
    error: () => undefined,
  };
}

describe("runAutoPostWorker", () => {
  it("calls the API with bearer authentication and returns its result", async () => {
    let authorization = "";
    async function fetchSuccess(
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return response(200, { result: RESULT });
    }

    const result = await runAutoPostWorker(config(), {
      fetch: fetchSuccess,
      logger: quietLogger(),
      createRunId: () => "run-1",
    });

    assert.deepEqual(result, RESULT);
    assert.equal(
      authorization,
      "Bearer test-secret-with-at-least-32-characters"
    );
  });

  it("retries transient server failures and then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    async function fetchTransient(): Promise<Response> {
      calls += 1;
      return calls === 1
        ? response(503, { error: "unavailable" })
        : response(200, { result: RESULT });
    }

    const result = await runAutoPostWorker(config(), {
      fetch: fetchTransient,
      logger: quietLogger(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      random: () => 0,
    });

    assert.deepEqual(result, RESULT);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [375]);
  });

  it("honors a bounded Retry-After value for rate limiting", async () => {
    let calls = 0;
    const delays: number[] = [];
    async function fetchRateLimited(): Promise<Response> {
      calls += 1;
      return calls === 1
        ? response(429, {}, { "Retry-After": "2" })
        : response(200, { result: RESULT });
    }

    await runAutoPostWorker(config(), {
      fetch: fetchRateLimited,
      logger: quietLogger(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    assert.deepEqual(delays, [2_000]);
  });

  it("does not retry rejected credentials", async () => {
    let calls = 0;
    let slept = false;
    async function fetchUnauthorized(): Promise<Response> {
      calls += 1;
      return response(401, { error: "unauthorized" });
    }

    await assert.rejects(
      () =>
        runAutoPostWorker(config(), {
          fetch: fetchUnauthorized,
          logger: quietLogger(),
          sleep: async () => {
            slept = true;
          },
        }),
      (error: unknown) =>
        error instanceof AutoPostWorkerError && error.statusCode === 401
    );
    assert.equal(calls, 1);
    assert.equal(slept, false);
  });

  it("aborts a timed-out request and exits with an error", async () => {
    async function fetchUntilAbort(
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }

    await assert.rejects(
      () =>
        runAutoPostWorker(config({ timeoutMs: 5, maxAttempts: 1 }), {
          fetch: fetchUntilAbort,
          logger: quietLogger(),
        }),
      /timed out/
    );
  });

  it("fails after the configured number of network attempts", async () => {
    let calls = 0;
    async function fetchFailure(): Promise<Response> {
      calls += 1;
      throw new Error("network down");
    }

    await assert.rejects(
      () =>
        runAutoPostWorker(config({ maxAttempts: 2 }), {
          fetch: fetchFailure,
          logger: quietLogger(),
          sleep: async () => undefined,
        }),
      /request failed/
    );
    assert.equal(calls, 2);
  });
});
