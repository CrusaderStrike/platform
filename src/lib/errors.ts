import { newRequestId } from './crypto.js';

/**
 * Stable API error codes for gear-lists, selection, and items (platform#51).
 * Clients (Web/Addon) key off `error.code` — do not rename existing codes.
 */
export const ERROR_CATALOG = {
  unauthenticated: {
    status: 401,
    retryable: false,
    when: 'No session cookie (or empty); client must sign in.',
  },
  session_expired: {
    status: 401,
    retryable: false,
    when:
      'Session cookie present but expired/revoked/unknown, or stored Blizzard token is invalid/unauthorized; client must clear session and sign in again.',
  },
  csrf_failed: {
    status: 403,
    retryable: false,
    when: 'X-CSRF-Token missing or mismatched on a cookie-authenticated mutating request.',
  },
  validation_error: {
    status: 400,
    retryable: false,
    when: 'Request body/query failed validation (field map in `errors` when present).',
  },
  not_found: {
    status: 404,
    retryable: false,
    when: 'Resource not visible to the caller (or does not exist).',
  },
  forbidden: {
    status: 403,
    retryable: false,
    when: 'Authenticated but not allowed for this resource/action.',
  },
  rate_limited: {
    status: 429,
    retryable: true,
    when: 'Caller exceeded a rate limit; honor Retry-After when present.',
  },
  version_mismatch: {
    status: 409,
    retryable: true,
    when: 'Optimistic concurrency failure; reload current version and retry.',
  },
  character_not_displayed: {
    status: 409,
    retryable: false,
    when: 'Character is not in the user display set; update selection first.',
  },
  list_limit_reached: {
    status: 409,
    retryable: false,
    when: 'Character already has the maximum number of gear lists (20).',
  },
  precondition_required: {
    status: 428,
    retryable: false,
    when: 'If-Match header required for this write.',
  },
  upstream_unavailable: {
    status: 502,
    retryable: true,
    when:
      'Battle.net (or other upstream) 5xx/timeout/unavailable; retry later. Retry-After set when known.',
  },
  payload_too_large: {
    status: 413,
    retryable: false,
    when: 'Request body exceeds the endpoint size limit.',
  },
  unsupported_media_type: {
    status: 415,
    retryable: false,
    when: 'Content-Type must be application/json.',
  },
  internal_error: {
    status: 500,
    retryable: true,
    when: 'Unexpected server failure; safe to retry with backoff (no details leaked).',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type AppErrorOpts = {
  retryable?: boolean;
  /** When set, error handler sends Retry-After (seconds). */
  retryAfterSec?: number;
};

export class AppError extends Error {
  public fields?: Record<string, string>;
  public retryable: boolean;
  public retryAfterSec?: number;

  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    fields?: Record<string, string>,
    opts?: AppErrorOpts,
  ) {
    super(message);
    this.name = 'AppError';
    this.fields = fields;
    const catalog = ERROR_CATALOG[code as ErrorCode];
    this.retryable = opts?.retryable ?? catalog?.retryable ?? statusCode >= 500;
    if (opts?.retryAfterSec !== undefined) {
      this.retryAfterSec = opts.retryAfterSec;
    }
  }
}

/** Canonical `{ error: { code, message, retryable, request_id } }` — no stacks/secrets. */
export function publicErrorBody(
  code: string,
  message: string,
  requestId: string,
  retryable: boolean,
): { error: { code: string; message: string; retryable: boolean; request_id: string } } {
  return {
    error: {
      code,
      message,
      retryable,
      request_id: requestId,
    },
  };
}

export function requestId(): string {
  return newRequestId();
}
