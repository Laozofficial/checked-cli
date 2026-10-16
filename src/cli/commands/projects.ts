import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { ArgError, EXIT } from '../../core/errors.js'
import { formatPreview, formatUsage, KIND_LABEL, statusText } from '../../core/format.js'
import { str } from '../args.js'
import { requirePositional, resolveProject, workspaceFlag, type Command } from '../context.js'
import { table } from '../output.js'
import { confirm } from '../prompt.js'

const MAX_IMPORT_BYTES = 8 * 1024 * 1024

export const projectCommands: Command[] = [
  {
    path: ['projects', 'list'],
    summary: 'List projects',
    usage: 'checked projects list [--workspace <slug>] [--archived]',
    flags: { workspace: { type: 'string', placeholder: 'slug', description: 'Only this workspace (or CHECKED_WORKSPACE)' }, archived: { type: 'boolean', description: 'List archived projects instead' } },
    run: async (ctx) => {
      const rows = await ctx.client().projects({ workspace: workspaceFlag(ctx), archived: !!ctx.flags.archived })
      const st = ctx.out.st
      ctx.out.result(rows, () =>
        rows.length
          ? table(
              ['REF', 'NAME', 'KIND', 'WORKSPACE', 'ENDPOINTS', 'LAST RUN'],
              rows.map((p) => [p.ref ?? String(p.id), p.name, p.kind === 'frontend' ? 'website' : 'api', p.workspace?.slug ?? '', p.kind === 'frontend' ? '-' : String(p.endpointCount), p.lastRun ? `${statusText(p.lastRun.status, st)} ${st.dim(p.lastRun.ref ?? '')}` : st.dim('none')]),
              st
            )
          : 'No projects yet. Create one in the app (`checked open`).'
      )
    },
  },
  {
    path: ['envs', 'list'],
    summary: 'List a project’s environments',
    usage: 'checked envs list --project <ref>',
    flags: { project: { type: 'string', alias: 'p', placeholder: 'ref', description: 'Project ref or id (or CHECKED_PROJECT)' } },
    run: async (ctx) => {
      const project = await resolveProject(ctx, ctx.positionals[0])
      const rows = await ctx.client().environments(project)
      const st = ctx.out.st
      ctx.out.result(rows, () =>
        rows.length ? table(['ID', 'NAME', 'BASE URL', 'AUTH', ''], rows.map((e) => [String(e.id), e.name, e.baseUrl, String(e.auth?.type ?? 'none'), e.isDefault ? st.green('default') : '']), st, 80) : 'No environments yet. Add one in the app under Environments.'
      )
    },
  },
  {
    path: ['import'],
    summary: 'Import an API spec or collection from a file or URL',
    usage: 'checked import <file|url> --project <ref> [--yes] [--replace] [--expected openapi|postman|graphql|insomnia|har|curl|list]',
    flags: {
      project: { type: 'string', alias: 'p', placeholder: 'ref', description: 'Project ref or id (or CHECKED_PROJECT)' },
      yes: { type: 'boolean', alias: 'y', description: 'Save without asking' },
      replace: { type: 'boolean', description: 'Replace the current endpoint list instead of merging into it' },
      expected: { type: 'string', placeholder: 'format', description: 'Say what you are importing; a mismatch is reported' },
      'dry-run': { type: 'boolean', description: 'Only show what would be imported' },
    },
    examples: ['checked import openapi.yaml --project payments-kqzxm', 'checked import https://api.example.com/openapi.json -p payments-kqzxm --yes', 'checked import collection.postman.json --replace --yes'],
    run: async (ctx) => {
      const source = requirePositional(ctx, 0, 'the file or URL to import, e.g. `checked import openapi.yaml`')
      const project = await resolveProject(ctx)
      const client = ctx.client()
      let input: { url?: string; content?: string; filename?: string }
      if (/^https?:\/\//i.test(source)) input = { url: source }
      else {
        const info = await stat(source).catch(() => null)
        if (!info || !info.isFile()) throw new ArgError(`No file at ${source}.`)
        if (info.size > MAX_IMPORT_BYTES) throw new ArgError(`${source} is ${Math.round(info.size / 1024 / 1024)} MB; imports are limited to 8 MB.`)
        input = { content: await readFile(source, 'utf8'), filename: basename(source) }
      }
      const body = { ...input, expected: str(ctx.flags.expected), replace: !!ctx.flags.replace }
      ctx.out.info(ctx.out.st.dim(`Reading ${source}…`))
      const preview = await client.importPreview(project, body)
      if (ctx.flags['dry-run']) {
        ctx.out.result({ preview, saved: null }, () => formatPreview(preview, source, ctx.out.st))
        return preview.ok ? EXIT.OK : EXIT.BAD_ARGS
      }
      if (!preview.ok) {
        ctx.out.result({ preview, saved: null }, () => formatPreview(preview, source, ctx.out.st))
        return EXIT.BAD_ARGS
      }
      if (!ctx.flags.yes) {
        if (!ctx.interactive) throw new ArgError('Pass --yes to import without a prompt (or --dry-run to only look).')
        ctx.io.stderr.write(`${formatPreview(preview, source, ctx.out.st)}\n\n`)
        const verb = ctx.flags.replace ? 'Replace the endpoint list with' : 'Import'
        if (!(await confirm(ctx.io, `${verb} ${preview.willImport} endpoint${preview.willImport === 1 ? '' : 's'}?`))) {
          ctx.out.info('Nothing was imported.')
          return EXIT.OK
        }
      } else ctx.out.info(formatPreview(preview, source, ctx.out.st))
      const saved = await client.importSave(project, body)
      ctx.out.result({ preview, saved }, () => `${ctx.out.st.green('Imported')} ${saved.endpointCount} endpoint${saved.endpointCount === 1 ? '' : 's'}${saved.title ? ` from ${saved.title}` : ''}.\n${ctx.out.st.dim(saved.projectUrl)}`)
    },
  },
  {
    path: ['usage'],
    summary: 'Show this session’s and this month’s usage',
    usage: 'checked usage [--workspace <slug>]',
    flags: { workspace: { type: 'string', placeholder: 'slug', description: 'Workspace (or CHECKED_WORKSPACE)' } },
    run: async (ctx) => {
      const u = await ctx.client().usage(workspaceFlag(ctx))
      ctx.out.result(u, () => formatUsage(u, ctx.out.st))
    },
  },
  {
    path: ['open'],
    summary: 'Open a run or project in the browser',
    usage: 'checked open [run-ref] [--project <ref>]',
    flags: { project: { type: 'string', alias: 'p', placeholder: 'ref', description: 'Open this project' }, print: { type: 'boolean', description: 'Print the link instead of opening it' } },
    run: async (ctx) => {
      const target = ctx.positionals[0]
      let url: string
      if (target) url = String((await ctx.client().run(target)).url)
      else if (str(ctx.flags.project) ?? str(ctx.env.CHECKED_PROJECT)) url = String((await ctx.client().project(str(ctx.flags.project) ?? str(ctx.env.CHECKED_PROJECT)!)).url)
      else url = ctx.credential ? (await ctx.client().whoami()).appUrl : ctx.apiUrl
      const opened = ctx.flags.print ? false : await ctx.deps.openUrl(url)
      ctx.out.result({ url, opened }, () => (opened ? `Opened ${url}` : url))
    },
  },
]

export { KIND_LABEL }
