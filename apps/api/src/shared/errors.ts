export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function badRequest(code: string, message: string, details?: unknown): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(code = 'UNAUTHENTICATED', message = 'Authentication is required'): AppError {
  return new AppError(401, code, message);
}

export function forbidden(code = 'FORBIDDEN', message = 'You do not have permission to perform this action'): AppError {
  return new AppError(403, code, message);
}

export function notFound(message = 'The requested resource was not found'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(code = 'CONFLICT', message = 'The request conflicts with current state', details?: unknown): AppError {
  return new AppError(409, code, message, details);
}
