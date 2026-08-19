type LogLevel = "info" | "warn" | "error";

export function redactIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 12) return "[redacted]";
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export function safeLog(
  level: LogLevel,
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const entry = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });

  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}
