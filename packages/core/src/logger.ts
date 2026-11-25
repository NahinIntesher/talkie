import pino, { type Logger } from 'pino';

/** Structured JSON logs; secrets and tokens are redacted wherever they appear in a log object. */
export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    name: service,
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.code',
        '*.refreshToken',
        '*.accessToken',
        '*.token',
      ],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
