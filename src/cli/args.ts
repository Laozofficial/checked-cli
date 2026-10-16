import { ArgError } from '../core/errors.js'

/**
 * A small, strict argument parser (no dependency): long flags (--name value,
 * --name=value), boolean flags with --no-name, a few short aliases, and `--`
 * to end flags. Unknown flags are errors, so typos never pass silently in CI.
 */
export type FlagType = 'boolean' | 'string' | 'number'
export type FlagSpec = Record<string, { type: FlagType; alias?: string; description?: string; placeholder?: string }>

export type Parsed = { positionals: string[]; flags: Record<string, string | number | boolean | undefined> }

export const GLOBAL_FLAGS: FlagSpec = {
  json: { type: 'boolean', description: 'Print machine-readable JSON' },
  help: { type: 'boolean', alias: 'h', description: 'Show help' },
  version: { type: 'boolean', alias: 'v', description: 'Show the version' },
  'api-url': { type: 'string', placeholder: 'url', description: 'API to talk to (default https://getchecked.twelveai.app, or CHECKED_API_URL)' },
  color: { type: 'boolean', description: 'Force colour on (--no-color turns it off; NO_COLOR is respected)' },
  quiet: { type: 'boolean', alias: 'q', description: 'Only print the result' },
}

export function parseArgs(argv: string[], spec: FlagSpec): Parsed {
  const all: FlagSpec = { ...GLOBAL_FLAGS, ...spec }
  const aliases = new Map(Object.entries(all).filter(([, v]) => v.alias).map(([k, v]) => [v.alias!, k]))
  const positionals: string[] = []
  const flags: Parsed['flags'] = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      let name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      let inline: string | undefined = eq >= 0 ? a.slice(eq + 1) : undefined
      let negated = false
      if (!all[name] && name.startsWith('no-') && all[name.slice(3)]?.type === 'boolean') {
        name = name.slice(3)
        negated = true
      }
      const def = all[name]
      if (!def) throw new ArgError(`Unknown option --${name}. Run with --help to see the options.`)
      if (def.type === 'boolean') {
        if (inline !== undefined) {
          if (!/^(true|false|1|0)$/i.test(inline)) throw new ArgError(`--${name} takes no value.`)
          flags[name] = /^(true|1)$/i.test(inline) !== negated
        } else flags[name] = !negated
        continue
      }
      if (negated) throw new ArgError(`--no-${name} is not an option.`)
      if (inline === undefined) {
        inline = argv[i + 1]
        if (inline === undefined || (inline.startsWith('--') && inline.length > 2)) throw new ArgError(`--${name} needs a value${def.placeholder ? ` (${def.placeholder})` : ''}.`)
        i++
      }
      flags[name] = def.type === 'number' ? toNumber(name, inline) : inline
      continue
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const letters = a.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const name = aliases.get(letters[j])
        if (!name) throw new ArgError(`Unknown option -${letters[j]}. Run with --help to see the options.`)
        const def = all[name]
        if (def.type === 'boolean') flags[name] = true
        else {
          const rest = letters.slice(j + 1)
          const value = rest || argv[++i]
          if (value === undefined) throw new ArgError(`-${letters[j]} needs a value.`)
          flags[name] = def.type === 'number' ? toNumber(name, value) : value
          break
        }
      }
      continue
    }
    positionals.push(a)
  }
  return { positionals, flags }
}

function toNumber(name: string, v: string): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ArgError(`--${name} must be a number.`)
  return n
}

/** "90s", "15m", "1h", "1h30m" or plain seconds, to milliseconds. */
export function parseDuration(v: string | number | boolean | undefined, fallbackMs: number): number {
  if (v === undefined || v === true || v === false) return fallbackMs
  if (typeof v === 'number') return v * 1000
  const s = v.trim().toLowerCase()
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g
  let total = 0
  let matched = ''
  for (const m of s.matchAll(re)) {
    const n = Number(m[1])
    total += m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n
    matched += m[0]
  }
  if (!matched || matched.replace(/\s/g, '') !== s.replace(/\s/g, '')) throw new ArgError(`Could not read the duration "${v}". Use for example 90s, 15m or 1h.`)
  return total
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
