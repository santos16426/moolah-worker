export interface LogFields {
  [key: string]: boolean | number | string | null | undefined;
}

export interface WorkerLogger {
  info: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
}

function writeLog(
  level: "info" | "error",
  event: string,
  fields: LogFields = {}
): void {
  const line = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logger: WorkerLogger = {
  info: (event, fields) => writeLog("info", event, fields),
  error: (event, fields) => writeLog("error", event, fields),
};
