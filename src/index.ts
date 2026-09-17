import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { runAutoPostWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runAutoPostWorker(config, { logger });
}

main().catch((error: Error) => {
  logger.error("worker_exited", {
    message: error.message,
  });
  process.exitCode = 1;
});
