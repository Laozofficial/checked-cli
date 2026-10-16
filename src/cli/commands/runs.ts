import { ArgError, EXIT } from '../../core/errors.js'
import { countsLine, duration, formatReport, formatSummary, KIND_LABEL, runOutcome, statusText } from '../../core/format.js'
import type { LiveEvent, RunCore } from '../../core/types.js'
import { summaryAfterReport, waitForRun } from '../../core/wait.js'
import { parseDuration, str, type FlagSpec } from '../args.js'
import { requirePositional, resolveEnvironment, resolveProject, workspaceFlag, type Command, type Ctx } from '../context.js'
import { table } from '../output.js'
import { confirm } from '../prompt.js'

const RUN_KINDS: Record<string, string> = { api: 'suite', suite: 'suite', scan: 'frontend_health', health: 'frontend_health', frontend_health: 'frontend_health', explore: 'frontend_explore', frontend_explore: 'frontend_explore', flow: 'frontend_flow', frontend_flow: 'frontend_flow' }

const WAIT_FLAGS: FlagSpec = {
  wait: { type: 'boolean', description: 'Wait for the result (default; --no-wait starts it and exits)' },
  timeout: { type: 'string', placeholder: 'duration', description: 'Stop waiting after this long, e.g. 30m (default 30m). The run keeps going.' },
  'wait-report': { type: 'string', placeholder: 'duration', description: 'After the run, wait this long for the AI report before judging the gates (default 0)' },
  gates: { type: 'boolean', description: 'Exit non-zero when release gates fail (default; --no-gates uses the run status)' },
  stream: { type: 'boolean', description: 'Follow the live log (default; --no-stream only polls)' },
}

/** Prints live events as one line each, to stderr. */
function eventPrinter(ctx: Ctx) {
  const st = ctx.out.st
  let last = ''
  return (e: LiveEvent) => {
    if (ctx.out.quiet) return
    if (e.type === 'log') {
      const ev = e as { level: string; message: string }
      const tag = ev.level === 'error' ? st.red('error') : ev.level === 'warn' ? st.yellow('warn ') : st.dim('log  ')
      ctx.io.stderr.write(`${tag} ${ev.message}\n`)
    } else if (e.type === 'status') {
      const ev = e as unknown as RunCore
      const line = `${statusText(ev.status, st)} ${countsLine(ev, st)}`
      if (line !== last) ctx.io.stderr.write(`${st.bold('status')} ${line}\n`)
      last = line
    } else if (e.type === 'report') {
      const ev = e as { headline: string; healthScore: number }
      ctx.io.stderr.write(`${st.bold('report')} ${ev.headline} ${st.dim(`(health ${ev.healthScore})`)}\n`)
    } else if (e.type === 'finding') {
      const f = (e as { finding?: { severity?: string; title?: string } }).finding
      if (f?.title) ctx.io.stderr.write(`${st.yellow('found')} ${f.severity ?? ''} ${f.title}\n`)
    } else if (e.type === 'input') {
      const reqs = (e as { requests?: { title?: string }[] }).requests ?? []
      if (reqs.length) ctx.io.stderr.write(`${st.yellow('needs you')} ${reqs.map((r) => r.title).filter(Boolean).join('; ')}: answer it on the run page.\n`)
    }
  }
}

