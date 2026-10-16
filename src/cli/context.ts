import { CheckedClient, type FetchLike } from '../core/client.js'
import { resolveApiUrl, resolveCredential, type Credential, type Env, type StoredConfig } from '../core/config.js'
import { ArgError, NotSignedInError } from '../core/errors.js'
import type { EnvironmentRow, ProjectRow } from '../core/types.js'
import { VERSION } from '../version.js'
import type { FlagSpec, Parsed } from './args.js'
import { str } from './args.js'
import { Output, type Io } from './output.js'

export type Deps = {
  fetch?: FetchLike
  openUrl: (url: string) => Promise<boolean>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export type Ctx = {
  io: Io
  env: Env
  out: Output
  flags: Parsed['flags']
  positionals: string[]
  apiUrl: string
  config: StoredConfig
  credential: Credential | null
  deps: Deps
  /** A client with the configured credential; throws when there is none. */
  client: () => CheckedClient
  /** A client without a credential (sign-in endpoints). */
  anonClient: () => CheckedClient
  /** Prompts are allowed: a terminal on stdin and stderr, and not --json. */
  interactive: boolean
}

export type Command = {
  path: string[]
  summary: string
  usage: string
  flags?: FlagSpec
  examples?: string[]
  /** Hidden from the main help (aliases). */
  hidden?: boolean
  run: (ctx: Ctx) => Promise<number | void>
}

export function makeCtx(io: Io, parsed: Parsed, config: StoredConfig, deps: Deps, color: boolean): Ctx {
  const env = io.env
  const apiUrl = resolveApiUrl({ flag: str(parsed.flags['api-url']), env, config })
  const credential = resolveCredential(env, config)
  const out = new Output(io, !!parsed.flags.json, !!parsed.flags.quiet, color)
  const make = (token: string | null) => new CheckedClient({ apiUrl, token, fetch: deps.fetch, userAgent: `checked-cli/${VERSION}` })
  return {
    io,
    env,
    out,
    flags: parsed.flags,
    positionals: parsed.positionals,
    apiUrl,
    config,
    credential,
    deps,
    client: () => {
      if (!credential) throw new NotSignedInError()
      return make(credential.token)
    },
    anonClient: () => make(null),
    interactive: !parsed.flags.json && !!io.stdin.isTTY && !!io.stderr.isTTY,
  }
}

/** --project, else CHECKED_PROJECT, else the only project the credential can see. */
export async function resolveProject(ctx: Ctx, explicit?: string): Promise<string> {
  const given = explicit ?? str(ctx.flags.project) ?? str(ctx.env.CHECKED_PROJECT)
  if (given) return given
  const list = await ctx.client().projects({ workspace: workspaceFlag(ctx) })
  if (list.length === 1) {
    ctx.out.info(ctx.out.st.dim(`Using project ${list[0].name} (${list[0].ref ?? list[0].id}).`))
    return String(list[0].ref ?? list[0].id)
  }
  throw new ArgError(list.length ? `Pick a project with --project <ref or id> (or set CHECKED_PROJECT). You have: ${list.slice(0, 8).map((p) => p.ref ?? p.id).join(', ')}${list.length > 8 ? ', …' : ''}.` : 'No projects yet. Create one in the app first (`checked open`).')
}

export function workspaceFlag(ctx: Ctx): string | undefined {
  return str(ctx.flags.workspace) ?? str(ctx.env.CHECKED_WORKSPACE) ?? undefined
}

/** --env by id or name (case-insensitive); undefined means the project's default environment. */
export async function resolveEnvironment(ctx: Ctx, projectId: string): Promise<{ id: number; env: EnvironmentRow } | undefined> {
  const given = str(ctx.flags.env) ?? str(ctx.env.CHECKED_ENV)
  if (!given) return undefined
  const envs = await ctx.client().environments(projectId)
  const hit = /^\d+$/.test(given) ? envs.find((e) => e.id === Number(given)) : envs.find((e) => e.name.toLowerCase() === given.toLowerCase())
  if (!hit) throw new ArgError(`No environment "${given}" on this project. It has: ${envs.map((e) => e.name).join(', ') || 'none'}.`)
  return { id: hit.id, env: hit }
}

export function requirePositional(ctx: Ctx, index: number, what: string): string {
  const v = ctx.positionals[index]
  if (!v) throw new ArgError(`Missing ${what}.`)
  return v
}

export type { ProjectRow }
