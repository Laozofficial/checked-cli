import { hostname } from 'node:os'
import { ApiError, ArgError } from '../../core/errors.js'
import { CheckedClient } from '../../core/client.js'
import { clearConfigToken, configPath, maskToken, tokenKindOf, writeConfig } from '../../core/config.js'
import type { WhoAmI } from '../../core/types.js'
import { VERSION } from '../../version.js'
import { str } from '../args.js'
import type { Command, Ctx } from '../context.js'
import { askSecret, readAll } from '../prompt.js'

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function describeWho(w: WhoAmI, ctx: Ctx): string {
  const st = ctx.out.st
  const who = w.kind === 'user' ? `${st.bold(w.user?.email ?? 'unknown')}${w.user?.fullName ? ` (${w.user.fullName})` : ''}` : `${st.bold(`API key ${w.key?.name ?? ''}`)} ${st.dim(w.key?.prefix ? `${w.key.prefix}…` : '')}`
  const lines = [`Signed in as ${who}`, st.dim(`  ${ctx.apiUrl}`)]
  if (w.workspaces.length) {
    lines.push('', 'Workspaces:')
    for (const ws of w.workspaces) lines.push(`  ${ws.slug.padEnd(24)} ${ws.name} ${st.dim(`(${ws.plan}, ${ws.role})`)}`)
  }
  if (w.kind === 'user' && w.user && !w.user.emailVerified) lines.push('', st.yellow('Verify your email to start runs; the link is in your inbox.'))
  return lines.join('\n')
}

async function saveToken(ctx: Ctx, token: string, email: string | null) {
  const path = await writeConfig({ ...ctx.config, apiUrl: ctx.apiUrl, token, tokenKind: tokenKindOf(token), email, savedAt: new Date().toISOString() }, ctx.env)
  return path
}

async function loginWithKey(ctx: Ctx, key: string) {
  key = key.trim()
  if (!key) throw new ArgError('No key given.')
  const client = new CheckedClient({ apiUrl: ctx.apiUrl, token: key, fetch: ctx.deps.fetch })
  const who = await client.whoami()
  const path = await saveToken(ctx, key, who.user?.email ?? null)
  ctx.out.result({ ...who, savedTo: path }, () => `${describeWho(who, ctx)}\n\n${ctx.out.st.dim(`Saved to ${path}`)}`)
}

/** The browser flow: show a code, the person approves it in the app, the CLI collects a token. */
async function loginWithBrowser(ctx: Ctx) {
  const st = ctx.out.st
  const anon = ctx.anonClient()
  const clientName = `Check’d CLI on ${hostname().slice(0, 40)}`
  const start = await anon.deviceStart(clientName)
  ctx.out.progress(`\nOpen ${st.bold(start.verificationUri)} and enter the code ${st.bold(start.userCode)}`)
  ctx.out.progress(st.dim(`(or go straight to ${start.verificationUriComplete})`))
  if (ctx.flags.browser !== false) {
    const opened = await ctx.deps.openUrl(start.verificationUriComplete)
    ctx.out.progress(st.dim(opened ? 'Opened your browser. Check the code matches, then approve.' : 'Could not open a browser here; open the link on any device.'))
  }
  ctx.out.progress(st.dim('Waiting for approval… (Ctrl+C to stop)'))
  const sleep = ctx.deps.sleep ?? sleepDefault
  const now = ctx.deps.now ?? Date.now
  const deadline = now() + start.expiresIn * 1000
  let interval = Math.max(1, start.interval) * 1000
  while (now() < deadline) {
    await sleep(interval)
    try {
      const got = await anon.deviceToken(start.deviceCode)
      const path = await saveToken(ctx, got.token, got.user.email)
      const who = await new CheckedClient({ apiUrl: ctx.apiUrl, token: got.token, fetch: ctx.deps.fetch }).whoami()
      ctx.out.result({ ...who, savedTo: path, expiresAt: got.expiresAt }, () => `\n${describeWho(who, ctx)}\n\n${st.dim(`Saved to ${path}${got.expiresAt ? `; the sign-in lasts until ${new Date(got.expiresAt).toLocaleDateString()}` : ''}.`)}`)
      return
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        if (e.code === 'authorization_pending') continue
        if (e.code === 'slow_down') {
          interval += 5000
          continue
        }
        if (e.code === 'access_denied') throw new ApiError('The sign-in was denied in the browser.', 401, 'access_denied')
        if (e.code === 'expired_token') throw new ApiError('The code expired before it was approved. Run `checked login` again.', 401, 'expired_token')
      }
      throw e
    }
  }
  throw new ApiError('The code expired before it was approved. Run `checked login` again.', 401, 'expired_token')
}

