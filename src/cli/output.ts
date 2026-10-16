import type { Style } from '../core/format.js'
import { PLAIN } from '../core/format.js'
import type { Env } from '../core/config.js'

/**
 * Colour and tables. Colour is on for a terminal, off for pipes and files, and
 * always off when NO_COLOR is set (https://no-color.org) or --no-color is given.
 * --color or FORCE_COLOR turn it on regardless.
 */
export function useColor(opts: { flag?: boolean; env: Env; isTTY: boolean }): boolean {
  if (opts.flag === false) return false
  if (opts.env.NO_COLOR !== undefined && opts.env.NO_COLOR !== '') return false
  if (opts.flag === true) return true
  if (opts.env.FORCE_COLOR !== undefined && opts.env.FORCE_COLOR !== '0' && opts.env.FORCE_COLOR !== 'false') return true
  return opts.isTTY && opts.env.TERM !== 'dumb'
}

const wrap = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`

export function styleFor(color: boolean): Style {
  if (!color) return PLAIN
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
export const visibleLength = (s: string) => s.replace(ANSI, '').length

/** A plain left-aligned table. Cells can carry colour; widths ignore it. Long cells are cut to `maxWidth`. */
export function table(headers: string[], rows: string[][], st: Style, maxWidth = 60): string {
  if (!rows.length) return ''
  const cut = (s: string) => {
    if (visibleLength(s) <= maxWidth) return s
    const plain = s.replace(ANSI, '')
    return `${plain.slice(0, maxWidth - 1)}…`
  }
  const cells = rows.map((r) => r.map((c) => cut(c ?? '')))
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => visibleLength(r[i] ?? ''))))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - visibleLength(s)))
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]))).join('  ').trimEnd()
  return [st.dim(line(headers.map((h, i) => pad(h, widths[i])))), ...cells.map(line)].join('\n')
}

export type Io = {
  stdout: { write: (s: string) => unknown; isTTY?: boolean }
  stderr: { write: (s: string) => unknown; isTTY?: boolean }
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
  env: Env
}

/** Where a command writes. Results go to stdout; progress and prompts to stderr, so `--json` stays parseable. */
export class Output {
  readonly st: Style
  constructor(
    readonly io: Io,
    readonly json: boolean,
    readonly quiet: boolean,
    color: boolean
  ) {
    this.st = styleFor(color)
  }

  /** The command's result: JSON with --json, else the human text. */
  result(data: unknown, human: () => string) {
    if (this.json) this.io.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
    else {
      const text = human()
      if (text) this.io.stdout.write(`${text}\n`)
    }
  }

  /** Progress and notes (stderr). Silent with --quiet or --json. */
  info(text: string) {
    if (!this.quiet && !this.json) this.io.stderr.write(`${text}\n`)
  }

  /** Progress that should show in JSON mode too (stderr only), unless --quiet. */
  progress(text: string) {
    if (!this.quiet) this.io.stderr.write(`${text}\n`)
  }

  warn(text: string) {
    this.io.stderr.write(`${this.st.yellow(text)}\n`)
  }

  error(text: string) {
    this.io.stderr.write(`${this.st.red(text)}\n`)
  }
}
