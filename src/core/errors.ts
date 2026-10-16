/**
 * Errors and exit codes shared by the CLI and the MCP server.
 *
 * Exit codes are part of the CLI's contract (CI scripts branch on them), so they
 * only ever get added to, never renumbered.
 */
export const EXIT = {
  OK: 0,
  /** The run finished but did not meet its release gates (or failed, with --no-gates). */
  GATES_FAILED: 1,
  /** The run errored or was cancelled, so there is no fair verdict. */
  RUN_ERRORED: 2,
  /** Gave up waiting (see --timeout). The run keeps going on the server. */
  TIMEOUT: 3,
  /** The workspace has used its session or monthly allowance, or the plan lacks the feature (HTTP 402). */
  USAGE_LIMIT: 4,
  /** Not signed in, or the key or token is invalid (HTTP 401). */
  AUTH: 5,
  /** Not found, or not allowed (HTTP 403/404). */
  NOT_FOUND: 6,
  /** Rate limited (HTTP 429). */
  RATE_LIMITED: 7,
  /** Bad command-line arguments. */
  BAD_ARGS: 64,
  /** The server could not be reached or answered with an error. */
  ERROR: 70,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** Anything the API answered with a non-2xx status. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly body: unknown
  constructor(message: string, status: number, code: string | null = null, body: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

/**
 * HTTP 402: the session or monthly allowance is used up (code session or month),
 * or the plan does not include a feature (code plan).
 */
export class UsageLimitError extends ApiError {
  readonly resetAt: string | null
  readonly requiredPlan: string | null
  constructor(message: string, code: string | null, resetAt: string | null, requiredPlan: string | null, body: unknown) {
    super(message, 402, code, body)
    this.name = 'UsageLimitError'
    this.resetAt = resetAt
    this.requiredPlan = requiredPlan
  }
}

/** The server could not be reached at all. */
export class NetworkError extends Error {
  readonly url: string
  constructor(message: string, url: string) {
    super(message)
    this.name = 'NetworkError'
    this.url = url
  }
}

/** Wrong or missing command-line input. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

/** No credential configured locally. */
export class NotSignedInError extends Error {
  constructor(message = 'Not signed in. Run `checked login`, or set CHECKED_API_KEY to a workspace API key.') {
    super(message)
    this.name = 'NotSignedInError'
  }
}

export function exitCodeFor(e: unknown): ExitCode {
  if (e instanceof ArgError) return EXIT.BAD_ARGS
  if (e instanceof NotSignedInError) return EXIT.AUTH
  if (e instanceof UsageLimitError) return EXIT.USAGE_LIMIT
  if (e instanceof ApiError) {
    if (e.status === 401) return EXIT.AUTH
    if (e.status === 403 || e.status === 404) return EXIT.NOT_FOUND
    if (e.status === 429) return EXIT.RATE_LIMITED
    if (e.status === 422 || e.status === 400) return EXIT.BAD_ARGS
    return EXIT.ERROR
  }
  return EXIT.ERROR
}

/** "in 2 h 14 min", "in 40 min", "in under a minute"; "now" once passed. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const ms = t - now.getTime()
  if (ms <= 0) return 'now'
  if (ms < 60_000) return 'in under a minute'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 48) return m ? `in ${h} h ${m} min` : `in ${h} h`
  return `in ${Math.round(h / 24)} days`
}

/**
 * One clear message for a 402, built from the server's own words plus when the
 * allowance resets, e.g. "You have used this session's allowance on Starter.
 * It refreshes in 3 hours. Resets in 2 h 59 min (14:05)."
 */
export function usageLimitMessage(e: UsageLimitError, now: Date = new Date()): string {
  const parts = [e.message.trim()]
  if (e.resetAt) {
    const rel = relativeTime(e.resetAt, now)
    const at = new Date(e.resetAt)
    const clock = Number.isFinite(at.getTime()) ? at.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', ...(at.getTime() - now.getTime() > 20 * 3600_000 ? { day: 'numeric', month: 'short' } : {}) }) : null
    if (rel) parts.push(`Resets ${rel}${clock ? ` (${clock})` : ''}.`)
  }
  if (e.requiredPlan) parts.push(`Needs the ${e.requiredPlan.charAt(0).toUpperCase()}${e.requiredPlan.slice(1)} plan or higher.`)
  return parts.join(' ')
}

/** A short, human message for any error. */
export function describeError(e: unknown, now: Date = new Date()): string {
  if (e instanceof UsageLimitError) return usageLimitMessage(e, now)
  if (e instanceof ApiError && e.status === 429) {
    const retry = (e.body as { retryAfter?: number } | null)?.retryAfter
    return `${e.message}${retry && !/try again/i.test(e.message) ? ` Try again in ${retry} s.` : ''}`
  }
  if (e instanceof Error) return e.message
  return String(e)
}

/** The error as JSON for --json output and MCP tool results. */
export function errorJson(e: unknown, now: Date = new Date()) {
  const out: Record<string, unknown> = { message: describeError(e, now) }
  if (e instanceof ApiError) {
    out.status = e.status
    if (e.code) out.code = e.code
  }
  if (e instanceof UsageLimitError) {
    out.resetAt = e.resetAt
    if (e.requiredPlan) out.requiredPlan = e.requiredPlan
  }
  out.exitCode = exitCodeFor(e)
  return out
}
