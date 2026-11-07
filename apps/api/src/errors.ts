export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'MFA_REQUIRED'
  | 'MFA_INVALID'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'ACCOUNT_DISABLED'
  | 'TOO_MANY_ATTEMPTS'
  | 'CSRF_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'WALLET_INSUFFICIENT'
  | 'WALLET_FROZEN'
  | 'WALLET_INACTIVE'
  | 'BRANCH_SUSPENDED'
  | 'GATEWAY_ERROR'
  | 'INTERNAL';

/** The only error type services throw on purpose; anything else becomes INTERNAL with the request id. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission for this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError(409, 'CONFLICT', message, details);
export const unauthenticated = (message = 'Sign in required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const tooMany = (retryAfterSecs: number) =>
  new AppError(
    429,
    'TOO_MANY_ATTEMPTS',
    'Too many attempts. Try again later.',
    { retryAfterSecs },
    {
      'retry-after': String(retryAfterSecs),
    },
  );
