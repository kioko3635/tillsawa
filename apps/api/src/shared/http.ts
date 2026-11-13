import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

export function sendData(res: Response, data: unknown, status = 200, meta: Record<string, unknown> = {}): void {
  res.status(status).json({
    data,
    meta: {
      requestId: res.locals.requestId ?? randomUUID(),
      ...meta
    }
  });
}

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.flatten()));
      return;
    }
    req.body = result.data;
    next();
  };
}
