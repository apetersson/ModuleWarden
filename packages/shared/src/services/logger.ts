/**
 * Minimal structured logger for ModuleWarden.
 *
 * Provides JSON-formatted log output with level, timestamp, message,
 * and optional correlationId. Caters to QUAL-04 (no more silent catch blocks)
 * and OBS-01 (move console.log to structured logging).
 *
 * In production, replace this with pino or another structured logger.
 * This adapter ensures a consistent interface regardless of backend.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  correlationId?: string;
  component?: string;
  error?: string;
  [key: string]: unknown;
}

function formatLog(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...meta,
  };

  if (level === 'error') {
    console.error(formatLog(entry));
  } else if (level === 'warn') {
    console.warn(formatLog(entry));
  } else {
    console.log(formatLog(entry));
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};
