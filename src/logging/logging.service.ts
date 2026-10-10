import { Injectable, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';

const { combine, timestamp, printf, colorize, json } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, context }) => {
  const ctx = context ? ` [${context}]` : '';
  return `${ts} ${level.toUpperCase()}${ctx}: ${message}`;
});

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    pattern: /\bsk_(?:test|live)_[A-Za-z0-9]{8,}\b/g,
    replacement: '[REDACTED_STRIPE_SECRET]',
  },
  {
    pattern: /\brk_(?:test|live)_[A-Za-z0-9]{8,}\b/g,
    replacement: '[REDACTED_STRIPE_SECRET]',
  },
  {
    pattern: /\bwhsec_[A-Za-z0-9]{8,}\b/g,
    replacement: '[REDACTED_STRIPE_WEBHOOK_SECRET]',
  },
  {
    pattern: /\brefresh[_ -]?token\b[:=]\s*[^\s,;]+/gi,
    replacement: 'refresh token=[REDACTED]',
  },
  {
    pattern: /\bpassword\b[:=]\s*[^\s,;]+/gi,
    replacement: 'password=[REDACTED]',
  },
];

@Injectable()
export class LoggingService implements LoggerService {
  private readonly logger: winston.Logger;

  constructor(config: ConfigService) {
    const logsDir = path.resolve(process.cwd(), 'logs');
    let fileLoggingAvailable = true;
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch (err) {
      fileLoggingAvailable = false;
      console.error(
        `Could not create logs directory "${logsDir}", falling back to console-only logging: ${(err as Error).message}`,
      );
    }

    const isProduction = config.get('NODE_ENV') === 'production';

    this.logger = winston.createLogger({
      level: isProduction ? 'info' : 'debug',
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        isProduction ? json() : combine(colorize({ all: false }), consoleFormat),
      ),
      transports: [
        new winston.transports.Console(),
        ...(fileLoggingAvailable
          ? [
              new winston.transports.File({ filename: path.join(logsDir, 'combined.log') }),
              new winston.transports.File({
                filename: path.join(logsDir, 'error.log'),
                level: 'error',
              }),
            ]
          : []),
      ],
    });
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(this.formatMessage(message, optionalParams));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(this.formatMessage(message, optionalParams));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(this.formatMessage(message, optionalParams));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(this.formatMessage(message, optionalParams));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.verbose(this.formatMessage(message, optionalParams));
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(`FATAL ${this.formatMessage(message, optionalParams)}`);
  }

  private formatMessage(message: unknown, optionalParams: unknown[]): string {
    if (optionalParams.length === 0) {
      return this.redact(String(message));
    }
    return this.redact(`${String(message)} ${optionalParams.join(' ')}`);
  }

  private redact(message: string): string {
    let result = message;
    for (const { pattern, replacement } of SECRET_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }
}
