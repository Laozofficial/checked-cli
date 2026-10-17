import type { CheckedClient } from './client.js'
import type { Capabilities, Finding, InboxIssue, InboxIssueDetail, Severity } from './types.js'

/**
 * The seam between the tools and wherever issues come from.
 *
 * Two providers:
 *   findings  a finding from the latest (or a given) test run: a failed API test or a website
 *             scan finding (GET /cli/projects/:id/findings). Ids look like r123 or f456.
 *   inbox     the unified issue inbox: errors real users hit in production (from the SDK) and
 *             test findings, with status, occurrences, users and the cached AI explanation
 *             (GET /cli/projects/:id/issues, GET /cli/issues/:ref). Ids are issue refs.
 *
 * Servers that have the inbox advertise `capabilities.issuesInbox: true` in /cli/whoami and
 * `issuesProvider()` picks the inbox there. The CLI's `issues` commands and the MCP issue tools
 * only ever talk to an IssuesProvider; `findings` commands always use the findings provider.
 * The inbox provider still answers finding ids (r123, f456) and run-scoped lists through the
 * findings provider, so older scripts keep working.
 */
export type FindingIssue = Finding & {
  /** Where the issue was seen. */
  origin: 'test' | 'production'
  /** How many times it was seen (1 for a single test finding). */
  occurrences: number
  inbox?: false
}

export type InboxIssueRow = InboxIssue & {
  origin: 'test' | 'production'
  /** Inbox issues are not tied to one endpoint; kept so lists render both kinds alike. */
  endpoint: null
  inbox: true
}

export type Issue = FindingIssue | InboxIssueRow

export type IssueQuery = { projectId: string | number; runId?: string | number; severity?: Severity; limit?: number; status?: string; source?: string }

export type IssueList = {
  issues: Issue[]
  total: number
  scope: { kind: 'run'; runId: number; runRef: string | null; status: string; url: string } | { kind: 'none' } | { kind: 'inbox'; url?: string }
}

export interface IssuesProvider {
  readonly name: 'findings' | 'inbox'
  list(q: IssueQuery): Promise<IssueList>
  show(id: string): Promise<Issue & Record<string, unknown>>
}

export function issueFromFinding(f: Finding): FindingIssue {
  return { ...f, origin: 'test', occurrences: 1 }
}

export function issueFromInbox<T extends InboxIssue>(i: T): T & InboxIssueRow {
  return { ...i, origin: i.source === 'production' ? 'production' : 'test', endpoint: null, inbox: true }
}

export const isInboxIssue = (i: Issue): i is InboxIssueRow => i.inbox === true

/** Finding ids (r123, f456, or digits) as opposed to inbox refs (letters). */
export const FINDING_ID = /^[rf]?\d+$/i

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
/** "high" means high and worse, as with findings: the inbox takes the list. */
export function severityAndWorse(s?: Severity): string | undefined {
  if (!s) return undefined
  const i = SEVERITIES.indexOf(s)
  return i < 0 ? undefined : SEVERITIES.slice(0, i + 1).join(',')
}

/** Issues backed by the existing findings API: the latest (or a given) run's problems. */
export class FindingsIssuesProvider implements IssuesProvider {
  readonly name = 'findings' as const
  constructor(private readonly client: CheckedClient) {}

  async list(q: IssueQuery): Promise<IssueList> {
    const page = await this.client.projectFindings(q.projectId, { runId: q.runId, severity: q.severity, limit: q.limit })
    const run = page.meta?.run
    return {
      issues: page.data.map(issueFromFinding),
      total: page.meta?.total ?? page.data.length,
      scope: run ? { kind: 'run', runId: run.id, runRef: run.ref, status: run.status, url: run.url } : { kind: 'none' },
    }
  }

  async show(id: string) {
    const f = await this.client.finding(id)
    return { ...f, origin: 'test' as const, occurrences: 1 }
  }
}

/** Issues from the unified inbox: production errors and test findings, open first by impact. */
export class InboxIssuesProvider implements IssuesProvider {
  readonly name = 'inbox' as const
  private readonly findings: FindingsIssuesProvider
  constructor(private readonly client: CheckedClient) {
    this.findings = new FindingsIssuesProvider(client)
  }

  async list(q: IssueQuery): Promise<IssueList> {
    // A run's problems are still its findings.
    if (q.runId !== undefined) return this.findings.list(q)
    const page = await this.client.projectIssues(q.projectId, { status: q.status, source: q.source, severity: severityAndWorse(q.severity), limit: q.limit })
    return { issues: page.data.map((i) => issueFromInbox(i)), total: page.meta?.total ?? page.data.length, scope: { kind: 'inbox', url: page.meta?.url } }
  }

  async show(id: string): Promise<Issue & Record<string, unknown>> {
    if (FINDING_ID.test(id)) return this.findings.show(id)
    const d: InboxIssueDetail = await this.client.issue(id)
    return issueFromInbox(d) as InboxIssueRow & Record<string, unknown>
  }
}

/** Picks the provider for this server: the inbox when it advertises one, else findings. */
export function issuesProvider(client: CheckedClient, capabilities?: Capabilities | null): IssuesProvider {
  return capabilities?.issuesInbox ? new InboxIssuesProvider(client) : new FindingsIssuesProvider(client)
}
