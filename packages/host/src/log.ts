/** One-line timestamped logger shared across host modules. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFn = (level: LogLevel, msg: string, data?: unknown) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const KNOWN_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
let minLevel: LogLevel = envLevel !== undefined && KNOWN_LEVELS.includes(envLevel) ? envLevel : 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function fmt(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return ' ' + data;
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' [unserializable]';
  }
}

export const log: LogFn = (level, msg, data) => {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}${fmt(data)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};
