import type { CheckedClient } from './client.js'
import type { Capabilities, Finding, Severity } from './types.js'

/**
 * The seam between the tools and wherever issues come from.
 *
 * Today an issue is a finding from the latest test run: a failed API test or a
 * website scan finding (GET /cli/projects/:id/findings). A production issue inbox
 * (errors reported by the in-app SDK plus test findings, with status and
 * occurrences) is being built; when the server ships it, it advertises
 * `capabilities.issuesInbox: true` in /cli/whoami, and `issuesProvider()` is the
 * one place that switches to it. The CLI's `issues` commands and the MCP issue
 * tools only ever talk to an IssuesProvider, so nothing else changes.
 */
export type Issue = Finding & {
  /** Where the issue was seen: 'test' today; the inbox adds 'production'. */
  origin: 'test' | 'production'
  /** How many times it was seen (1 for a single test finding). */
  occurrences: number
}

export type IssueQuery = { projectId: string | number; runId?: string | number; severity?: Severity; limit?: number }

export type IssueList = { issues: Issue[]; total: number; scope: { kind: 'run'; runId: number; runRef: string | null; status: string; url: string } | { kind: 'none' } | { kind: 'inbox' } }

export interface IssuesProvider {
  readonly name: 'findings' | 'inbox'
  list(q: IssueQuery): Promise<IssueList>
  show(id: string): Promise<Issue & Record<string, unknown>>
}

export function issueFromFinding(f: Finding): Issue {
  return { ...f, origin: 'test', occurrences: 1 }
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

/**
 * Picks the provider for this server. Only the findings provider exists today;
 * an InboxIssuesProvider (GET /cli/projects/:id/issues, GET /cli/issues/:id) slots
 * in here when `capabilities.issuesInbox` is true.
 */
export function issuesProvider(client: CheckedClient, _capabilities?: Capabilities | null): IssuesProvider {
  return new FindingsIssuesProvider(client)
}
