export interface WorkerConfig {
  endpointUrl: string;
  secret: string;
  timeoutMs: number;
  maxAttempts: number;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`
    );
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  const apiUrl = env.MOOLAH_API_URL?.trim();
  if (!apiUrl) throw new Error("MOOLAH_API_URL is required");

  const parsedUrl = new URL(apiUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("MOOLAH_API_URL must use http or https");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("MOOLAH_API_URL must not contain credentials");
  }
  if (
    env.NODE_ENV === "production" &&
    parsedUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(parsedUrl.hostname)
  ) {
    throw new Error("MOOLAH_API_URL must use https in production");
  }

  const secret = env.AUTO_POST_WORKER_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTO_POST_WORKER_SECRET must be at least 32 characters"
    );
  }

  const baseUrl = parsedUrl.toString().replace(/\/$/, "");
  return {
    endpointUrl: `${baseUrl}/internal/jobs/recurring-auto-post`,
    secret,
    timeoutMs: positiveInteger(
      env.WORKER_TIMEOUT_MS,
      15_000,
      "WORKER_TIMEOUT_MS",
      120_000
    ),
    maxAttempts: positiveInteger(
      env.WORKER_MAX_ATTEMPTS,
      3,
      "WORKER_MAX_ATTEMPTS",
      5
    ),
  };
}
