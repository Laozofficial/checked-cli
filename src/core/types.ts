/** Shapes returned by the Check’d developer API (/api/v1/cli). Only the fields the tools use are typed. */

export type Workspace = { id: number; name: string; slug: string; plan: string; role: string }

export type Capabilities = { deviceLogin?: boolean; liveEvents?: boolean; findings?: boolean; issuesInbox?: boolean; scans?: boolean; imports?: boolean; [k: string]: boolean | undefined }

export type WhoAmI = {
  kind: 'user' | 'key'
  user: { id: number; email: string; fullName: string | null; emailVerified: boolean } | null
  key: { id: number; name: string; prefix: string; workspaceId: number } | null
  workspaces: Workspace[]
  apiVersion: number
  capabilities: Capabilities
  appUrl: string
}

export type RunCore = {
  id: number
  ref: string | null
  kind: string
  status: 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'cancelled' | string
  total: number
  passed: number
  failed: number
  errored: number
  skipped: number
  durationMs: number | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  projectId: number
  done?: boolean
  url?: string
  trigger?: string
  error?: string | null
}

export type ProjectRow = {
  id: number
  ref: string | null
  name: string
  kind: 'backend' | 'frontend' | string
  baseUrl: string | null
  workspace: { id: number; slug: string; name: string } | null
  endpointCount: number
  suiteCount: number
  lastRun: RunCore | null
  archivedAt: string | null
  url: string
}

export type EnvironmentRow = { id: number; projectId: number; name: string; baseUrl: string; isDefault: boolean; auth: { type?: string } & Record<string, unknown>; variables: Record<string, unknown> }

export type SuiteRow = { id: number; ref: string | null; name: string; kind: string; generatedBy: string; enabledCases: number }

export type GateCheck = { key: string; label: string; ok: boolean; actual: string; target: string; note?: string }
export type Gates = { passed: boolean; pendingReport: boolean; checks: GateCheck[] }

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type RunSummary = {
  run: RunCore
  project: { id: number; ref: string | null; name: string; kind: string }
  url: string
  gates: Gates | null
  report: { headline: string | null; verdict: string | null; healthScore: number | null; summary: string | null; nextSteps: string[] } | null
  health: { score: number | null; grade: string | null } | null
  findingCount: number
  topFindings: { id: string; severity: Severity; title: string; endpoint: { method: string; path: string } | null; url: string | null; suggestion: string | null }[]
}

export type AiReport = {
  headline: string
  healthScore: number
  summary: string
  verdict?: 'ship' | 'ship_with_care' | 'hold'
  findings: { severity: Severity; title: string; detail: string; suggestion: string; endpoint?: string; impact?: string; repro?: string }[]
  nextSteps: string[]
  notTested?: string[]
  residualRisk?: string
  whatWorked?: string[]
  generatedAt?: string
}

export type ReportResponse = { runId: number; runRef: string | null; status: string; done: boolean; report: AiReport | null; stale: boolean; url: string }

export type Finding = {
  id: string
  source: 'api_test' | 'site_scan'
  severity: Severity
  category: string
  title: string
  detail: string | null
  status: string
  runId: number
  runRef: string | null
  projectId: number
  endpoint: { method: string; path: string } | null
  url: string | null
  diagnosis: string | null
  suggestion: string | null
  fix: string[]
  steps: string[]
  evidence: Record<string, unknown>
  createdAt: string | null
}

export type FindingsPage = { data: Finding[]; meta: { run: { id: number; ref: string | null; kind: string; status: string; finishedAt: string | null; url: string } | null; total: number; distinctIssues?: number | null } }

export type ResultRow = {
  id: number
  name: string
  status: string
  category: string
  durationMs: number | null
  endpoint: { method: string; path: string } | null
  failureReason: string | null
  diagnosis: string | null
  explanation?: { kind?: string; headline?: string; cause?: string; fix?: string[] }
}

export type ImportPreview = {
  ok: boolean
  format: string
  formatLabel: string
  formatMatches: boolean
  title: string | null
  version: string | null
  baseUrl: string | null
  endpointCount: number
  willImport: number
  dropped: number
  quota: { max: number | null; used: number; remaining: number | null; plan: string }
  methods: Record<string, number>
  authCount: number
  withBody: number
  tags: string[]
  warnings: string[]
  problems: string[]
  sample: { method: string; path: string; summary: string | null; auth: boolean }[]
}

export type ImportSaved = { id: number; projectId: number; title: string | null; version: string | null; format: string | null; endpointCount: number; warnings: string[]; projectUrl: string }

export type Usage = {
  workspace: { id: number; slug: string; name: string }
  plan: string
  planName: string
  sessionHours: number
  session: { startedAt: string | null; resetAt: string | null; usedMicros: number; budgetMicros: number; percent: number; active: boolean }
  month: { usedMicros: number; allowanceMicros: number; percent: number; resetAt: string; unlimited: boolean }
  extraCreditMicros: number
  blocked: null | { code: string; message: string; resetAt: string | null }
  billingUrl: string
}

export type DeviceStart = { deviceCode: string; userCode: string; expiresIn: number; interval: number; verificationUri: string; verificationUriComplete: string }
export type DeviceToken = { token: string; tokenType: string; expiresAt: string | null; user: { id: number; email: string; fullName: string | null } }

export type RerunOutcome = { rerun: number; fixed: number; stillFailing: number; missing?: unknown; run: { status: string; passed: number; failed: number; errored: number; total: number } }

/** Live run events, as the app's run page receives them. */
export type LiveEvent =
  | { type: 'log'; id?: number; level: string; message: string; at?: string }
  | { type: 'status'; status: string; total: number; passed: number; failed: number; errored: number; skipped: number; durationMs: number | null }
  | { type: 'report'; headline: string; healthScore: number }
  | { type: string; [k: string]: unknown }

export const TERMINAL = ['passed', 'failed', 'errored', 'cancelled']
export const isTerminal = (status: string) => TERMINAL.includes(status)
