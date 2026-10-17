import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseDuration } from '../src/cli/args.js'
import { table, useColor, styleFor, visibleLength } from '../src/cli/output.js'
import { ApiError, ArgError, EXIT, UsageLimitError, exitCodeFor, relativeTime, usageLimitMessage, errorJson, NotSignedInError } from '../src/core/errors.js'
import { toApiError, CheckedClient } from '../src/core/client.js'
import { normalizeApiUrl, resolveCredential, resolveApiUrl, writeConfig, readConfig, clearConfigToken, configPath, maskToken, DEFAULT_API_URL } from '../src/core/config.js'
import { SseParser } from '../src/core/sse.js'
import { runOutcome, formatSummary, formatUsage, money, formatFinding, formatIssue } from '../src/core/format.js'
import { issuesProvider, severityAndWorse } from '../src/core/issues.js'
import { VERSION } from '../src/version.js'
import { mockFetch, summary, tempConfigDir } from './helpers.js'

const here = dirname(fileURLToPath(import.meta.url))

test('args: long, short, inline values, negation and unknown flags', () => {
  const spec = { project: { type: 'string' as const, alias: 'p' }, limit: { type: 'number' as const }, yes: { type: 'boolean' as const, alias: 'y' }, wait: { type: 'boolean' as const } }
  const a = parseArgs(['abc', '--project', 'pay-x', '--limit=5', '-y', '--no-wait', '--json'], spec)
  assert.deepEqual(a.positionals, ['abc'])
  assert.equal(a.flags.project, 'pay-x')
  assert.equal(a.flags.limit, 5)
  assert.equal(a.flags.yes, true)
  assert.equal(a.flags.wait, false)
  assert.equal(a.flags.json, true)
  assert.equal(parseArgs(['-p', 'x'], spec).flags.project, 'x')
  assert.equal(parseArgs(['-px'], spec).flags.project, 'x')
  assert.deepEqual(parseArgs(['--', '--not-a-flag'], spec).positionals, ['--not-a-flag'])
  assert.throws(() => parseArgs(['--projet', 'x'], spec), (e: unknown) => e instanceof ArgError && /Unknown option --projet/.test((e as Error).message))
  assert.throws(() => parseArgs(['--project'], spec), /needs a value/)
  assert.throws(() => parseArgs(['--limit', 'many'], spec), /must be a number/)
  assert.throws(() => parseArgs(['--yes=maybe'], spec), /takes no value/)
})

test('args: durations', () => {
  assert.equal(parseDuration(undefined, 5), 5)
  assert.equal(parseDuration('90', 0), 90_000)
  assert.equal(parseDuration('90s', 0), 90_000)
  assert.equal(parseDuration('15m', 0), 900_000)
  assert.equal(parseDuration('1h30m', 0), 5_400_000)
  assert.throws(() => parseDuration('soon', 0), ArgError)
  assert.throws(() => parseDuration('5 parsecs', 0), ArgError)
})

test('colour respects NO_COLOR, --no-color, --color, FORCE_COLOR and the terminal', () => {
  assert.equal(useColor({ env: {}, isTTY: true }), true)
  assert.equal(useColor({ env: {}, isTTY: false }), false)
  assert.equal(useColor({ env: { NO_COLOR: '1' }, isTTY: true }), false)
  assert.equal(useColor({ env: { NO_COLOR: '1' }, isTTY: true, flag: true }), false)
  assert.equal(useColor({ env: {}, isTTY: true, flag: false }), false)
  assert.equal(useColor({ env: {}, isTTY: false, flag: true }), true)
  assert.equal(useColor({ env: { FORCE_COLOR: '1' }, isTTY: false }), true)
  assert.equal(useColor({ env: { TERM: 'dumb' }, isTTY: true }), false)
  assert.equal(styleFor(false).red('x'), 'x')
  assert.notEqual(styleFor(true).red('x'), 'x')
})

