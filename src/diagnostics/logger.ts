import { defaultRedactor, SecretRedactor } from '../security/redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Redactor {
  redactString(text: string): string;
  redactObject(obj: unknown): unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private minLevel: LogLevel = 'info';
  private redactor: Redactor | null = defaultRedactor;
  private destination: (line: string) => void = (line: string) => {
    process.stderr.write(line + '\n');
  };

  constructor(minLevel: LogLevel = 'info', redactor: Redactor | null = defaultRedactor) {
    this.minLevel = minLevel;
    this.redactor = redactor;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  getLevel(): LogLevel {
    return this.minLevel;
  }

  setRedactor(redactor: Redactor | null): void {
    this.redactor = redactor;
  }

  getRedactor(): Redactor | null {
    return this.redactor;
  }

  setDestination(destination: (line: string) => void): void {
    this.destination = destination;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_SEVERITY[level] >= LEVEL_SEVERITY[this.minLevel];
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    let sanitizedMessage = message;
    let sanitizedData: Record<string, unknown> | undefined = data;

    if (this.redactor) {
      sanitizedMessage = this.redactor.redactString(message);
      if (data) {
        sanitizedData = this.redactor.redactObject(data) as Record<string, unknown>;
      }
    }

    const entry: LogEntry = {
      timestamp,
      level,
      message: sanitizedMessage,
      ...(sanitizedData || {}),
    };

    this.destination(JSON.stringify(entry));
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data);
  }
}

export const logger = new Logger('info', defaultRedactor);
