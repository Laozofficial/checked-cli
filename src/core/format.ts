import { EXIT, type ExitCode, relativeTime } from './errors.js'
import type { AiReport, Finding, ImportPreview, InboxIssue, InboxIssueDetail, IssueAi, RunCore, RunSummary, Usage } from './types.js'

/**
 * Plain-text renderings shared by the CLI (which adds colour through `Style`) and
 * the MCP server (which sends them to the assistant as is).
 */
export type Style = { bold: (s: string) => string; dim: (s: string) => string; red: (s: string) => string; green: (s: string) => string; yellow: (s: string) => string; cyan: (s: string) => string }

const id = (s: string) => s
export const PLAIN: Style = { bold: id, dim: id, red: id, green: id, yellow: id, cyan: id }

export const KIND_LABEL: Record<string, string> = { suite: 'API tests', load: 'Load test', frontend_health: 'Website scan', frontend_explore: 'AI exploration', frontend_flow: 'User flow' }

export function money(micros: number): string {
  return `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return `${m} min ${s % 60} s`
}

export function statusText(status: string, st: Style = PLAIN): string {
  if (status === 'passed') return st.green(status)
  if (status === 'failed' || status === 'errored') return st.red(status)
  if (status === 'cancelled') return st.yellow(status)
  return st.cyan(status)
}

export function severityText(sev: string, st: Style = PLAIN): string {
  if (sev === 'critical' || sev === 'high') return st.red(sev)
  if (sev === 'medium') return st.yellow(sev)
  return st.dim(sev)
}

export function countsLine(r: Pick<RunCore, 'total' | 'passed' | 'failed' | 'errored' | 'skipped'>, st: Style = PLAIN): string {
  const parts = [st.green(`${r.passed} passed`)]
  if (r.failed) parts.push(st.red(`${r.failed} failed`))
  if (r.errored) parts.push(st.red(`${r.errored} errored`))
  if (r.skipped) parts.push(st.dim(`${r.skipped} skipped`))
  return `${parts.join(', ')}${r.total ? st.dim(` of ${r.total}`) : ''}`
}

/**
 * What a finished run means for CI. Gates decide when they were evaluated;
 * --no-gates (useGates false) falls back to the run's own status.
 */
export function runOutcome(s: Pick<RunSummary, 'run' | 'gates'>, useGates = true): { code: ExitCode; reason: string } {
  const st = s.run.status
  if (st === 'errored' || st === 'cancelled') return { code: EXIT.RUN_ERRORED, reason: `The run ${st}${s.run.error ? `: ${s.run.error}` : ''}.` }
  if (st !== 'passed' && st !== 'failed') return { code: EXIT.TIMEOUT, reason: `The run is still ${st}.` }
  if (useGates && s.gates) {
    if (s.gates.passed) return { code: EXIT.OK, reason: 'The run met its release gates.' }
    const failing = s.gates.checks.filter((c) => !c.ok).map((c) => `${c.label} ${c.actual} (needs ${c.target})`)
    return { code: EXIT.GATES_FAILED, reason: `Release gates not met: ${failing.join('; ')}.` }
  }
  return st === 'passed' ? { code: EXIT.OK, reason: 'The run passed.' } : { code: EXIT.GATES_FAILED, reason: 'The run failed.' }
}

export function formatSummary(s: RunSummary, st: Style = PLAIN): string {
  const r = s.run
  const lines: string[] = []
  lines.push(`${st.bold(`${KIND_LABEL[r.kind] ?? r.kind} ${r.ref ?? `#${r.id}`}`)} on ${s.project.name}: ${statusText(r.status, st)}${r.durationMs ? st.dim(` in ${duration(r.durationMs)}`) : ''}`)
  if (r.kind === 'suite' || r.total) lines.push(`  ${countsLine(r, st)}`)
  if (s.health?.score !== null && s.health?.score !== undefined) lines.push(`  Health score ${s.health.score}${s.health.grade ? ` (${s.health.grade})` : ''}`)
  if (r.error) lines.push(`  ${st.red(r.error)}`)
  if (s.gates) {
    lines.push('')
    lines.push(`${st.bold('Release gates')}: ${s.gates.passed ? st.green('met') : st.red('not met')}${s.gates.pendingReport ? st.dim(' (AI report pending; defect counts may change)') : ''}`)
    for (const c of s.gates.checks) lines.push(`  ${c.ok ? st.green('ok  ') : st.red('fail')} ${c.label}: ${c.actual} ${st.dim(`(needs ${c.target})`)}${c.note ? st.dim(`, ${c.note}`) : ''}`)
  }
  if (s.report) {
    lines.push('')
    lines.push(`${st.bold('AI report')}${s.report.verdict ? `: ${verdictText(s.report.verdict, st)}` : ''}`)
    if (s.report.headline) lines.push(`  ${s.report.headline}`)
  }
  if (s.topFindings.length) {
    lines.push('')
    lines.push(`${st.bold('Top problems')}${s.findingCount > s.topFindings.length ? st.dim(` (${s.topFindings.length} of ${s.findingCount})`) : ''}`)
    for (const f of s.topFindings) {
      const where = f.endpoint ? `${f.endpoint.method} ${f.endpoint.path}` : f.url ?? ''
      lines.push(`  ${severityText(f.severity.padEnd(8), st)} ${f.title}${where && !f.title.includes(where) ? st.dim(`  ${where}`) : ''} ${st.dim(`[${f.id}]`)}`)
    }
  }
  lines.push('')
  lines.push(st.dim(s.url))
  return lines.join('\n')
}

export function verdictText(v: string, st: Style = PLAIN): string {
  if (v === 'ship') return st.green('ship')
  if (v === 'hold') return st.red('hold')
  if (v === 'ship_with_care') return st.yellow('ship with care')
  return v
}

export function formatReport(report: AiReport | null, meta: { url: string; status: string; done: boolean }, st: Style = PLAIN): string {
  if (!report) return meta.done ? `No AI report for this run yet. It usually lands a minute after the run ends.\n${st.dim(meta.url)}` : `The run is still ${meta.status}; the AI report follows when it ends.\n${st.dim(meta.url)}`
  const out: string[] = []
  out.push(st.bold(report.headline))
  out.push(`Health score ${report.healthScore}${report.verdict ? `, verdict ${verdictText(report.verdict, st)}` : ''}`)
  if (report.summary) out.push('', report.summary)
  if (report.findings?.length) {
    out.push('', st.bold('Findings'))
    for (const f of report.findings) {
      out.push(`- ${severityText(f.severity, st)} ${st.bold(f.title)}${f.endpoint ? st.dim(` (${f.endpoint})`) : ''}`)
      if (f.detail) out.push(`  ${f.detail}`)
      if (f.impact) out.push(`  Impact: ${f.impact}`)
      if (f.suggestion) out.push(`  Fix: ${f.suggestion}`)
      if (f.repro) out.push(`  Repro: ${f.repro}`)
    }
  }
  if (report.whatWorked?.length) out.push('', st.bold('What held up'), ...report.whatWorked.map((w) => `- ${w}`))
  if (report.nextSteps?.length) out.push('', st.bold('Next steps'), ...report.nextSteps.map((n) => `- ${n}`))
  if (report.notTested?.length) out.push('', st.bold('Not tested'), ...report.notTested.map((n) => `- ${n}`))
  if (report.residualRisk) out.push('', `${st.bold('Residual risk')}: ${report.residualRisk}`)
  out.push('', st.dim(meta.url))
  return out.join('\n')
}

function clip(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  if (s === undefined) return ''
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters; use --json for all of it)` : s
}

export function formatFinding(f: Finding & Record<string, unknown>, st: Style = PLAIN, maxEvidence = 2000): string {
  const out: string[] = []
  out.push(`${severityText(f.severity, st)} ${st.bold(f.title)} ${st.dim(`[${f.id}]`)}`)
  const where = f.endpoint ? `${f.endpoint.method} ${f.endpoint.path}` : f.url
  if (where) out.push(st.dim(where))
  if (f.detail) out.push('', f.detail)
  if (f.diagnosis) out.push('', `Diagnosis: ${f.diagnosis}`)
  if (f.fix?.length) out.push('', st.bold('How to fix'), ...f.fix.map((x) => `- ${x}`))
  else if (f.suggestion) out.push('', `${st.bold('How to fix')}: ${f.suggestion}`)
  if (f.steps?.length) out.push('', st.bold('Steps'), ...f.steps.map((x, i) => `${i + 1}. ${x}`))
  const ev = f.evidence ?? {}
  const req = ev.request as Record<string, unknown> | undefined
  const res = ev.response as Record<string, unknown> | undefined
  if (req) out.push('', st.bold('Request'), clip({ method: req.method, url: req.url, headers: req.headers, body: req.body }, maxEvidence))
  if (res) out.push('', st.bold('Response'), clip({ status: res.status, headers: res.headers, body: res.body, timeMs: res.timeMs ?? res.durationMs }, maxEvidence))
  if (Array.isArray(ev.assertions) && ev.assertions.length) {
    out.push('', st.bold('Checks'))
    for (const a of ev.assertions as { passed?: boolean; ok?: boolean; message?: string; type?: string }[]) out.push(`  ${(a.passed ?? a.ok) ? st.green('ok  ') : st.red('fail')} ${a.message ?? a.type ?? ''}`)
  }
  const stack = (ev.stack ?? ev.stackTrace) as string | undefined
  if (stack) out.push('', st.bold('Stack trace'), clip(stack, maxEvidence))
  const extra = Object.fromEntries(Object.entries(ev).filter(([k]) => !['request', 'response', 'assertions', 'stack', 'stackTrace', 'testName', 'failureReason', 'flaky', 'attempts'].includes(k)))
  if (Object.keys(extra).length) out.push('', st.bold('Evidence'), clip(extra, maxEvidence))
  const link = (f as Record<string, unknown>).runUrl
  if (typeof link === 'string' && /^https?:/.test(link)) out.push('', st.dim(link))
  return out.join('\n')
}

export function formatUsage(u: Usage, st: Style = PLAIN, now: Date = new Date()): string {
  const out: string[] = []
  out.push(`${st.bold(u.workspace.name)} on the ${u.planName} plan`)
  const sess = u.session
  const sessLine = sess.active ? `${sess.percent}% used (${money(sess.usedMicros)} of ${money(sess.budgetMicros)}), resets ${relativeTime(sess.resetAt, now) ?? 'soon'}` : `not started (${money(sess.budgetMicros)} per ${u.sessionHours} h session; it starts with the next piece of work)`
  out.push(`  This session: ${sess.percent >= 90 ? st.red(sessLine) : sessLine}`)
  out.push(`  This month:   ${u.month.unlimited ? `${money(u.month.usedMicros)} used, no monthly cap` : `${u.month.percent}% used (${money(u.month.usedMicros)} of ${money(u.month.allowanceMicros)}), resets ${relativeTime(u.month.resetAt, now) ?? 'soon'}`}`)
  if (u.extraCreditMicros > 0) out.push(`  Extra credit: ${money(u.extraCreditMicros)}`)
  if (u.blocked) out.push('', st.red(u.blocked.message))
  out.push('', st.dim(u.billingUrl))
  return out.join('\n')
}

export function formatPreview(p: ImportPreview, source: string, st: Style = PLAIN): string {
  const out: string[] = []
  out.push(`${st.bold(p.title ?? source)}${p.version ? st.dim(` v${p.version}`) : ''}: ${p.formatLabel}`)
  out.push(`  ${p.endpointCount} endpoint${p.endpointCount === 1 ? '' : 's'} found${p.dropped ? st.yellow(`, ${p.willImport} fit the ${p.quota.plan} plan (${p.dropped} left out)`) : ''}`)
  const methods = Object.entries(p.methods).map(([m, n]) => `${m} ${n}`).join(', ')
  if (methods) out.push(`  ${methods}`)
  if (p.baseUrl) out.push(`  Base URL ${p.baseUrl}`)
  if (p.authCount) out.push(`  ${p.authCount} need sign-in`)
  if (p.sample.length) {
    out.push('')
    for (const e of p.sample.slice(0, 12)) out.push(`  ${e.method.padEnd(7)} ${e.path}${e.summary ? st.dim(`  ${e.summary}`) : ''}`)
    if (p.sample.length > 12 || p.endpointCount > p.sample.length) out.push(st.dim(`  … and ${p.endpointCount - Math.min(12, p.sample.length)} more`))
  }
  for (const w of p.warnings) out.push(st.yellow(`  Note: ${w}`))
  for (const pr of p.problems) out.push(st.red(`  ${pr}`))
  return out.join('\n')
}

/* ---------- inbox issues ---------- */

const SOURCE_WORD: Record<string, string> = { production: 'Production', test_run: 'Test run', site_scan: 'Website scan', load_test: 'Load test' }

/** The cached explanation as text. Read-only: it never asks for a new one. */
export function formatExplanation(ai: IssueAi | null, url: string | null, st: Style = PLAIN): string {
  if (!ai) return `${st.bold('Explanation')}\nNo explanation yet. Open the issue in Check’d and press Explain with AI${url ? `: ${url}` : '.'}`
  const e = ai.explanation
  const out: string[] = []
  const based = ai.kind === 'ai' ? `AI, from ${ai.basedOn.occurrences} ${ai.basedOn.occurrences === 1 ? 'occurrence' : 'occurrences'}${ai.basedOn.release ? ` up to release ${ai.basedOn.release}` : ''}, ${relativeTime(ai.generatedAt) ?? 'recently'}` : 'from the run that found it'
  out.push(`${st.bold('Explanation')} ${st.dim(`(${based})`)}`)
  if (ai.stale) out.push(st.yellow(`Newer evidence since then: ${ai.reasons.join(', ')}. Refresh it in Check’d.`))
  out.push('', st.bold(e.summary), `Impact ${e.impact}, confidence ${e.confidence}.`)
  out.push('', st.bold('What is broken'), e.whatIsBroken)
  out.push('', st.bold('Likely root cause'), e.rootCause)
  out.push('', st.bold('Who is affected'), e.whoIsAffected)
  if (e.whereToLook.length) out.push('', st.bold('Where to look'), ...e.whereToLook.map((w) => `- ${w.file}${w.line ? `:${w.line}` : ''}${w.function ? ` (${w.function})` : ''}: ${w.why}`))
  if (e.suggestedFix.length) out.push('', st.bold('Suggested fix'), ...e.suggestedFix.map((s, i) => `${i + 1}. ${s}`))
  if (e.confidenceReason) out.push('', `${st.bold('How sure')}: ${e.confidenceReason}`)
  if (e.unknowns.length) out.push('', st.bold('What would settle it'), ...e.unknowns.map((s) => `- ${s}`))
  if (ai.source?.files.length) out.push('', st.dim(`Code read from ${ai.source.repo} at ${ai.source.label}.`))
  else if (ai.source?.note) out.push('', st.dim(ai.source.note))
  return out.join('\n')
}

/** One inbox issue: what, how often, for whom, the evidence summary, its fix PR; the explanation with `explain`. */
export function formatIssue(i: InboxIssue & Partial<Omit<InboxIssueDetail, keyof InboxIssue>>, st: Style = PLAIN, opts: { explain?: boolean } = {}): string {
  const out: string[] = []
  out.push(`${severityText(i.severity, st)} ${st.bold(i.title)} ${st.dim(`[${i.ref}]`)}`)
  if (i.culprit) out.push(st.dim(i.culprit))
  const prod = i.source === 'production'
  const facts = [
    SOURCE_WORD[i.source] ?? i.source,
    i.status,
    `${i.occurrences} ${prod ? (i.occurrences === 1 ? 'time' : 'times') : i.occurrences === 1 ? 'run' : 'runs'}`,
    prod ? `${i.usersAffected} ${i.usersAffected === 1 ? 'user' : 'users'}` : null,
    i.firstRelease ? `first seen in ${i.firstRelease}` : null,
    i.regressedInRelease ? `came back in ${i.regressedInRelease}` : null,
    `last seen ${relativeTime(i.lastSeenAt) ?? 'recently'}`,
  ].filter(Boolean)
  out.push(facts.join(' · '))
  const ev = i.evidence
  if (ev) {
    if (ev.error) out.push('', `${st.bold('Error')}: ${ev.error.type}: ${ev.error.message}`)
    if (ev.request) out.push('', `${st.bold('Request')}: ${ev.request.method} ${ev.request.host ?? ''}${ev.request.route} answered ${ev.request.status || 'with a network error'}`)
    if (ev.page) out.push(`${st.bold('Page')}: ${ev.page}`)
    if (ev.frames.length) out.push('', st.bold('Stack (your code)'), ...ev.frames.slice(0, 8).map((f) => `  at ${f.fn === '?' ? '(anonymous)' : f.fn} ${f.file}${f.line ? `:${f.line}` : ''}`))
    if (ev.breadcrumbs.length) out.push('', st.bold('Before it happened'), ...ev.breadcrumbs.slice(-8).map((b) => `  ${b.secondsBefore !== null ? `${b.secondsBefore}s before` : 'before'} [${b.type}] ${b.message}`))
  }
  if (i.fixPr) out.push('', `${st.bold('Fix pull request')}: ${i.fixPr.status}${i.fixPr.number ? ` #${i.fixPr.number}` : ''}${i.fixPr.url ? ` ${i.fixPr.url}` : ''}`)
  if (opts.explain) out.push('', formatExplanation(i.explanation ?? null, i.url, st))
  else if (i.aiSummary) out.push('', `${st.bold('AI summary')}: ${i.aiSummary}`, st.dim(`Full explanation: checked issues show ${i.ref} --explain`))
  out.push('', st.dim(i.url))
  return out.join('\n')
}
