export type CauceErrorCode =
  | 'INVALID_CONFIG'
  | 'UNSUPPORTED_CHAIN'
  | 'INVALID_AMOUNT'
  | 'INVALID_HOOK_DATA'
  | 'INVALID_CCTP_MESSAGE'
  | 'INVALID_TRANSITION'
  | 'USER_REJECTED'
  | 'TX_REVERTED'
  | 'IRIS_HTTP'
  | 'IRIS_TIMEOUT'
  | 'ATTESTATION_TIMEOUT'
  | 'RELAYER_HTTP'
  | 'RELAY_FAILED'
  | 'ABORTED';

export interface CauceErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

/** The single error type thrown by Cauce. Branch on `code`, never on `message`. */
export class CauceError extends Error {
  override readonly name = 'CauceError';
  readonly code: CauceErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CauceErrorCode, message: string, options: CauceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details;
  }
}

export function isCauceError(error: unknown, code?: CauceErrorCode): error is CauceError {
  return error instanceof CauceError && (code === undefined || error.code === code);
}

/** Normalizes anything thrown into a CauceError, keeping the original as `cause`. */
export function toCauceError(error: unknown, fallback: CauceErrorCode): CauceError {
  if (error instanceof CauceError) return error;
  if (isAbortError(error))
    return new CauceError('ABORTED', 'The operation was aborted', { cause: error });
  if (isUserRejection(error)) {
    return new CauceError('USER_REJECTED', 'The request was rejected in the wallet', {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CauceError(fallback, message, { cause: error });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isUserRejection(error: unknown): boolean {
  // viem's UserRejectedRequestError (EIP-1193 code 4001), possibly wrapped by a contract error.
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: unknown }).code === 4001) return true;
    if (current.name === 'UserRejectedRequestError') return true;
    current = current.cause;
  }
  return false;
}
