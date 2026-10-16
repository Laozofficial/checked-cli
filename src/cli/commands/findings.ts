import { ArgError } from '../../core/errors.js'
import { formatFinding, severityText } from '../../core/format.js'
import { issuesProvider } from '../../core/issues.js'
import type { Severity } from '../../core/types.js'
import { str } from '../args.js'
import { requirePositional, resolveProject, type Command, type Ctx } from '../context.js'
import { table } from '../output.js'

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

function severityFlag(ctx: Ctx): Severity | undefined {
  const s = str(ctx.flags.severity)?.toLowerCase()
  if (!s) return undefined
  if (!SEVERITIES.includes(s as Severity)) throw new ArgError('--severity is critical, high, medium, low or info (that level and worse are shown).')
  return s as Severity
}

/**
 * `findings` and `issues` share one implementation through the IssuesProvider
 * seam (core/issues.ts). Today both read the latest run's findings; when the
 * server advertises the production issue inbox, `issues` switches to it there.
 */
function group(noun: 'findings' | 'issues'): Command[] {
  const listFlags = {
    project: { type: 'string' as const, alias: 'p', placeholder: 'ref', description: 'Project ref or id (or CHECKED_PROJECT)' },
    run: { type: 'string' as const, alias: 'r', placeholder: 'run-ref', description: 'From this run (default: the latest finished run)' },
    severity: { type: 'string' as const, alias: 's', placeholder: 'level', description: 'This severity and worse: critical, high, medium, low' },
    limit: { type: 'number' as const, placeholder: 'n', description: 'How many (default 50)' },
  }
  return [
    {
      path: [noun, 'list'],
      summary: noun === 'findings' ? 'List problems found by the latest run (failed tests and scan findings)' : 'List open issues (today: the latest run’s findings)',
      usage: `checked ${noun} list --project <ref> [--run <run-ref>] [--severity high]`,
      flags: listFlags,
      run: async (ctx) => {
        const project = await resolveProject(ctx, ctx.positionals[0])
        const client = ctx.client()
        let runId: number | undefined
        const runRef = str(ctx.flags.run)
        if (runRef) runId = Number((await client.run(runRef)).id)
        const provider = issuesProvider(client)
        const list = await provider.list({ projectId: project, runId, severity: severityFlag(ctx), limit: typeof ctx.flags.limit === 'number' ? ctx.flags.limit : 50 })
        const st = ctx.out.st
        ctx.out.result({ ...list, provider: provider.name }, () => {
          if (list.scope.kind === 'none') return 'No finished runs yet, so nothing to show.'
          const head = list.scope.kind === 'run' ? st.dim(`From run ${list.scope.runRef ?? list.scope.runId} (${list.scope.status}). ${list.total} total.`) : ''
          if (!list.issues.length) return `${head}\n${st.green('No problems found.')}`
          return `${table(['ID', 'SEVERITY', 'WHERE', 'TITLE'], list.issues.map((f) => [f.id, severityText(f.severity, st), f.endpoint ? `${f.endpoint.method} ${f.endpoint.path}` : (f.url ?? ''), f.title]), st, 70)}\n\n${head}\n${st.dim(`Details: checked ${noun} show <id>`)}`
        })
      },
    },
    {
      path: [noun, 'show'],
      summary: noun === 'findings' ? 'Show one finding with its evidence, diagnosis and fix' : 'Show one issue with its evidence, diagnosis and fix',
      usage: `checked ${noun} show <id>   (ids look like r123 for a failed test, f456 for a scan finding)`,
      run: async (ctx) => {
        const id = requirePositional(ctx, 0, `the ${noun === 'findings' ? 'finding' : 'issue'} id, e.g. r123 or f456`)
        const f = await issuesProvider(ctx.client()).show(id)
        ctx.out.result(f, () => formatFinding(f, ctx.out.st))
      },
    },
  ]
}

export const findingCommands: Command[] = [...group('findings'), ...group('issues')]
