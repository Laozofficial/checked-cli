import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mockFetch, runCli, run, summary, tempConfigDir } from './helpers.js'

const KEY = { CHECKED_API_KEY: 'tfy_test_key' }

const projects = [{ id: 3, ref: 'pay-abcde', name: 'Payments API', kind: 'backend', baseUrl: 'https://api.example.com', workspace: { id: 1, slug: 'acme', name: 'Acme' }, endpointCount: 12, suiteCount: 3, lastRun: run({ status: 'passed' }), archivedAt: null, url: 'http://app.test/projects/pay-abcde' }]

test('unknown command and unknown option exit 64', async () => {
  const { fetch } = mockFetch(() => undefined)
  const a = await runCli(['frobnicate'], { fetch })
  assert.equal(a.code, 64)
  assert.match(a.stderr, /Unknown command "frobnicate"/)
  const b = await runCli(['projects', 'list', '--frob'], { fetch, env: KEY })
  assert.equal(b.code, 64)
  assert.match(b.stderr, /Unknown option --frob/)
})

test('--help and --version need no sign-in', async () => {
  const { fetch, calls } = mockFetch(() => undefined)
  const h = await runCli(['run', '--help'], { fetch })
  assert.equal(h.code, 0)
  assert.match(h.stdout, /Usage: checked run --project/)
  const v = await runCli(['--version'], { fetch })
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/)
  assert.equal(calls.length, 0)
})

test('without a credential commands exit 5 with a hint', async () => {
  const { fetch } = mockFetch(() => undefined)
  const r = await runCli(['projects', 'list'], { fetch })
  assert.equal(r.code, 5)
  assert.match(r.stderr, /Run `checked login`/)
})

test('projects list: a table by default, JSON with --json', async () => {
  const { fetch, calls } = mockFetch((c) => (c.path === '/cli/projects' ? { body: { data: projects } } : undefined))
  const human = await runCli(['projects', 'list'], { fetch, env: KEY })
  assert.equal(human.code, 0)
  assert.match(human.stdout, /REF\s+NAME\s+KIND/)
  assert.match(human.stdout, /pay-abcde\s+Payments API\s+api/)
  assert.doesNotMatch(human.stdout, /\u001b\[/)
  assert.equal(calls[0].headers.authorization, 'Bearer tfy_test_key')
  const json = await runCli(['projects', 'list', '--json', '--workspace', 'acme'], { fetch, env: KEY })
  assert.deepEqual(JSON.parse(json.stdout)[0].ref, 'pay-abcde')
  assert.equal(calls[1].query.get('workspace'), 'acme')
})

test('a 402 on run prints the allowance message and exits 4; --json puts it on stderr as JSON', async () => {
  const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString()
  const { fetch } = mockFetch((c) => (c.method === 'POST' && c.path === '/cli/projects/pay-abcde/runs' ? { status: 402, body: { message: "You have used this session's allowance on Free. It refreshes in 3 hours. Higher plans give more usage per session.", code: 'session', resetAt } } : undefined))
  const r = await runCli(['run', '--project', 'pay-abcde'], { fetch, env: KEY })
  assert.equal(r.code, 4)
  assert.match(r.stderr, /Usage limit: You have used this session's allowance on Free/)
  assert.match(r.stderr, /Resets in (2 h 59 min|3 h)/)
  const j = await runCli(['run', '--project', 'pay-abcde', '--json'], { fetch, env: KEY })
  assert.equal(j.code, 4)
  assert.equal(j.stdout, '')
  const err = JSON.parse(j.stderr).error
  assert.equal(err.status, 402)
  assert.equal(err.code, 'session')
  assert.equal(err.resetAt, resetAt)
})

function runServer(final: ReturnType<typeof summary>) {
  let polls = 0
  return mockFetch((c) => {
    if (c.method === 'POST' && c.path === '/cli/projects/pay-abcde/runs') return { status: 201, body: { data: run({ status: 'queued' }) } }
    if (c.path === '/cli/runs/7/events') return { sse: `event: log\ndata: {"type":"log","level":"info","message":"Running 10 tests"}\n\nevent: status\ndata: {"type":"status","status":"${final.run.status}","total":10,"passed":10,"failed":0,"errored":0,"skipped":0,"durationMs":1}\n\n` }
    if (c.path === '/cli/runs/7') return { body: { data: run({ status: ++polls < 3 ? 'running' : final.run.status }) } }
    if (c.path === '/cli/runs/7/summary') return { body: { data: final } }
    return undefined
  })
}

test('run follows the run and exits 0 when the gates pass', async () => {
  const { fetch, calls } = runServer(summary())
  const r = await runCli(['run', '-p', 'pay-abcde', '--depth', 'critical'], { fetch, env: KEY })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(calls.find((c) => c.method === 'POST')!.body, { depth: 'critical' })
  assert.match(r.stderr, /Running 10 tests/)
  assert.match(r.stdout, /Release gates: met/)
  assert.match(r.stdout, /The run met its release gates/)
})

test('run exits 1 when the gates fail, and 0 with --no-gates if the run passed', async () => {
  const failing = summary({ gates: { passed: false, pendingReport: false, checks: [{ key: 'pass_rate', label: 'Pass rate', ok: false, actual: '80%', target: '≥ 95%' }] } })
  const a = await runCli(['run', '-p', 'pay-abcde'], { fetch: runServer(failing).fetch, env: KEY })
  assert.equal(a.code, 1)
  assert.match(a.stdout, /Release gates not met: Pass rate 80%/)
  const b = await runCli(['run', '-p', 'pay-abcde', '--no-gates', '--json'], { fetch: runServer(failing).fetch, env: KEY })
  assert.equal(b.code, 0)
  assert.equal(JSON.parse(b.stdout).exitCode, 0)
})

test('run exits 2 when the run errors', async () => {
  const r = await runCli(['run', '-p', 'pay-abcde', '--no-stream'], { fetch: runServer(summary({ run: { status: 'errored', error: 'Environment unreachable' }, gates: null })).fetch, env: KEY })
  assert.equal(r.code, 2)
  assert.match(r.stdout, /The run errored: Environment unreachable/)
})

test('run --no-wait starts and returns at once', async () => {
  const { fetch, calls } = runServer(summary())
  const r = await runCli(['run', '-p', 'pay-abcde', '--no-wait', '--json'], { fetch, env: KEY })
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.stdout).run.status, 'queued')
  assert.equal(calls.filter((c) => c.path.startsWith('/cli/runs/')).length, 0)
})