export const authCommands: Command[] = [
  {
    path: ['login'],
    summary: 'Sign in (browser approval, or a workspace API key)',
    usage: 'checked login [--api-key <key> | --with-key] [--no-browser]',
    flags: {
      'api-key': { type: 'string', placeholder: 'tfy_…', description: 'Save this workspace API key instead of signing in in the browser' },
      'with-key': { type: 'boolean', description: 'Read the API key from stdin (or ask for it), e.g. echo $KEY | checked login --with-key' },
      browser: { type: 'boolean', description: 'Open the browser automatically (--no-browser just prints the link)' },
    },
    examples: ['checked login', 'checked login --no-browser', 'echo "$CHECKED_API_KEY" | checked login --with-key'],
    run: async (ctx) => {
      const given = str(ctx.flags['api-key'])
      if (given) return loginWithKey(ctx, given)
      if (ctx.flags['with-key']) {
        const key = ctx.io.stdin.isTTY ? await askSecret(ctx.io, 'Paste the API key (input hidden): ') : await readAll(ctx.io.stdin)
        return loginWithKey(ctx, key)
      }
      return loginWithBrowser(ctx)
    },
  },
  {
    path: ['logout'],
    summary: 'Sign out: revoke the saved sign-in and forget it',
    usage: 'checked logout',
    run: async (ctx) => {
      const token = ctx.config.token
      let revoked = false
      if (token && tokenKindOf(token) === 'user') {
        try {
          await new CheckedClient({ apiUrl: ctx.config.apiUrl ?? ctx.apiUrl, token, fetch: ctx.deps.fetch }).logout()
          revoked = true
        } catch {
          /* already invalid, or offline: forget it locally anyway */
        }
      }
      await clearConfigToken(ctx.env)
      const notes: string[] = []
      notes.push(token ? `Signed out${revoked ? ' and revoked the token on the server' : ''}. Removed the saved sign-in from ${configPath(ctx.env)}.` : 'No saved sign-in to remove.')
      if (token && tokenKindOf(token) === 'key') notes.push('That was a workspace API key: it still works elsewhere until you revoke it under Settings, API keys.')
      if (ctx.env.CHECKED_API_KEY) notes.push('CHECKED_API_KEY is still set in this shell, so commands keep using it.')
      ctx.out.result({ signedOut: !!token, revoked, envKeyStillSet: !!ctx.env.CHECKED_API_KEY }, () => notes.join('\n'))
    },
  },
  {
    path: ['whoami'],
    summary: 'Show who you are signed in as, and your workspaces',
    usage: 'checked whoami',
    run: async (ctx) => {
      const who = await ctx.client().whoami()
      const cred = ctx.credential!
      ctx.out.result({ ...who, apiUrl: ctx.apiUrl, credential: { source: cred.source, kind: cred.kind, token: maskToken(cred.token) }, cliVersion: VERSION }, () => `${describeWho(who, ctx)}\n${ctx.out.st.dim(`  credential from ${cred.source === 'config' ? configPath(ctx.env) : cred.source.replace('env:', '$')}`)}`)
    },
  },
]
