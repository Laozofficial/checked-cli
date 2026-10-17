import { readConfig } from '../core/config.js'
import { ArgError, EXIT, describeError, errorJson, exitCodeFor, UsageLimitError } from '../core/errors.js'
import { VERSION } from '../version.js'
import { GLOBAL_FLAGS, parseArgs, type FlagSpec } from './args.js'
import { authCommands } from './commands/auth.js'
import { findingCommands } from './commands/findings.js'
import { projectCommands } from './commands/projects.js'
import { runCommands } from './commands/runs.js'
import { makeCtx, type Command, type Deps } from './context.js'
import { styleFor, useColor, type Io } from './output.js'

const mcpCommand: Command = {
  path: ['mcp'],
  summary: 'How to use Check’d from AI assistants (MCP server)',
  usage: 'checked mcp',
  run: async (ctx) => {
    const text = [
      'The Check’d MCP server is a separate package, so this CLI stays small:',
      '',
      '  claude mcp add checked --env CHECKED_API_KEY=tfy_... -- npx -y checkd-mcp',
      '',
      'Cursor and VS Code use the same command; see https://getchecked.twelveai.app/docs/mcp',
    ].join('\n')
    ctx.out.result({ package: 'checkd-mcp', command: 'npx -y checkd-mcp', docs: 'https://getchecked.twelveai.app/docs/mcp' }, () => text)
  },
}

export const COMMANDS: Command[] = [...authCommands, ...projectCommands, ...runCommands, ...findingCommands, mcpCommand]

const GROUPS: Record<string, string> = { projects: 'Projects', envs: 'Environments', runs: 'Runs', findings: 'Findings', issues: 'Issues' }

function findCommand(words: string[]): { cmd: Command | null; consumed: number; group: string | null } {
  let best: Command | null = null
  for (const c of COMMANDS) {
    if (c.path.length <= words.length && c.path.every((p, i) => words[i] === p) && (!best || c.path.length > best.path.length)) best = c
  }
  if (best) return { cmd: best, consumed: best.path.length, group: null }
  const g = words[0]
  if (g && COMMANDS.some((c) => c.path.length > 1 && c.path[0] === g)) {
    // `checked projects` means `checked projects list`.
    const list = words.length === 1 ? COMMANDS.find((c) => c.path[0] === g && c.path[1] === 'list') : undefined
    if (list) return { cmd: list, consumed: 1, group: null }
    return { cmd: null, consumed: 1, group: g }
  }
  return { cmd: null, consumed: 0, group: null }
}

function flagLines(spec: FlagSpec): string[] {
  return Object.entries(spec).map(([name, d]) => {
    const left = `${d.alias ? `-${d.alias}, ` : '    '}--${name}${d.type !== 'boolean' ? ` <${d.placeholder ?? d.type}>` : ''}`
    return `  ${left.padEnd(30)} ${d.description ?? ''}`
  })
}

export function mainHelp(): string {
  const visible = COMMANDS.filter((c) => !c.hidden)
  const line = (c: Command) => `  ${c.path.join(' ').padEnd(22)} ${c.summary}`
  return [
    `checked ${VERSION}: Check’d from your terminal and CI`,
    '',
    'Usage: checked <command> [options]',
    '',
    'Commands:',
    ...visible.map(line),
    '',
    'Global options:',
    ...flagLines(GLOBAL_FLAGS),
    '',
    'Environment: CHECKED_API_KEY (workspace API key), CHECKED_API_URL, CHECKED_PROJECT, CHECKED_ENV, CHECKED_WORKSPACE, NO_COLOR.',
    'Exit codes: 0 ok, 1 release gates failed, 2 run errored, 3 timed out, 4 usage limit, 5 not signed in, 6 not found, 7 rate limited, 64 bad arguments, 70 other error.',
    '',
    'Run `checked <command> --help` for a command’s options.',
  ].join('\n')
}

export function commandHelp(c: Command): string {
  return [`${c.summary}`, '', `Usage: ${c.usage}`, ...(c.flags && Object.keys(c.flags).length ? ['', 'Options:', ...flagLines(c.flags)] : []), ...(c.examples?.length ? ['', 'Examples:', ...c.examples.map((e) => `  ${e}`)] : []), '', 'Also: --json, --quiet, --api-url, --no-color'].join('\n')
}

function groupHelp(g: string): string {
  const subs = COMMANDS.filter((c) => c.path[0] === g)
  return [`${GROUPS[g] ?? g}:`, ...subs.map((c) => `  checked ${c.path.join(' ').padEnd(20)} ${c.summary}`)].join('\n')
}

/** Runs the CLI. Returns the exit code instead of exiting, so tests can call it. */
export async function main(argv: string[], io: Io, deps: Deps): Promise<number> {
  // Command words come first; global switches may precede them.
  let i = 0
  while (i < argv.length && /^--?(json|quiet|q|no-color|color|help|h|version|v)$/.test(argv[i])) i++
  const lead = argv.slice(0, i)
  const words: string[] = []
  for (let j = i; j < argv.length && !argv[j].startsWith('-') && words.length < 2; j++) words.push(argv[j])
  const { cmd, consumed, group } = findCommand(words)
  const rest = [...lead, ...argv.slice(i + consumed)]
  const colorFlag = rest.includes('--no-color') ? false : rest.includes('--color') ? true : undefined
  const color = useColor({ flag: colorFlag, env: io.env, isTTY: !!io.stdout.isTTY })
  const st = styleFor(color)
  const asJson = rest.includes('--json')

  try {
    if (!cmd) {
      if (rest.includes('--version') || rest.includes('-v')) {
        io.stdout.write(`${asJson ? JSON.stringify({ version: VERSION }) : VERSION}\n`)
        return EXIT.OK
      }
      if (group) {
        io.stdout.write(`${groupHelp(group)}\n`)
        return words.length > 1 ? EXIT.BAD_ARGS : EXIT.OK
      }
      if (words.length) {
        io.stderr.write(`${st.red(`Unknown command "${words.join(' ')}".`)}\n\n${mainHelp()}\n`)
        return EXIT.BAD_ARGS
      }
      io.stdout.write(`${mainHelp()}\n`)
      return EXIT.OK
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      io.stdout.write(`${commandHelp(cmd)}\n`)
      return EXIT.OK
    }
    const parsed = parseArgs(rest, cmd.flags ?? {})
    const config = await readConfig(io.env)
    const ctx = makeCtx(io, parsed, config, deps, color)
    const code = await cmd.run(ctx)
    return typeof code === 'number' ? code : EXIT.OK
  } catch (e) {
    const code = exitCodeFor(e)
    if (asJson) io.stderr.write(`${JSON.stringify({ error: errorJson(e) }, null, 2)}\n`)
    else {
      const prefix = e instanceof UsageLimitError ? 'Usage limit: ' : ''
      io.stderr.write(`${st.red(`${prefix}${describeError(e)}`)}\n`)
      if (e instanceof UsageLimitError && e.code !== 'plan') io.stderr.write(`${st.dim('See your usage with `checked usage`, or upgrade under Plan and usage in the app.')}\n`)
      if (e instanceof ArgError && cmd) io.stderr.write(`${st.dim(`Usage: ${cmd.usage}`)}\n`)
    }
    return code
  }
}
