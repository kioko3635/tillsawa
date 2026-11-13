import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppError } from '../../shared/errors.js';
import { ZodError } from 'zod';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.header('x-request-id') ?? randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'The requested API route was not found',
      requestId: res.locals.requestId
    }
  });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const requestId = res.locals.requestId;
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.flatten(),
        requestId
      }
    });
    return;
  }

  const appError = error as Partial<AppError>;
  const statusCode = typeof appError.statusCode === 'number' ? appError.statusCode : 500;
  const code = typeof appError.code === 'string' ? appError.code : 'INTERNAL_ERROR';
  const message = statusCode === 500 ? 'An unexpected error occurred' : appError.message ?? 'Request failed';
  if (statusCode === 500) {
    console.error({ requestId, error });
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      requestId
    }
  });
}
