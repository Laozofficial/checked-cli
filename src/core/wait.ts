import type { CheckedClient } from './client.js'
import { isTerminal, type LiveEvent, type RunCore, type RunSummary } from './types.js'

export type WaitOptions = {
  /** Give up after this long (the run keeps going on the server). */
  timeoutMs: number
  /** Follow the live feed (SSE) for progress; polling still decides when it is done. */
  stream?: boolean
  pollMs?: number
  onEvent?: (e: LiveEvent) => void
  /** Called when the live feed fails and the wait falls back to polling only. */
  onStreamError?: (e: unknown) => void
  signal?: AbortSignal
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export type WaitResult = { run: RunCore; timedOut: boolean }

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

/**
 * Waits for a run to finish. The live feed gives progress as it happens; a
 * status poll every few seconds is the source of truth, so a dropped stream
 * or a proxy that buffers SSE never leaves the wait hanging.
 */
export async function waitForRun(client: CheckedClient, runId: number | string, opts: WaitOptions): Promise<WaitResult> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const deadline = now() + opts.timeoutMs
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  opts.signal?.addEventListener('abort', onAbort)
  let streaming = false
  let terminalFromStream: string | null = null

  if (opts.stream) {
    streaming = true
    client
      .events(
        runId,
        (e) => {
          if (e.type === 'status' && typeof (e as { status?: unknown }).status === 'string' && isTerminal((e as { status: string }).status)) terminalFromStream = (e as { status: string }).status
          opts.onEvent?.(e)
        },
        stop.signal
      )
      .catch((e) => opts.onStreamError?.(e))
      .finally(() => {
        streaming = false
      })
  }

  try {
    let run = await client.run(runId)
    while (!isTerminal(run.status)) {
      if (opts.signal?.aborted) return { run, timedOut: false }
      const left = deadline - now()
      if (left <= 0) return { run, timedOut: true }
      // Poll faster once the stream says it is over, slower while the stream is alive.
      const base = opts.pollMs ?? (streaming ? 10_000 : 4_000)
      await sleep(Math.min(terminalFromStream ? 500 : base, left), stop.signal)
      if (opts.signal?.aborted) return { run, timedOut: false }
      run = await client.run(runId)
    }
    return { run, timedOut: false }
  } finally {
    stop.abort()
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * After a run ends the AI report lands a little later and can change the defect
 * gates. Waits up to `ms` for it (0 skips), then returns the latest summary.
 */
export async function summaryAfterReport(client: CheckedClient, runId: number | string, ms: number, opts: { sleep?: WaitOptions['sleep']; now?: () => number } = {}): Promise<RunSummary> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const deadline = now() + ms
  let s = await client.summary(runId)
  while (ms > 0 && !s.report && s.gates?.pendingReport && now() < deadline) {
    await sleep(Math.min(5000, Math.max(0, deadline - now())))
    s = await client.summary(runId)
  }
  return s
}
