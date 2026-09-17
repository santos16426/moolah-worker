import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  MOOLAH_API_URL: "https://api.example.test/",
  AUTO_POST_WORKER_SECRET: "test-secret-with-at-least-32-characters",
};

describe("loadConfig", () => {
  it("builds the internal endpoint with bounded defaults", () => {
    assert.deepEqual(loadConfig(BASE_ENV), {
      endpointUrl:
        "https://api.example.test/internal/jobs/recurring-auto-post",
      secret: BASE_ENV.AUTO_POST_WORKER_SECRET,
      timeoutMs: 15_000,
      maxAttempts: 3,
    });
  });

  it("requires HTTPS for non-local production APIs", () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE_ENV,
          NODE_ENV: "production",
          MOOLAH_API_URL: "http://api.example.test",
        }),
      /https/
    );
  });

  it("rejects excessive retry and timeout settings", () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_MAX_ATTEMPTS: "100" }),
      /no greater than 5/
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_TIMEOUT_MS: "999999" }),
      /no greater than 120000/
    );
  });
});