test('run times out with exit 3 while the server keeps going', async () => {
  const { fetch } = mockFetch((c) => {
    if (c.method === 'POST') return { status: 201, body: { data: run({ status: 'queued' }) } }
    if (c.path === '/cli/runs/7') return { body: { data: run({ status: 'running' }) } }
    if (c.path === '/cli/runs/7/summary') return { body: { data: summary({ run: { status: 'running', done: false }, gates: null }) } }
    return undefined
  })
  const r = await runCli(['run', '-p', 'pay-abcde', '--no-stream', '--timeout', '20s'], { fetch, env: KEY })
  assert.equal(r.code, 3)
  assert.match(r.stdout, /Timed out waiting/)
})

test('--env resolves an environment by name', async () => {
  const { fetch, calls } = mockFetch((c) => {
    if (c.path === '/cli/projects/pay-abcde/environments') return { body: { data: [{ id: 4, projectId: 3, name: 'Staging', baseUrl: 'https://s.test', isDefault: true, auth: { type: 'none' }, variables: {} }] } }
    if (c.method === 'POST') return { status: 201, body: { data: run({ status: 'queued' }) } }
    return undefined
  })
  const ok = await runCli(['run', '-p', 'pay-abcde', '--env', 'staging', '--no-wait'], { fetch, env: KEY })
  assert.equal(ok.code, 0)
  assert.equal(calls.find((c) => c.method === 'POST')!.body.environmentId, 4)
  const bad = await runCli(['run', '-p', 'pay-abcde', '--env', 'prod', '--no-wait'], { fetch, env: KEY })
  assert.equal(bad.code, 64)
  assert.match(bad.stderr, /No environment "prod".*Staging/)
})

const preview = { ok: true, format: 'openapi3', formatLabel: 'OpenAPI 3', formatMatches: true, title: 'Petstore', version: '1.0', baseUrl: 'https://petstore.test', endpointCount: 3, willImport: 3, dropped: 0, quota: { max: 25, used: 0, remaining: 25, plan: 'Free' }, methods: { GET: 2, POST: 1 }, authCount: 0, withBody: 1, tags: [], warnings: [], problems: [], sample: [{ method: 'GET', path: '/pets', summary: 'List pets', auth: false }] }

function importServer() {
  return mockFetch((c) => {
    if (c.path === '/cli/projects/pay-abcde/import/preview') return { body: { data: preview } }
    if (c.path === '/cli/projects/pay-abcde/import') return { status: 201, body: { data: { id: 1, projectId: 3, title: 'Petstore', version: '1.0', format: 'openapi3', endpointCount: 3, warnings: [], projectUrl: 'http://app.test/projects/pay-abcde/endpoints' } } }
    return undefined
  })
}