test('tables align on visible width and cut long cells', () => {
  const st = styleFor(true)
  const out = table(['A', 'BB'], [[st.red('one'), 'x'], ['three', 'y'.repeat(100)]], st, 20)
  const lines = out.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))
  assert.equal(lines[1].indexOf('x'), lines[2].indexOf('y'))
  assert.ok(visibleLength(out.split('\n')[2]) <= 'three  '.length + 20)
  assert.match(lines[2], /…$/)
  assert.equal(table(['A'], [], st), '')
})

test('a 402 becomes a usage-limit error with the reset time spelled out', () => {
  const now = new Date('2026-10-16T10:00:00Z')
  const e = toApiError(402, { message: "You have used this session's allowance on Starter. It refreshes in 3 hours. Higher plans give more usage per session.", code: 'session', resetAt: '2026-10-16T12:59:00Z' })
  assert.ok(e instanceof UsageLimitError)
  assert.equal(exitCodeFor(e), EXIT.USAGE_LIMIT)
  const msg = usageLimitMessage(e as UsageLimitError, now)
  assert.match(msg, /You have used this session's allowance on Starter/)
  assert.match(msg, /Resets in 2 h 59 min/)
  const plan = toApiError(402, { message: 'AI exploration is on the Business plan.', code: 'plan', feature: 'aiExplorer', requiredPlan: 'business' }) as UsageLimitError
  assert.match(usageLimitMessage(plan, now), /Needs the Business plan or higher/)
  assert.equal(errorJson(e, now).resetAt, '2026-10-16T12:59:00Z')
  assert.equal(errorJson(e, now).exitCode, 4)
})

test('error mapping and messages', () => {
  assert.equal(exitCodeFor(new ApiError('x', 401)), EXIT.AUTH)
  assert.equal(exitCodeFor(new ApiError('x', 404)), EXIT.NOT_FOUND)
  assert.equal(exitCodeFor(new ApiError('x', 403)), EXIT.NOT_FOUND)
  assert.equal(exitCodeFor(new ApiError('x', 429)), EXIT.RATE_LIMITED)
  assert.equal(exitCodeFor(new ApiError('x', 422)), EXIT.BAD_ARGS)
  assert.equal(exitCodeFor(new ApiError('x', 500)), EXIT.ERROR)
  assert.equal(exitCodeFor(new NotSignedInError()), EXIT.AUTH)
  assert.equal(exitCodeFor(new ArgError('x')), EXIT.BAD_ARGS)
  assert.equal(toApiError(422, { errors: [{ message: 'The url field must be a valid URL', field: 'url' }] }).message, 'The url field must be a valid URL (url)')
  assert.equal(toApiError(500, null).message, 'The API answered 500.')
  const now = new Date('2026-10-16T10:00:00Z')
  assert.equal(relativeTime('2026-10-16T10:00:20Z', now), 'in under a minute')
  assert.equal(relativeTime('2026-10-16T10:40:00Z', now), 'in 40 min')
  assert.equal(relativeTime('2026-10-16T09:00:00Z', now), 'now')
  assert.equal(relativeTime('2026-10-20T10:00:00Z', now), 'in 4 days')
})

test('credentials: env key beats token beats the saved file; URLs normalise', () => {
  assert.equal(resolveCredential({ CHECKED_API_KEY: 'tfy_a', CHECKED_TOKEN: 'oat_b' }, { token: 'oat_c' })?.source, 'env:CHECKED_API_KEY')
  assert.equal(resolveCredential({ CHECKED_API_KEY: 'tfy_a' })?.kind, 'key')
  assert.equal(resolveCredential({ CHECKED_TOKEN: 'oat_b' }, { token: 'oat_c' })?.token, 'oat_b')
  assert.equal(resolveCredential({}, { token: 'oat_c' })?.source, 'config')
  assert.equal(resolveCredential({}, {}), null)
  assert.equal(normalizeApiUrl('https://getchecked.twelveai.app/api/v1/'), 'https://getchecked.twelveai.app')
  assert.equal(normalizeApiUrl('localhost:4399'), 'https://localhost:4399')
  assert.equal(normalizeApiUrl('http://localhost:4399/api'), 'http://localhost:4399')
  assert.equal(resolveApiUrl({ env: {} }), DEFAULT_API_URL)
  assert.equal(resolveApiUrl({ env: { CHECKED_API_URL: 'http://a.test' }, config: { apiUrl: 'http://b.test' } }), 'http://a.test')
  assert.equal(resolveApiUrl({ flag: 'http://c.test', env: { CHECKED_API_URL: 'http://a.test' } }), 'http://c.test')
  assert.equal(maskToken('tfy_0123456789abcdef'), 'tfy_0123…cdef')
})

test('the config file is written owner-only and the token can be cleared', async () => {
  const env = { CHECKED_CONFIG_DIR: tempConfigDir() }
  const path = await writeConfig({ apiUrl: 'http://x.test', token: 'oat_secret', tokenKind: 'user' }, env)
  assert.equal(path, configPath(env))
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal((await readConfig(env)).token, 'oat_secret')
  await clearConfigToken(env)
  const after = await readConfig(env)
  assert.equal(after.token, undefined)
  assert.equal(after.apiUrl, 'http://x.test')
})

test('SSE parser handles split chunks, comments and CRLF', () => {
  const p = new SseParser()
  assert.deepEqual(p.push('event: status\ndata: {"a"'), [])
  assert.deepEqual(p.push(':1}\n\n: ping\n\n'), [{ event: 'status', data: '{"a":1}' }])
  assert.deepEqual(p.push('data: x\r\n\r\n'), [{ event: 'message', data: 'x' }])
})

test('client sends the bearer, unwraps data and refuses to call without a credential', async () => {
  const { fetch, calls } = mockFetch((c) => (c.path === '/cli/whoami' ? { body: { data: { kind: 'key', workspaces: [] } } } : undefined))
  const c = new CheckedClient({ apiUrl: 'http://api.test/', token: 'tfy_k', fetch })
  const who = await c.whoami()
  assert.equal(who.kind, 'key')
  assert.equal(calls[0].url, 'http://api.test/api/v1/cli/whoami')
  assert.equal(calls[0].headers.authorization, 'Bearer tfy_k')
  assert.match(calls[0].headers['user-agent'], /^checked-cli\//)
  await assert.rejects(new CheckedClient({ apiUrl: 'http://api.test', fetch }).whoami(), NotSignedInError)
  const down = new CheckedClient({ apiUrl: 'http://down.test', token: 't', fetch: async () => { throw new Error('ECONNREFUSED') } })
  await assert.rejects(down.whoami(), /Could not reach the Check’d API at http:\/\/down.test/)
})

test('run outcome: gates decide; --no-gates uses the status; errored and cancelled are 2', () => {
  assert.equal(runOutcome(summary()).code, EXIT.OK)
  const failing = summary({ run: { status: 'passed' }, gates: { passed: false, pendingReport: false, checks: [{ key: 'critical', label: 'Critical defects', ok: false, actual: '2', target: '≤ 0' }] } })
  const o = runOutcome(failing)
  assert.equal(o.code, EXIT.GATES_FAILED)
  assert.match(o.reason, /Critical defects 2 \(needs ≤ 0\)/)
  assert.equal(runOutcome(failing, false).code, EXIT.OK)
  assert.equal(runOutcome(summary({ run: { status: 'failed' }, gates: null })).code, EXIT.GATES_FAILED)
  assert.equal(runOutcome(summary({ run: { status: 'errored', error: 'boom' } })).code, EXIT.RUN_ERRORED)
  assert.equal(runOutcome(summary({ run: { status: 'cancelled' } })).code, EXIT.RUN_ERRORED)
  assert.equal(runOutcome(summary({ run: { status: 'running' } })).code, EXIT.TIMEOUT)
})

test('summary, usage and finding text', () => {
  const s = formatSummary(summary({ report: { headline: 'Checkout is solid', verdict: 'ship', healthScore: 92, summary: null, nextSteps: [] } }))
  assert.match(s, /API tests hbtqwpmz on Payments API: passed/)
  assert.match(s, /Release gates: met/)
  assert.match(s, /AI report: ship/)
  assert.equal(money(1_234_567), '$1.23')
  const u = formatUsage({ workspace: { id: 1, slug: 'acme', name: 'Acme' }, plan: 'starter', planName: 'Starter', sessionHours: 5, session: { startedAt: 'x', resetAt: '2026-10-16T12:00:00Z', usedMicros: 500_000, budgetMicros: 1_000_000, percent: 50, active: true }, month: { usedMicros: 2_000_000, allowanceMicros: 20_000_000, percent: 10, resetAt: '2026-11-01T00:00:00Z', unlimited: false }, extraCreditMicros: 0, blocked: null, billingUrl: 'http://app.test/settings/billing' }, undefined, new Date('2026-10-16T10:00:00Z'))
  assert.match(u, /This session: 50% used \(\$0\.50 of \$1\.00\), resets in 2 h/)
  const f = formatFinding({ id: 'r9', source: 'api_test', severity: 'critical', category: 'negative', title: 'POST /orders crashed with 500.', detail: 'The server failed.', status: 'failed', runId: 7, runRef: 'x', projectId: 3, endpoint: { method: 'POST', path: '/orders' }, url: 'https://api.test/orders', diagnosis: 'bug', suggestion: 'Handle it', fix: ['Find the error', 'Handle it'], steps: [], evidence: { request: { method: 'POST', url: 'https://api.test/orders', body: { a: 1 } }, response: { status: 500, body: 'oops' }, stack: 'Error: oops\n  at handler' }, createdAt: null, runUrl: 'http://app.test/run' })
  assert.match(f, /critical POST \/orders crashed with 500\. \[r9\]/)
  assert.match(f, /How to fix\n- Find the error/)
  assert.match(f, /Stack trace\nError: oops/)
  assert.match(f, /http:\/\/app.test\/run$/)
})

test('issues come through the findings provider when the server has no inbox', async () => {
  const { fetch, calls } = mockFetch((c) => (c.path === '/cli/projects/pay/findings' ? { body: { data: [{ id: 'f1', severity: 'high', title: 'Broken link' }], meta: { run: { id: 7, ref: 'r', kind: 'frontend_health', status: 'failed', finishedAt: null, url: 'u' }, total: 1 } } } : undefined))
  const p = issuesProvider(new CheckedClient({ apiUrl: 'http://api.test', token: 't', fetch }))
  assert.equal(p.name, 'findings')
  const list = await p.list({ projectId: 'pay', severity: 'high' })
  assert.equal(list.issues[0].origin, 'test')
  assert.equal(list.issues[0].occurrences, 1)
  assert.equal(list.scope.kind, 'run')
  assert.equal(calls[0].query.get('severity'), 'high')
})

test('version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))
  assert.equal(pkg.version, VERSION)
})

const INBOX_ISSUE = { id: 'kqzxmvbt', ref: 'kqzxmvbt', source: 'production', kind: 'error', severity: 'high', status: 'regressed', title: "TypeError: Cannot read properties of undefined (reading 'amount')", culprit: 'formatTotal in /src/cart/CartTotal.tsx line 42', errorType: 'TypeError', environment: 'production', occurrences: 46, usersAffected: 23, firstSeenAt: '2026-10-01T10:00:00Z', lastSeenAt: '2026-10-16T10:00:00Z', firstRelease: '1.4.0', lastRelease: '1.4.2', regressedInRelease: '1.4.2', explained: true, aiSummary: 'Checkout crashes after a promo code', hasFixPr: true, projectId: 3, url: 'http://app.test/projects/shop-abcde/issues/kqzxmvbt' } as const
const EXPLANATION = { kind: 'ai', explanation: { summary: 'Checkout crashes after a promo code', whatIsBroken: 'Pay fails.', rootCause: 'total is read before it loads.', whoIsAffected: '23 users.', impact: 'critical', whereToLook: [{ file: 'src/cart/CartTotal.tsx', line: 42, function: 'formatTotal', why: 'No guard.' }], suggestedFix: ['Guard the total.'], confidence: 'high', confidenceReason: 'The frame shows it.', unknowns: [] }, basedOn: { occurrences: 43, usersAffected: 23, release: '1.4.2', at: '2026-10-16T08:00:00Z' }, source: { repo: 'acme/shop', ref: 'f3a91c2', label: 'tag v1.4.2', note: null, files: [{ path: 'src/cart/CartTotal.tsx', start: 22, end: 62 }] }, model: 'm', generatedAt: '2026-10-16T08:00:00Z', stale: true, newOccurrences: 3, reasons: ['3 new occurrences'] }

test('with the inbox capability, issues come from the inbox; finding ids and run lists still work', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.path === '/cli/projects/shop/issues') return { body: { data: [INBOX_ISSUE], meta: { total: 1, url: 'http://app.test/projects/shop/issues' } } }
    if (c.path === '/cli/issues/kqzxmvbt') return { body: { data: { ...INBOX_ISSUE, evidence: { error: null, frames: [], request: null, page: null, breadcrumbs: [] }, explanation: EXPLANATION, fixPr: null } } }
    if (c.path === '/cli/findings/r12') return { body: { data: { id: 'r12', severity: 'high', title: 'A failed test' } } }
    if (c.path === '/cli/projects/shop/findings') return { body: { data: [], meta: { run: { id: 7, ref: 'r', kind: 'suite', status: 'passed', finishedAt: null, url: 'u' }, total: 0 } } }
    return undefined
  })
  const p = issuesProvider(new CheckedClient({ apiUrl: 'http://api.test', token: 't', fetch }), { issuesInbox: true })
  assert.equal(p.name, 'inbox')
  const list = await p.list({ projectId: 'shop', severity: 'high', status: 'all' })
  assert.equal(list.scope.kind, 'inbox')
  assert.equal(list.issues[0].id, 'kqzxmvbt')
  assert.equal(list.issues[0].origin, 'production')
  assert.equal(calls[0].query.get('severity'), 'critical,high')
  assert.equal(calls[0].query.get('status'), 'all')
  const one = await p.show('kqzxmvbt')
  assert.equal((one as any).explanation.explanation.impact, 'critical')
  assert.equal((await p.show('r12')).id, 'r12')
  assert.equal((await p.list({ projectId: 'shop', runId: 7 })).scope.kind, 'run')
  assert.equal(severityAndWorse('medium'), 'critical,high,medium')
  assert.equal(severityAndWorse(undefined), undefined)
})

