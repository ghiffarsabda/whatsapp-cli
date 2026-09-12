export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  usage: 2,
  not_logged_in: 3,
  daemon_unreachable: 4,
  not_found: 5,
  ambiguous: 5,
  send_failed: 6,
  timeout: 7,
} as const

export type ErrorCode = keyof typeof EXIT_CODES

export interface ErrorPayload {
  code: ErrorCode
  message: string
  hint?: string
  /** Machine-readable context, e.g. ambiguous chat candidates. */
  details?: unknown
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, options: { hint?: string; details?: unknown } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.hint = options.hint
    this.details = options.details
  }

  get exitCode(): number {
    return EXIT_CODES[this.code]
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: this.message }
    if (this.hint !== undefined) payload.hint = this.hint
    if (this.details !== undefined) payload.details = this.details
    return payload
  }
}

export const usage = (message: string, hint?: string) => new AppError('usage', message, { hint })

export const notLoggedIn = () =>
  new AppError('not_logged_in', 'Not logged in to WhatsApp', {
    hint: 'Run `wa login` to link this device.',
  })

export const daemonUnreachable = (message: string, hint?: string) =>
  new AppError('daemon_unreachable', message, { hint })

export const notFound = (message: string, hint?: string) => new AppError('not_found', message, { hint })

export const ambiguity = (message: string, details: unknown) =>
  new AppError('ambiguous', message, {
    hint: 'Re-run with the full JID shown in details.candidates.',
    details,
  })

export const sendFailed = (message: string, hint?: string) => new AppError('send_failed', message, { hint })

export const timedOut = (message: string, hint?: string) => new AppError('timeout', message, { hint })

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isAppError(error)) return error.toPayload()
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'internal', message }
}

export function exitCodeFor(error: unknown): number {
  return isAppError(error) ? error.exitCode : EXIT_CODES.internal
}