test('import shows what it found and will not save without --yes when it cannot ask', async () => {
  const dir = tempConfigDir()
  const file = join(dir, 'openapi.json')
  await import('node:fs/promises').then((fs) => fs.writeFile(file, JSON.stringify({ openapi: '3.0.0', paths: {} })))
  const { fetch, calls } = importServer()
  const r = await runCli(['import', file, '-p', 'pay-abcde'], { fetch, env: KEY })
  assert.equal(r.code, 64)
  assert.match(r.stderr, /Pass --yes to import without a prompt/)
  assert.equal(calls.filter((c) => c.path.endsWith('/import')).length, 0)
  assert.equal(calls[0].body.filename, 'openapi.json')
  assert.match(calls[0].body.content, /openapi/)
})

test('import --yes saves; a URL is sent as a URL; --dry-run never saves', async () => {
  const dir = tempConfigDir()
  const file = join(dir, 'spec.yaml')
  await import('node:fs/promises').then((fs) => fs.writeFile(file, 'openapi: 3.0.0\npaths: {}\n'))
  const s = importServer()
  const r = await runCli(['import', file, '-p', 'pay-abcde', '--yes'], { fetch: s.fetch, env: KEY })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Imported 3 endpoints from Petstore/)
  const u = importServer()
  await runCli(['import', 'https://petstore.test/openapi.json', '-p', 'pay-abcde', '--yes', '--replace'], { fetch: u.fetch, env: KEY })
  assert.equal(u.calls[0].body.url, 'https://petstore.test/openapi.json')
  assert.equal(u.calls[1].body.replace, true)
  const d = importServer()
  const dry = await runCli(['import', file, '-p', 'pay-abcde', '--dry-run', '--json'], { fetch: d.fetch, env: KEY })
  assert.equal(dry.code, 0)
  assert.equal(JSON.parse(dry.stdout).saved, null)
  assert.equal(d.calls.length, 1)
  const missing = await runCli(['import', join(dir, 'nope.json'), '-p', 'pay-abcde', '--yes'], { fetch: s.fetch, env: KEY })
  assert.equal(missing.code, 64)
})

test('login --api-key checks the key and saves it owner-only; logout forgets it', async () => {
  const { fetch } = mockFetch((c) => (c.path === '/cli/whoami' ? { body: { data: { kind: 'key', user: null, key: { id: 1, name: 'CI', prefix: 'tfy_abc', workspaceId: 1 }, workspaces: [{ id: 1, name: 'Acme', slug: 'acme', plan: 'starter', role: 'member' }], apiVersion: 1, capabilities: {}, appUrl: 'http://app.test' } } } : undefined))
  const dir = tempConfigDir()
  const r = await runCli(['login', '--api-key', 'tfy_abcdef0123456789'], { fetch, env: { CHECKED_CONFIG_DIR: dir } })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Signed in as API key CI/)
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(cfg.token, 'tfy_abcdef0123456789')
  assert.equal(cfg.tokenKind, 'key')
  const who = await runCli(['whoami', '--json'], { fetch, env: { CHECKED_CONFIG_DIR: dir } })
  assert.equal(JSON.parse(who.stdout).credential.token, 'tfy_abcd…6789')
  const out = await runCli(['logout'], { fetch, env: { CHECKED_CONFIG_DIR: dir } })
  assert.equal(out.code, 0)
  assert.match(out.stdout, /still works elsewhere until you revoke it/)
  // The API URL stays remembered; the credential is gone.
  assert.equal(existsSync(join(dir, 'config.json')) ? JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).token : undefined, undefined)
})

test('login in the browser: shows the code, polls until approved, saves the token', async () => {
  let polls = 0
  const { fetch, calls } = mockFetch((c) => {
    if (c.path === '/cli/device') return { status: 201, body: { data: { deviceCode: 'cdc_x', userCode: 'BCDF-GHJK', expiresIn: 600, interval: 5, verificationUri: 'http://app.test/cli/authorize', verificationUriComplete: 'http://app.test/cli/authorize?code=BCDF-GHJK' } } }
    if (c.path === '/cli/device/token') return ++polls < 3 ? { status: 400, body: { error: 'authorization_pending', message: 'Waiting' } } : { body: { data: { token: 'oat_new', tokenType: 'bearer', expiresAt: null, user: { id: 1, email: 'dev@acme.test', fullName: 'Dev' } } } }
    if (c.path === '/cli/whoami') return { body: { data: { kind: 'user', user: { id: 1, email: 'dev@acme.test', fullName: 'Dev', emailVerified: true }, key: null, workspaces: [], apiVersion: 1, capabilities: {}, appUrl: 'http://app.test' } } }
    return undefined
  })
  const dir = tempConfigDir()
  const opened: string[] = []
  const r = await runCli(['login'], { fetch, env: { CHECKED_CONFIG_DIR: dir }, opened })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stderr, /enter the code BCDF-GHJK/)
  assert.deepEqual(opened, ['http://app.test/cli/authorize?code=BCDF-GHJK'])
  assert.equal(calls.filter((c) => c.path === '/cli/device/token').length, 3)
  assert.equal(calls.find((c) => c.path === '/cli/device')!.headers.authorization, undefined)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).token, 'oat_new')
  assert.match(r.stdout, /Signed in as dev@acme.test/)
})

