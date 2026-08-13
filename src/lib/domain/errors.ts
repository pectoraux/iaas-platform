// =============================================================================
// Domain error hierarchy. Explicit error classes so controllers can map to
// HTTP status without leaking business logic.
// =============================================================================

export class DomainError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 422, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFLICT', 409, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden: tenant isolation violated') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class IdempotencyReplayError extends DomainError {
  constructor(message: string) {
    super(message, 'IDEMPOTENCY_REPLAY', 200);
  }
}

export class ImmutableResourceError extends DomainError {
  constructor(message: string) {
    super(message, 'IMMUTABLE_RESOURCE', 409);
  }
}

export class VerificationFailedError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'VERIFICATION_FAILED', 422, details);
  }
}

export class PaymentError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'PAYMENT_ERROR', 502, details);
  }
}

/** Map a thrown value to a JSON-serialisable API error body. */
export function toApiError(err: unknown) {
  if (err instanceof DomainError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      statusCode: err.statusCode,
    };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Unknown error',
    },
    statusCode: 500,
  };
}
