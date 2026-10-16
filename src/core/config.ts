import { mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the CLI keeps its sign-in, and how a credential is chosen.
 *
 * Order of precedence (first wins):
 *   1. CHECKED_API_KEY   a workspace API key (tfy_...), the CI path
 *   2. CHECKED_TOKEN     a personal access token, for scripts that already have one
 *   3. the config file   written by `checked login` (0600, in the OS config directory)
 *
 * The API URL: --api-url, then CHECKED_API_URL, then the saved one, then production.
 */
export const DEFAULT_API_URL = 'https://getchecked.twelveai.app'

export type Env = Record<string, string | undefined>

export type StoredConfig = {
  apiUrl?: string
  token?: string
  /** 'user' for a token from the browser sign-in, 'key' for a pasted workspace API key. */
  tokenKind?: 'user' | 'key'
  email?: string | null
  workspace?: string | null
  savedAt?: string
}

export type Credential = { token: string; kind: 'user' | 'key'; source: 'env:CHECKED_API_KEY' | 'env:CHECKED_TOKEN' | 'config' }

/** The OS config directory: %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere. CHECKED_CONFIG_DIR overrides. */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CHECKED_CONFIG_DIR) return env.CHECKED_CONFIG_DIR
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'checked')
  if (platform === 'darwin' && !env.XDG_CONFIG_HOME) return join(homedir(), 'Library', 'Application Support', 'checked')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'checked')
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), 'config.json')
}

export async function readConfig(env: Env = process.env): Promise<StoredConfig> {
  try {
    const raw = await readFile(configPath(env), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as StoredConfig) : {}
  } catch {
    return {}
  }
}

/** Writes the config readable by the owner only (0600; the directory 0700). */
export async function writeConfig(cfg: StoredConfig, env: Env = process.env): Promise<string> {
  const dir = configDir(env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = configPath(env)
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // writeFile keeps the mode of an existing file; make sure it is tight either way.
  await chmod(path, 0o600).catch(() => {})
  return path
}

export async function clearConfigToken(env: Env = process.env): Promise<void> {
  const cfg = await readConfig(env)
  if (!cfg.token) return
  const { token: _t, tokenKind: _k, email: _e, ...rest } = cfg
  if (Object.keys(rest).filter((k) => k !== 'savedAt').length) await writeConfig(rest, env)
  else await rm(configPath(env), { force: true })
}

/** Accepts https://host, https://host/ or https://host/api/v1; returns https://host. */
export function normalizeApiUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '')
  u = u.replace(/\/api\/v1$/i, '').replace(/\/api$/i, '')
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  return u
}

export function resolveApiUrl(opts: { flag?: string | null; env?: Env; config?: StoredConfig }): string {
  const env = opts.env ?? process.env
  return normalizeApiUrl(opts.flag || env.CHECKED_API_URL || opts.config?.apiUrl || DEFAULT_API_URL)
}

export function tokenKindOf(token: string): 'user' | 'key' {
  return token.startsWith('tfy_') ? 'key' : 'user'
}

export function resolveCredential(env: Env = process.env, cfg: StoredConfig = {}): Credential | null {
  const key = env.CHECKED_API_KEY?.trim()
  if (key) return { token: key, kind: tokenKindOf(key), source: 'env:CHECKED_API_KEY' }
  const token = env.CHECKED_TOKEN?.trim()
  if (token) return { token, kind: tokenKindOf(token), source: 'env:CHECKED_TOKEN' }
  if (cfg.token) return { token: cfg.token, kind: cfg.tokenKind ?? tokenKindOf(cfg.token), source: 'config' }
  return null
}

/** Shows enough of a secret to recognise it, never the whole thing. */
export function maskToken(token: string): string {
  if (token.length <= 12) return '••••'
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}
