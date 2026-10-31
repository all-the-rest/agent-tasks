export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'limit_exceeded'
  | 'provider_unavailable'
  | 'network_blocked'
  | 'internal';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(what = 'resource'): AppError {
    return new AppError('not_found', `${what} not found`, 404);
  }

  static forbidden(message = 'not allowed'): AppError {
    return new AppError('forbidden', message, 403);
  }

  static unauthorized(message = 'authentication required'): AppError {
    return new AppError('unauthorized', message, 401);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('bad_request', message, 400, details);
  }

  static conflict(message: string): AppError {
    return new AppError('conflict', message, 409);
  }

  static limitExceeded(message: string): AppError {
    return new AppError('limit_exceeded', message, 429);
  }
}

export function toPublicError(error: unknown): { code: ErrorCode; message: string; details?: unknown } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'internal', message: 'internal server error' };
}
