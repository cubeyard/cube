/**
 * cubed's logger: one line per event on stdout — journald captures it, so
 * `journalctl -u cubed` (and `cube diagnose`, which bundles it) is the one
 * place to look. Shape: `level component msg key=value …`. Values with
 * whitespace, quotes or `=` are JSON-quoted, so a line stays a line and
 * `grep thread=t-…` finds every event of one thread. An Error-valued field
 * logs as `key=<message>`; its stack rides along as `stack=` on error-level
 * lines and, at CUBED_LOG_LEVEL=debug, on every line. Zero dependencies.
 *
 *   const log = createLogger("api");
 *   log.info("listening", { port: 7777 });
 *   log.child({ thread: id }).warn("pi exited", { code });
 *
 * CUBED_LOG_LEVEL: debug | info (default) | warn | error.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Same component and sink; `fields` lead every line, a call's own may override. */
  child(fields: LogFields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Read per line, not at import: tests (and a restart-free tweak via
 * systemd's environment) must see the current value. */
function threshold(): number {
  const raw = process.env.CUBED_LOG_LEVEL?.toLowerCase();
  return raw !== undefined && raw in RANK ? RANK[raw as LogLevel] : RANK.info;
}

const stdout = (line: string) => void process.stdout.write(line);

export function createLogger(component: string, sink: (line: string) => void = stdout): Logger {
  return make(component, {}, sink);
}

function make(component: string, bound: LogFields, sink: (line: string) => void): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    const min = threshold();
    if (RANK[level] < min) return;
    const withStack = level === "error" || min === RANK.debug;
    sink(formatLine(level, component, msg, { ...bound, ...fields }, withStack));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => make(component, { ...bound, ...fields }, sink),
  };
}

function formatLine(level: LogLevel, component: string, msg: string, fields: LogFields, withStack: boolean): string {
  let line = `${level} ${component} ${msg}`;
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if (raw instanceof Error) {
      line += ` ${key}=${quote(raw.message)}`;
      if (withStack && raw.stack) line += ` stack=${quote(raw.stack)}`;
      continue;
    }
    line += ` ${key}=${quote(stringify(raw))}`;
  }
  return `${line}\n`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Bare when it is one plain token; JSON-quoted (escaped newlines included)
 * otherwise, so the line stays one line and `key=` splits unambiguously. */
function quote(value: string): string {
  return value !== "" && !/[\s"=\\\x00-\x1f\x7f]/.test(value) ? value : JSON.stringify(value);
}
