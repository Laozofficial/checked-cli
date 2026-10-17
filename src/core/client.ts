import { ApiError, NetworkError, NotSignedInError, UsageLimitError } from './errors.js'
import { SseParser } from './sse.js'
import type {
  DeviceStart,
  DeviceToken,
  EnvironmentRow,
  Finding,
  FindingsPage,
  InboxIssueDetail,
  InboxPage,
  ImportPreview,
  ImportSaved,
  LiveEvent,
  ProjectRow,
  ReportResponse,
  RerunOutcome,
  ResultRow,
  RunCore,
  RunSummary,
  SuiteRow,
  Usage,
  WhoAmI,
  Workspace,
} from './types.js'
import { VERSION } from '../version.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type ClientOptions = {
  apiUrl: string
  token?: string | null
  fetch?: FetchLike
  /** Shown in the server's logs, e.g. "checked-cli/0.1.0" or "checked-mcp/0.1.0". */
  userAgent?: string
  timeoutMs?: number
}

type Query = Record<string, string | number | boolean | null | undefined>

export type StartRunInput = { kind?: string; depth?: 'critical' | 'standard' | 'deep'; suiteIds?: number[]; environmentId?: number; startUrl?: string; maxPages?: number }
export type ImportInput = { url?: string; content?: string; filename?: string; expected?: string; replace?: boolean }

/**
 * A small typed client for the Check’d developer API. Uses the global fetch
 * (Node 20+), so the CLI has no runtime dependencies. Every method returns the
 * unwrapped `data` (or `{ data, meta }` where the API pages).
 */
export class CheckedClient {
  readonly apiUrl: string
  private token: string | null
  private readonly fetchImpl: FetchLike
  private readonly userAgent: string
  private readonly timeoutMs: number

