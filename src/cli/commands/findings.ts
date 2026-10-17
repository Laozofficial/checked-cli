import { ArgError } from '../../core/errors.js'
import { formatFinding, formatIssue, severityText } from '../../core/format.js'
import { FindingsIssuesProvider, isInboxIssue, issuesProvider, type IssuesProvider } from '../../core/issues.js'
import type { Severity } from '../../core/types.js'
import { str } from '../args.js'
import { requirePositional, resolveProject, type Command, type Ctx } from '../context.js'
import { table } from '../output.js'

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
const STATUSES = ['open', 'new', 'regressed', 'investigating', 'resolved', 'ignored', 'all']
const SOURCES = ['production', 'test_run', 'site_scan', 'load_test']

function severityFlag(ctx: Ctx): Severity | undefined {
  const s = str(ctx.flags.severity)?.toLowerCase()
  if (!s) return undefined
  if (!SEVERITIES.includes(s as Severity)) throw new ArgError('--severity is critical, high, medium, low or info (that level and worse are shown).')
  return s as Severity
}

function oneOf(ctx: Ctx, name: string, allowed: string[]): string | undefined {
  const v = str(ctx.flags[name])?.toLowerCase()
  if (!v) return undefined
  if (!allowed.includes(v)) throw new ArgError(`--${name} is one of: ${allowed.join(', ')}.`)
  return v
}

/**
 * `findings` read the latest run's findings. `issues` read through the IssuesProvider seam
 * (core/issues.ts): the issue inbox (production errors and test findings) on servers that
 * advertise it, else the same findings. Both are read-only.
 */
async function providerFor(ctx: Ctx, noun: 'findings' | 'issues'): Promise<IssuesProvider> {
  const client = ctx.client()
  if (noun === 'findings') return new FindingsIssuesProvider(client)
  const caps = (await client.whoami().catch(() => null))?.capabilities ?? null
  return issuesProvider(client, caps)
}

function group(noun: 'findings' | 'issues'): Command[] {
  const listFlags = {
    project: { type: 'string' as const, alias: 'p', placeholder: 'ref', description: 'Project ref or id (or CHECKED_PROJECT)' },
    run: { type: 'string' as const, alias: 'r', placeholder: 'run-ref', description: noun === 'findings' ? 'From this run (default: the latest finished run)' : 'Only the findings of this run' },
    severity: { type: 'string' as const, alias: 's', placeholder: 'level', description: 'This severity and worse: critical, high, medium, low' },
    ...(noun === 'issues'
      ? {
          status: { type: 'string' as const, placeholder: 'status', description: 'open (default), new, regressed, investigating, resolved, ignored or all' },
          source: { type: 'string' as const, placeholder: 'source', description: 'production, test_run, site_scan or load_test' },
        }
      : {}),
    limit: { type: 'number' as const, placeholder: 'n', description: 'How many (default 50)' },
  }
  return [
    {
      path: [noun, 'list'],
      summary: noun === 'findings' ? 'List problems found by the latest run (failed tests and scan findings)' : 'List open issues: production errors and test findings, highest impact first',
      usage: `checked ${noun} list --project <ref> [--run <run-ref>] [--severity high]${noun === 'issues' ? ' [--status open] [--source production]' : ''}`,
      flags: listFlags,
      run: async (ctx) => {
        const project = await resolveProject(ctx, ctx.positionals[0])
        const client = ctx.client()
        let runId: number | undefined
        const runRef = str(ctx.flags.run)
        if (runRef) runId = Number((await client.run(runRef)).id)
        const status = noun === 'issues' ? oneOf(ctx, 'status', STATUSES) : undefined
        const source = noun === 'issues' ? oneOf(ctx, 'source', SOURCES) : undefined
        const provider = await providerFor(ctx, noun)
        const list = await provider.list({ projectId: project, runId, severity: severityFlag(ctx), status, source, limit: typeof ctx.flags.limit === 'number' ? ctx.flags.limit : 50 })
        const st = ctx.out.st
        ctx.out.result({ ...list, provider: provider.name }, () => {
          if (list.scope.kind === 'none') return 'No finished runs yet, so nothing to show.'
          if (list.scope.kind === 'inbox') {
            const head = st.dim(`${list.total} ${list.total === 1 ? 'issue' : 'issues'}${list.scope.url ? `. ${list.scope.url}` : ''}`)
            if (!list.issues.length) return `${st.green('No open issues.')}\n${head}`
            const rows = list.issues.map((i) => (isInboxIssue(i) ? [i.ref, severityText(i.severity, st), i.status, `${i.occurrences}${i.source === 'production' ? `x, ${i.usersAffected}u` : ' runs'}`, `${i.title}${i.explained ? st.dim(' (explained)') : ''}`] : [i.id, severityText(i.severity, st), i.status, '1', i.title]))
            return `${table(['ID', 'SEVERITY', 'STATUS', 'SEEN', 'TITLE'], rows, st, 70)}\n\n${head}\n${st.dim(`Details: checked issues show <id>; with the AI explanation: checked issues show <id> --explain`)}`
          }
          const head = st.dim(`From run ${list.scope.runRef ?? list.scope.runId} (${list.scope.status}). ${list.total} total.`)
          if (!list.issues.length) return `${head}\n${st.green('No problems found.')}`
          return `${table(['ID', 'SEVERITY', 'WHERE', 'TITLE'], list.issues.map((f) => [f.id, severityText(f.severity, st), f.endpoint ? `${f.endpoint.method} ${f.endpoint.path}` : (f.url ?? ''), f.title]), st, 70)}\n\n${head}\n${st.dim(`Details: checked ${noun} show <id>`)}`
        })
      },
    },
    {
      path: [noun, 'show'],
      summary: noun === 'findings' ? 'Show one finding with its evidence, diagnosis and fix' : 'Show one issue with its evidence and fix PR; --explain adds the AI explanation',
      usage: noun === 'findings' ? `checked findings show <id>   (ids look like r123 for a failed test, f456 for a scan finding)` : `checked issues show <id> [--explain]   (an issue ref, or r123 / f456 for a run's finding)`,
      flags: noun === 'issues' ? { explain: { type: 'boolean' as const, description: 'Include the cached AI explanation (read-only: it never starts a new one)' } } : undefined,
      run: async (ctx) => {
        const id = requirePositional(ctx, 0, noun === 'findings' ? 'the finding id, e.g. r123 or f456' : 'the issue id, e.g. kqzxmvbt (or r123 for a run finding)')
        const f = await (await providerFor(ctx, noun)).show(id)
        ctx.out.result(f, () => (isInboxIssue(f) ? formatIssue(f, ctx.out.st, { explain: !!ctx.flags.explain }) : formatFinding(f, ctx.out.st)))
      },
    },
  ]
}

export const findingCommands: Command[] = [...group('findings'), ...group('issues')]