test('issue text: facts, AI summary hint, and the explanation only with explain', () => {
  const plain = formatIssue({ ...INBOX_ISSUE, explanation: EXPLANATION as any })
  assert.match(plain, /Production · regressed · 46 times · 23 users · first seen in 1\.4\.0 · came back in 1\.4\.2/)
  assert.match(plain, /AI summary: Checkout crashes after a promo code/)
  assert.match(plain, /checked issues show kqzxmvbt --explain/)
  assert.doesNotMatch(plain, /Likely root cause/)
  const full = formatIssue({ ...INBOX_ISSUE, explanation: EXPLANATION as any }, undefined, { explain: true })
  assert.match(full, /Explanation \(AI, from 43 occurrences up to release 1\.4\.2/)
  assert.match(full, /Newer evidence since then: 3 new occurrences/)
  assert.match(full, /- src\/cart\/CartTotal\.tsx:42 \(formatTotal\): No guard\./)
  assert.match(full, /Code read from acme\/shop at tag v1\.4\.2\./)
  assert.doesNotMatch(full, new RegExp(String.fromCharCode(0x2014)))
  const none = formatIssue({ ...INBOX_ISSUE, explanation: null }, undefined, { explain: true })
  assert.match(none, /No explanation yet\. Open the issue in Check’d and press Explain with AI: http:\/\/app\.test/)
})