/** Shared by run, scan and runs watch: wait, then print the summary and return the exit code. */
async function followRun(ctx: Ctx, run: RunCore): Promise<number> {
  const client = ctx.client()
  const st = ctx.out.st
  if (ctx.flags.wait === false) {
    ctx.out.result({ run, waited: false }, () => `${st.bold(`Started ${KIND_LABEL[run.kind] ?? run.kind} ${run.ref ?? run.id}`)} ${st.dim(`(${run.status})`)}\n${st.dim(run.url ?? '')}`)
    return EXIT.OK
  }
  ctx.out.progress(`${st.bold(`${KIND_LABEL[run.kind] ?? run.kind} ${run.ref ?? run.id}`)} ${st.dim(run.url ?? '')}`)
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.once('SIGINT', onSigint)
  let result
  try {
    result = await waitForRun(client, run.id, {
      timeoutMs: parseDuration(ctx.flags.timeout as string | undefined, 30 * 60_000),
      stream: ctx.flags.stream !== false,
      onEvent: eventPrinter(ctx),
      onStreamError: () => ctx.out.progress(st.dim('Live log unavailable; checking the status every few seconds.')),
      signal: ac.signal,
      sleep: ctx.deps.sleep,
      now: ctx.deps.now,
    })
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
  if (ac.signal.aborted) {
    ctx.out.warn(`Stopped watching. The run keeps going: checked runs show ${run.ref ?? run.id}`)
    return 130
  }
  if (result.timedOut) {
    const s = await client.summary(run.id)
    ctx.out.result({ ...s, timedOut: true, exitCode: EXIT.TIMEOUT }, () => `${formatSummary(s, st)}\n\n${st.yellow('Timed out waiting; the run keeps going on the server.')}`)
    return EXIT.TIMEOUT
  }
  const s = await summaryAfterReport(client, run.id, parseDuration(ctx.flags['wait-report'] as string | undefined, 0), { sleep: ctx.deps.sleep, now: ctx.deps.now })
  const outcome = runOutcome(s, ctx.flags.gates !== false)
  ctx.out.result({ ...s, exitCode: outcome.code, outcome: outcome.reason }, () => `\n${formatSummary(s, st)}\n${outcome.code === EXIT.OK ? st.green(outcome.reason) : st.red(outcome.reason)}`)
  return outcome.code
}

export const runCommands: Command[] = [
  {
    path: ['run'],
    summary: 'Start a run and follow it live (exit code reflects the release gates)',
    usage: 'checked run --project <ref> [--env <name>] [--kind api|scan|explore|flow] [--depth critical|standard|deep] [--suite <id,…>] [--url <start url>] [--no-wait]',
    flags: {
      project: { type: 'string', alias: 'p', placeholder: 'ref', description: 'Project ref or id (or CHECKED_PROJECT)' },
      env: { type: 'string', alias: 'e', placeholder: 'name', description: 'Environment name or id (or CHECKED_ENV); default is the project’s default' },
      kind: { type: 'string', placeholder: 'kind', description: 'api (API projects) or scan, explore, flow (website projects)' },
      depth: { type: 'string', placeholder: 'depth', description: 'critical, standard or deep (API runs; default deep)' },
      suite: { type: 'string', placeholder: 'ids', description: 'Only these suite ids, comma separated (default: all suites)' },
      url: { type: 'string', placeholder: 'url', description: 'Start page (website runs)' },
      'max-pages': { type: 'number', placeholder: 'n', description: 'Page limit (website scans)' },
      ...WAIT_FLAGS,
    },
    examples: ['checked run --project payments-kqzxm --env Staging --depth critical', 'checked run -p marketing-site-abcde --kind scan --max-pages 50', 'checked run -p payments-kqzxm --no-wait --json'],
    run: async (ctx) => {
      const project = await resolveProject(ctx)
      const kindArg = str(ctx.flags.kind)
      const kind = kindArg ? RUN_KINDS[kindArg.toLowerCase()] : undefined
      if (kindArg && !kind) throw new ArgError(`Unknown --kind ${kindArg}. Use api, scan, explore or flow.`)
      const depth = str(ctx.flags.depth)
      if (depth && !['critical', 'standard', 'deep'].includes(depth)) throw new ArgError('--depth is critical, standard or deep.')
      const suiteIds = str(ctx.flags.suite)
        ?.split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
      const env = await resolveEnvironment(ctx, project)
      const run = await ctx.client().startRun(project, { kind, depth: depth as 'critical' | undefined, suiteIds: suiteIds?.length ? suiteIds : undefined, environmentId: env?.id, startUrl: str(ctx.flags.url), maxPages: typeof ctx.flags['max-pages'] === 'number' ? ctx.flags['max-pages'] : undefined })
      return followRun(ctx, run)
    },
  },
  {
    path: ['scan'],
    summary: 'Scan a website for broken links, errors, accessibility and speed',
    usage: 'checked scan <url> [--workspace <slug>] [--project <ref>] [--max-pages <n>] [--no-wait]',
    flags: {
      workspace: { type: 'string', placeholder: 'slug', description: 'Workspace (or CHECKED_WORKSPACE)' },
      project: { type: 'string', alias: 'p', placeholder: 'ref', description: 'Use this website project (default: the one for this host, created if needed)' },
      'max-pages': { type: 'number', placeholder: 'n', description: 'Page limit' },
      ...WAIT_FLAGS,
    },
    examples: ['checked scan https://example.com', 'checked scan https://staging.example.com --max-pages 25 --json'],
    run: async (ctx) => {
      const url = requirePositional(ctx, 0, 'the URL to scan, e.g. `checked scan https://example.com`')
      if (!/^https?:\/\//i.test(url)) throw new ArgError('Give the full URL, starting with https://')
      const projectId = str(ctx.flags.project)
      let pid: number | undefined
      if (projectId) pid = Number((await ctx.client().project(projectId)).id)
      const run = await ctx.client().scan({ url, workspace: workspaceFlag(ctx), projectId: pid, maxPages: typeof ctx.flags['max-pages'] === 'number' ? ctx.flags['max-pages'] : undefined })
      ctx.out.info(ctx.out.st.dim(`Scanning in project ${run.project.name} (${run.project.ref ?? run.project.id}).`))
      return followRun(ctx, run)
    },
  },
  {
    path: ['runs', 'list'],
    summary: 'List recent runs of a project',
    usage: 'checked runs list --project <ref> [--limit 20] [--kind suite] [--status failed]',
    flags: { project: { type: 'string', alias: 'p', placeholder: 'ref', description: 'Project ref or id (or CHECKED_PROJECT)' }, limit: { type: 'number', placeholder: 'n', description: 'How many (default 20, max 100)' }, kind: { type: 'string', placeholder: 'kind', description: 'Only this kind' }, status: { type: 'string', placeholder: 'status', description: 'Only these statuses, comma separated' } },
    run: async (ctx) => {
      const project = await resolveProject(ctx, ctx.positionals[0])
      const kindArg = str(ctx.flags.kind)
      const rows = await ctx.client().runs(project, { limit: typeof ctx.flags.limit === 'number' ? ctx.flags.limit : undefined, kind: kindArg ? (RUN_KINDS[kindArg] ?? kindArg) : undefined, status: str(ctx.flags.status) })
      const st = ctx.out.st
      ctx.out.result(rows, () =>
        rows.length ? table(['REF', 'KIND', 'STATUS', 'RESULTS', 'DURATION', 'STARTED'], rows.map((r) => [r.ref ?? String(r.id), KIND_LABEL[r.kind] ?? r.kind, statusText(r.status, st), r.total ? `${r.passed}/${r.total}` : '-', duration(r.durationMs), new Date(r.createdAt).toLocaleString()]), st) : 'No runs yet.'
      )
    },
  },
  {
    path: ['runs', 'show'],
    summary: 'Show a run: status, release gates, AI verdict and top problems',
    usage: 'checked runs show <run-ref>',
    run: async (ctx) => {
      const s = await ctx.client().summary(requirePositional(ctx, 0, 'the run ref or id'))
      ctx.out.result(s, () => formatSummary(s, ctx.out.st))
      return s.run.done ? runOutcome(s).code : EXIT.OK
    },
  },
  {
    path: ['runs', 'watch'],
    summary: 'Follow a run that is already going',
    usage: 'checked runs watch <run-ref> [--timeout 30m]',
    flags: WAIT_FLAGS,
    run: async (ctx) => followRun(ctx, await ctx.client().run(requirePositional(ctx, 0, 'the run ref or id'))),
  },
  {
    path: ['runs', 'report'],
    summary: 'Print the run’s AI report (or open the printable one)',
    usage: 'checked runs report <run-ref> [--open]',
    flags: { open: { type: 'boolean', description: 'Open the run page with the full report in the browser' } },
    run: async (ctx) => {
      const r = await ctx.client().report(requirePositional(ctx, 0, 'the run ref or id'))
      if (ctx.flags.open) await ctx.deps.openUrl(r.url)
      ctx.out.result(r, () => formatReport(r.report, r, ctx.out.st))
    },
  },
  {
    path: ['runs', 'results'],
    summary: 'List the test results of an API run',
    usage: 'checked runs results <run-ref> [--status failed,errored] [--limit 50]',
    flags: { status: { type: 'string', placeholder: 'statuses', description: 'Only these statuses' }, limit: { type: 'number', placeholder: 'n', description: 'How many (default 50, max 200)' }, page: { type: 'number', placeholder: 'n', description: 'Page' } },
    run: async (ctx) => {
      const page = await ctx.client().results(requirePositional(ctx, 0, 'the run ref or id'), { status: str(ctx.flags.status), perPage: typeof ctx.flags.limit === 'number' ? ctx.flags.limit : undefined, page: typeof ctx.flags.page === 'number' ? ctx.flags.page : undefined })
      const st = ctx.out.st
      ctx.out.result(page, () =>
        page.data.length ? table(['ID', 'STATUS', 'ENDPOINT', 'TEST', 'WHY'], page.data.map((r) => [`r${r.id}`, statusText(r.status, st), r.endpoint ? `${r.endpoint.method} ${r.endpoint.path}` : '', r.name, r.status === 'passed' ? '' : (r.explanation?.headline ?? r.failureReason ?? '')]), st, 70) : 'No results.'
      )
    },
  },
  {
    path: ['runs', 'rerun-failed'],
    summary: 'Re-run the failed and errored tests of an API run (uses allowance)',
    usage: 'checked runs rerun-failed <run-ref> [--yes]',
    flags: { yes: { type: 'boolean', alias: 'y', description: 'Do not ask first' } },
    run: async (ctx) => {
      const id = requirePositional(ctx, 0, 'the run ref or id')
      if (!ctx.flags.yes && ctx.interactive && !(await confirm(ctx.io, 'Re-run the failed tests? This uses some of this session’s allowance.'))) return EXIT.OK
      const r = await ctx.client().rerunFailed(id)
      const st = ctx.out.st
      ctx.out.result(r, () => `Re-ran ${r.rerun} test${r.rerun === 1 ? '' : 's'}: ${st.green(`${r.fixed} now pass`)}, ${r.stillFailing ? st.red(`${r.stillFailing} still failing`) : '0 still failing'}.\nThe run is now ${statusText(r.run.status, st)}: ${r.run.passed}/${r.run.total} passed.`)
      return r.stillFailing ? EXIT.GATES_FAILED : EXIT.OK
    },
  },
  {
    path: ['runs', 'cancel'],
    summary: 'Cancel a queued or running run',
    usage: 'checked runs cancel <run-ref>',
    run: async (ctx) => {
      const r = await ctx.client().cancel(requirePositional(ctx, 0, 'the run ref or id'))
      ctx.out.result(r, () => `Run ${r.ref ?? r.id} is ${statusText(r.status, ctx.out.st)}.`)
    },
  },
]