  constructor(opts: ClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.token = opts.token ?? null
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init))
    this.userAgent = opts.userAgent ?? `checked-cli/${VERSION}`
    this.timeoutMs = opts.timeoutMs ?? 60_000
  }

  get hasToken() {
    return !!this.token
  }

  setToken(token: string | null) {
    this.token = token
  }

  url(path: string, query?: Query): string {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : ''
    return `${this.apiUrl}/api/v1${path}${qs ? `?${qs}` : ''}`
  }

  private headers(json: boolean, auth: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.userAgent }
    if (json) h['Content-Type'] = 'application/json'
    if (auth) {
      if (!this.token) throw new NotSignedInError()
      h.Authorization = `Bearer ${this.token}`
    }
    return h
  }

  /** Low-level request. Throws ApiError / UsageLimitError / NetworkError. */
  async request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; auth?: boolean; raw?: boolean } = {}): Promise<T> {
    const url = this.url(path, opts.query)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(url, { method, headers: this.headers(opts.body !== undefined, opts.auth !== false), body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: ctrl.signal })
    } catch (e) {
      if (e instanceof NotSignedInError) throw e
      const reason = (e as Error)?.name === 'AbortError' ? `timed out after ${Math.round(this.timeoutMs / 1000)} s` : ((e as Error)?.message ?? String(e))
      throw new NetworkError(`Could not reach the Check’d API at ${this.apiUrl} (${reason}).`, url)
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) throw toApiError(res.status, body)
    if (opts.raw) return body as T
    if (body && typeof body === 'object' && 'data' in body && !('meta' in body)) return body.data as T
    return body as T
  }

  get<T>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query })
  }

  post<T>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, { body })
  }

  /* identity and sign-in */
  whoami() {
    return this.get<WhoAmI>('/cli/whoami')
  }
  workspaces() {
    return this.get<Workspace[]>('/cli/workspaces')
  }
  deviceStart(clientName: string) {
    return this.request<DeviceStart>('POST', '/cli/device', { body: { clientName }, auth: false })
  }
  /** One poll. Resolves to the token once approved; rejects with ApiError(400, code) while pending, denied or expired. */
  deviceToken(deviceCode: string) {
    return this.request<DeviceToken>('POST', '/cli/device/token', { body: { deviceCode }, auth: false })
  }
  /** Revokes the current personal access token on the server (the app's own sign-out endpoint). */
  logout() {
    return this.request<unknown>('POST', '/account/logout', { body: {} })
  }

  /* projects */
  projects(opts: { workspace?: string; archived?: boolean } = {}) {
    return this.get<ProjectRow[]>('/cli/projects', { workspace: opts.workspace, archived: opts.archived ? 1 : undefined })
  }
  project(id: string | number) {
    return this.get<ProjectRow & Record<string, unknown>>(`/cli/projects/${enc(id)}`)
  }
  environments(projectId: string | number) {
    return this.get<EnvironmentRow[]>(`/cli/projects/${enc(projectId)}/environments`)
  }
  suites(projectId: string | number) {
    return this.get<SuiteRow[]>(`/cli/projects/${enc(projectId)}/suites`)
  }
  schedules(projectId: string | number) {
    return this.get<Record<string, unknown>[]>(`/cli/projects/${enc(projectId)}/schedules`)
  }

  /* imports */
  importPreview(projectId: string | number, input: ImportInput) {
    return this.post<ImportPreview>(`/cli/projects/${enc(projectId)}/import/preview`, input)
  }
  importSave(projectId: string | number, input: ImportInput) {
    return this.post<ImportSaved>(`/cli/projects/${enc(projectId)}/import`, input)
  }

  /* runs */
  runs(projectId: string | number, opts: { limit?: number; kind?: string; status?: string } = {}) {
    return this.get<RunCore[]>(`/cli/projects/${enc(projectId)}/runs`, opts)
  }
  startRun(projectId: string | number, input: StartRunInput) {
    return this.post<RunCore>(`/cli/projects/${enc(projectId)}/runs`, input)
  }
  run(id: string | number) {
    return this.get<RunCore & Record<string, unknown>>(`/cli/runs/${enc(id)}`)
  }
  summary(id: string | number) {
    return this.get<RunSummary>(`/cli/runs/${enc(id)}/summary`)
  }
  results(id: string | number, opts: { status?: string; page?: number; perPage?: number } = {}) {
    return this.request<{ data: ResultRow[]; meta: Record<string, unknown> }>('GET', `/cli/runs/${enc(id)}/results`, { query: opts, raw: true })
  }
  report(id: string | number) {
    return this.get<ReportResponse>(`/cli/runs/${enc(id)}/report`)
  }
  gates(id: string | number) {
    return this.get<RunSummary['gates']>(`/cli/runs/${enc(id)}/gates`)
  }
  rerunFailed(id: string | number) {
    return this.post<RerunOutcome>(`/cli/runs/${enc(id)}/rerun-failed`)
  }
  cancel(id: string | number) {
    return this.post<RunCore>(`/cli/runs/${enc(id)}/cancel`)
  }
  scan(input: { url: string; workspace?: string; projectId?: number; maxPages?: number }) {
    return this.post<RunCore & { project: { id: number; ref: string | null; name: string } }>('/cli/scans', input)
  }

  /* findings */
  projectFindings(projectId: string | number, opts: { runId?: number | string; severity?: string; limit?: number } = {}) {
    return this.request<FindingsPage>('GET', `/cli/projects/${enc(projectId)}/findings`, { query: opts, raw: true })
  }
  finding(id: string) {
    return this.get<Finding & Record<string, unknown>>(`/cli/findings/${enc(id)}`)
  }

  /* the issue inbox (needs capabilities.issuesInbox) */
  projectIssues(projectId: string | number, opts: { status?: string; source?: string; severity?: string; q?: string; fixPr?: boolean; sort?: string; limit?: number } = {}) {
    const { fixPr, ...rest } = opts
    return this.request<InboxPage>('GET', `/cli/projects/${enc(projectId)}/issues`, { query: { ...rest, fixPr: fixPr ? 1 : undefined }, raw: true })
  }
  issue(ref: string) {
    return this.get<InboxIssueDetail>(`/cli/issues/${enc(ref)}`)
  }

  /* usage */
  usage(workspace?: string) {
    return this.get<Usage>('/cli/usage', { workspace })
  }

  /**
   * Follows a run's live feed. Calls onEvent for each event and resolves when the
   * stream ends or the signal aborts. Rejects if the stream cannot be opened.
   */
  async events(runId: string | number, onEvent: (e: LiveEvent) => void, signal?: AbortSignal): Promise<void> {
    const url = this.url(`/cli/runs/${enc(runId)}/events`)
    let res: Response
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { ...this.headers(false, true), Accept: 'text/event-stream' }, signal })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      throw new NetworkError(`Could not open the live feed (${(e as Error)?.message ?? e}).`, url)
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {}
      throw toApiError(res.status, body)
    }
    const parser = new SseParser()
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            onEvent(JSON.parse(msg.data) as LiveEvent)
          } catch {
            /* ignore malformed events */
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') throw e
    } finally {
      reader.releaseLock?.()
    }
  }
}

function enc(v: string | number) {
  return encodeURIComponent(String(v))
}

export function toApiError(status: number, body: any): ApiError {
  const first = Array.isArray(body?.errors) ? body.errors[0] : null
  const message =
    (typeof body?.message === 'string' && body.message) ||
    (first?.message ? `${first.message}${first.field ? ` (${first.field})` : ''}` : '') ||
    (typeof body === 'string' && body.length < 300 && body) ||
    `The API answered ${status}.`
  const code = typeof body?.code === 'string' ? body.code : typeof body?.error === 'string' ? body.error : null
  if (status === 402) return new UsageLimitError(message, code, body?.resetAt ?? null, body?.requiredPlan ?? null, body)
  return new ApiError(message, status, code, body)
}
