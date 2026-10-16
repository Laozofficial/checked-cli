import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '../src/core/client.js'
import { main } from '../src/cli/main.js'
import type { RunSummary } from '../src/core/types.js'

export type Call = { method: string; url: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any }
export type Route = (call: Call) => { status?: number; body?: unknown; sse?: string } | undefined

/** A fetch that answers from a route function and records every call. */
export function mockFetch(route: Route): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init = {}) => {
    const u = new URL(url)
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call: Call = { method: init.method ?? 'GET', url, path: u.pathname.replace(/^\/api\/v1/, ''), query: u.searchParams, headers, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const r = route(call) ?? { status: 404, body: { message: `no mock for ${call.method} ${call.path}` } }
    if (r.sse !== undefined) return new Response(r.sse, { status: r.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

export function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'checked-test-'))
}

/** Runs the CLI in-process with captured output. */
export async function runCli(argv: string[], opts: { fetch: FetchLike; env?: Record<string, string | undefined>; stdin?: string; tty?: boolean; opened?: string[] }) {
  let stdout = ''
  let stderr = ''
  const stdin = new PassThrough() as unknown as PassThrough & { isTTY?: boolean }
  if (opts.tty) stdin.isTTY = true
  if (opts.stdin !== undefined) stdin.end(opts.stdin)
  const env = { CHECKED_CONFIG_DIR: tempConfigDir(), CHECKED_API_URL: 'http://api.test', NO_COLOR: '1', ...(opts.env ?? {}) }
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => (stdout += s), isTTY: !!opts.tty },
      stderr: { write: (s: string) => (stderr += s), isTTY: !!opts.tty },
      stdin: stdin as any,
      env,
    },
    { fetch: opts.fetch, openUrl: async (u) => (opts.opened?.push(u), true), sleep: async () => {}, now: fakeClock() }
  )
  return { code, stdout, stderr, env }
}

/** A clock that moves a second per read, so waits finish instantly but timeouts still happen. */
export function fakeClock(start = 1_700_000_000_000, step = 1000) {
  let t = start
  return () => (t += step)
}

export const run = (over: Record<string, unknown> = {}) => ({ id: 7, ref: 'hbtqwpmz', kind: 'suite', status: 'running', total: 10, passed: 3, failed: 0, errored: 0, skipped: 0, durationMs: null, startedAt: null, finishedAt: null, createdAt: '2026-10-16T10:00:00.000Z', projectId: 3, done: false, url: 'http://app.test/projects/pay-abcde/runs/hbtqwpmz', ...over })

export const summary = (over: { run?: Record<string, unknown>; gates?: unknown; report?: unknown } = {}): RunSummary => ({
  run: run({ status: 'passed', total: 10, passed: 10, done: true, durationMs: 12000, ...(over.run ?? {}) }),
  project: { id: 3, ref: 'pay-abcde', name: 'Payments API', kind: 'backend' },
  url: 'http://app.test/projects/pay-abcde/runs/hbtqwpmz',
  gates: over.gates === undefined ? { passed: true, pendingReport: false, checks: [{ key: 'pass_rate', label: 'Pass rate', ok: true, actual: '100%', target: '≥ 95%' }] } : over.gates,
  report: over.report ?? null,
  health: null,
  findingCount: 0,
  topFindings: [],
}) as unknown as RunSummary
