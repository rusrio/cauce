export interface CauceLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noop = (): void => undefined;

/** Default logger: Cauce never writes to the console unless you inject a logger. */
export const silentLogger: CauceLogger = { debug: noop, info: noop, warn: noop, error: noop };
