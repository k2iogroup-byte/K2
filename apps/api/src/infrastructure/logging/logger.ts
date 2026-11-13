import { type Logger, type LoggerOptions, pino } from 'pino';

import type { AppConfig } from '../../config/env.js';
import { REDACT_CENSOR, REDACT_PATHS } from './redact.js';

type RequestLog = {
  method?: string;
  url?: string;
  id?: string;
};

type ResponseLog = {
  statusCode?: number;
};

export function loggerOptions(config: Pick<AppConfig, 'logLevel' | 'serviceName'>): LoggerOptions {
  return {
    level: config.logLevel,
    base: { service: config.serviceName },
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      req(request: RequestLog) {
        const url = typeof request.url === 'string' ? request.url.split('?')[0] : undefined;
        return { method: request.method, url, requestId: request.id };
      },
      res(reply: ResponseLog) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}

export function createLogger(
  config: Pick<AppConfig, 'logLevel' | 'serviceName'>,
  destination?: pino.DestinationStream,
): Logger {
  return destination ? pino(loggerOptions(config), destination) : pino(loggerOptions(config));
}
