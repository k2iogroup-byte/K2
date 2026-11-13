import type { ApiErrorBody, ApiErrorCode, ApiErrorDetail } from '@k2/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { redactSensitiveText } from '../logging/redact.js';

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: readonly ApiErrorDetail[] | undefined;
  readonly expose: boolean;

  constructor(
    code: ApiErrorCode,
    statusCode: number,
    message: string,
    details?: readonly ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.expose = true;
  }
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    reply.header('x-request-id', requestId);
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send(errorBody(error.code, error.message, requestId, error.details));
    }
    const statusCode = clientStatusCode(error);
    if (statusCode === 413) {
      return reply
        .status(413)
        .send(errorBody('PAYLOAD_TOO_LARGE', 'Request payload is too large', requestId));
    }
    if (statusCode !== undefined) {
      return reply
        .status(statusCode)
        .send(errorBody('VALIDATION_ERROR', 'Invalid request', requestId));
    }
    request.log.error(
      {
        event: 'unhandled_error',
        name: error.name,
        message: redactSensitiveText(error.message),
      },
      'unhandled error',
    );
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error', requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    const requestId = request.id;
    reply.header('x-request-id', requestId);
    return reply.status(404).send(errorBody('NOT_FOUND', 'Not found', requestId));
  });
}

function errorBody(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: readonly ApiErrorDetail[],
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details === undefined ? {} : { details: [...details] }),
    },
  };
}

function clientStatusCode(error: FastifyError): number | undefined {
  if (typeof error.statusCode !== 'number') return undefined;
  if (error.statusCode >= 400 && error.statusCode < 500) return error.statusCode;
  return undefined;
}