test('login stops when the browser denies it', async () => {
  const { fetch } = mockFetch((c) => {
    if (c.path === '/cli/device') return { status: 201, body: { data: { deviceCode: 'cdc_x', userCode: 'BCDF-GHJK', expiresIn: 600, interval: 1, verificationUri: 'u', verificationUriComplete: 'u' } } }
    if (c.path === '/cli/device/token') return { status: 400, body: { error: 'access_denied' } }
    return undefined
  })
  const r = await runCli(['login', '--no-browser'], { fetch, env: { CHECKED_CONFIG_DIR: tempConfigDir() } })
  assert.equal(r.code, 5)
  assert.match(r.stderr, /denied/)
})

test('findings list and show, and issues use the same data', async () => {
  const finding = { id: 'r12', source: 'api_test', severity: 'critical', category: 'negative', title: 'POST /orders crashed with 500.', detail: 'The server failed while handling this request.', status: 'failed', runId: 7, runRef: 'hbtqwpmz', projectId: 3, endpoint: { method: 'POST', path: '/orders' }, url: 'https://api.example.com/orders', diagnosis: 'bug', suggestion: 'Handle this input', fix: ['Handle this input'], steps: [], evidence: { request: { method: 'POST', url: 'https://api.example.com/orders' }, response: { status: 500 } }, createdAt: null }
  const { fetch, calls } = mockFetch((c) => {
    if (c.path === '/cli/projects/pay-abcde/findings') return { body: { data: [finding], meta: { run: { id: 7, ref: 'hbtqwpmz', kind: 'suite', status: 'failed', finishedAt: null, url: 'u' }, total: 1 } } }
    if (c.path === '/cli/findings/r12') return { body: { data: { ...finding, runUrl: 'http://app.test/r' } } }
    return undefined
  })
  const l = await runCli(['findings', 'list', '-p', 'pay-abcde', '--severity', 'high'], { fetch, env: KEY })
  assert.equal(l.code, 0, l.stderr)
  assert.match(l.stdout, /r12\s+critical\s+POST \/orders/)
  assert.equal(calls[0].query.get('severity'), 'high')
  const s = await runCli(['issues', 'show', 'r12'], { fetch, env: KEY })
  assert.match(s.stdout, /How to fix/)
  assert.match(s.stdout, /"status": 500/)
  const bad = await runCli(['findings', 'list', '-p', 'pay-abcde', '--severity', 'scary'], { fetch, env: KEY })
  assert.equal(bad.code, 64)
})

test('usage, and a single project is picked automatically', async () => {
  const { fetch } = mockFetch((c) => {
    if (c.path === '/cli/usage') return { body: { data: { workspace: { id: 1, slug: 'acme', name: 'Acme' }, plan: 'free', planName: 'Free', sessionHours: 5, session: { startedAt: null, resetAt: null, usedMicros: 0, budgetMicros: 500000, percent: 0, active: false }, month: { usedMicros: 0, allowanceMicros: 2000000, percent: 0, resetAt: '2026-11-01T00:00:00Z', unlimited: false }, extraCreditMicros: 0, blocked: null, billingUrl: 'http://app.test/settings/billing' } } }
    if (c.path === '/cli/projects') return { body: { data: projects } }
    if (c.path === '/cli/projects/pay-abcde/environments') return { body: { data: [] } }
    return undefined
  })
  const u = await runCli(['usage'], { fetch, env: KEY })
  assert.match(u.stdout, /Acme on the Free plan/)
  assert.match(u.stdout, /This session: not started/)
  const e = await runCli(['envs', 'list'], { fetch, env: KEY })
  assert.equal(e.code, 0)
  assert.match(e.stderr, /Using project Payments API/)
})

test('rerun-failed reports what changed; not found is exit 6', async () => {
  const { fetch } = mockFetch((c) => {
    if (c.path === '/cli/runs/hbtqwpmz/rerun-failed') return { body: { data: { rerun: 3, fixed: 2, stillFailing: 1, run: { status: 'failed', passed: 9, failed: 1, errored: 0, total: 10 } } } }
    if (c.path === '/cli/runs/nope/summary') return { status: 404, body: { message: 'Not found' } }
    return undefined
  })
  const r = await runCli(['runs', 'rerun-failed', 'hbtqwpmz', '--yes'], { fetch, env: KEY })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /Re-ran 3 tests: 2 now pass, 1 still failing/)
  const n = await runCli(['runs', 'show', 'nope'], { fetch, env: KEY })
  assert.equal(n.code, 6)
})
