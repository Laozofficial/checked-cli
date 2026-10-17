# checkd-cli

`checked` runs Check’d from your terminal and CI: import API docs, start runs, follow them live, read the AI report and findings, and fail the build when a run misses its release gates.

Needs Node.js 20 or newer. No runtime dependencies.

```sh
npm install -g checkd-cli
checked login            # approve a code in the browser; saved for 90 days
checked projects list
```

## Signing in

| How | When |
| --- | --- |
| `checked login` | Your own machine. Shows a code, opens the app, you approve. The token is saved in your user config directory (`%APPDATA%\checked`, `~/Library/Application Support/checked` or `~/.config/checked`), file mode 0600. |
| `CHECKED_API_KEY=tfy_...` | CI and servers. A workspace API key from Settings, API keys. Reaches that workspace only, with member rights (read, import, start runs), never admin. |
| `checked login --api-key tfy_...` or `echo "$KEY" \| checked login --with-key` | Save a key on a machine. |
| `checked logout` | Revokes the saved sign-in on the server and forgets it. |

`CHECKED_API_KEY` wins over `CHECKED_TOKEN`, which wins over the saved sign-in. `CHECKED_API_URL` (or `--api-url`) picks the server; the default is `https://getchecked.twelveai.app`.

Other environment variables: `CHECKED_PROJECT`, `CHECKED_ENV`, `CHECKED_WORKSPACE` (defaults for `--project`, `--env`, `--workspace`), `NO_COLOR`, `FORCE_COLOR`, `CHECKED_CONFIG_DIR`.

## Commands

```
checked login | logout | whoami
checked projects list [--workspace slug] [--archived]
checked envs list --project ref
checked import <file|url> --project ref [--yes] [--dry-run] [--replace] [--expected openapi|postman|...]
checked run --project ref [--env name] [--kind api|scan|explore|flow] [--depth critical|standard|deep]
            [--suite 1,2] [--url start] [--max-pages n] [--no-wait] [--timeout 30m] [--wait-report 2m] [--no-gates] [--no-stream]
checked scan <url> [--workspace slug] [--project ref] [--max-pages n] [--no-wait]
checked runs list --project ref | show <run> | watch <run> | report <run> [--open] | results <run> [--status failed]
checked runs rerun-failed <run> [--yes] | cancel <run>
checked findings list --project ref [--run ref] [--severity high] | show <id>
checked issues list --project ref [--status open] [--source production] | show <ref> [--explain]
checked usage [--workspace slug]
checked open [run] [--project ref] [--print]
checked mcp                            (how to add the MCP server)
```

Every command takes `--json` (results on stdout, progress and errors on stderr, errors as `{ "error": { ... } }`), `--quiet`, `--no-color`. Projects and runs take their ref (as in app URLs) or number. Finding ids are `r123` (a failed API test) or `f456` (a website finding).

`import` shows what it found and asks before saving; without a terminal it needs `--yes` (or `--dry-run`).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done; for runs, the release gates were met |
| 1 | The run finished but failed its release gates (or failed, with `--no-gates`) |
| 2 | The run errored or was cancelled |
| 3 | Timed out waiting (the run keeps going on the server) |
| 4 | Usage limit: the session or month allowance is used up, or the plan lacks the feature (HTTP 402) |
| 5 | Not signed in, or the key or token is invalid |
| 6 | Not found or not allowed |
| 7 | Rate limited |
| 64 | Bad arguments |
| 70 | Could not reach the API, or another error |

A 402 prints the server’s own message plus when it resets, for example:

```
Usage limit: You have used this session's allowance on Starter. It refreshes in 3 hours. Higher plans give more usage per session. Resets in 2 h 59 min (14:05).
```

## CI

GitHub Actions:

```yaml
name: Check’d
on: [push]
jobs:
  checked:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run the Check’d tests
        env:
          CHECKED_API_KEY: ${{ secrets.CHECKED_API_KEY }}
        run: npx -y checkd-cli run --project payments-kqzxm --depth critical --timeout 20m
```

GitLab CI (set `CHECKED_API_KEY` as a masked CI/CD variable):

```yaml
checked:
  image: node:20
  script:
    - npx -y checkd-cli run --project payments-kqzxm --depth critical --timeout 20m
```

Defect gates can change when the AI report lands about a minute after the run; add `--wait-report 2m` to judge after it.

## Issues and the inbox seam

`checked issues` and `checked findings` both go through an `IssuesProvider` (`src/core/issues.ts`). `findings` always read `GET /api/v1/cli/projects/:id/findings` (the latest run’s failed tests and scan findings). Servers with the issue inbox report `capabilities.issuesInbox: true` from `/cli/whoami`, and `issues` then read `GET /api/v1/cli/projects/:id/issues` and `GET /api/v1/cli/issues/:ref`: production errors from the SDK and test findings, with status, occurrences, users and the one-line AI summary. `checked issues show <ref> --explain` prints the cached AI explanation (what is broken, likely cause, where to look, suggested fix); it is read-only and never starts a new one. Finding ids (r123, f456) and `--run` still work under `issues`.

## Using the core in scripts

```ts
import { CheckedClient, waitForRun, runOutcome } from 'checkd-cli/core'
const client = new CheckedClient({ apiUrl: 'https://getchecked.twelveai.app', token: process.env.CHECKED_API_KEY })
const run = await client.startRun('payments-kqzxm', { depth: 'critical' })
await waitForRun(client, run.id, { timeoutMs: 20 * 60_000 })
console.log(runOutcome(await client.summary(run.id)))
```

## Development

```sh
npm install
npm test        # compiles and runs the unit tests (node:test)
npm run build   # dist/
node dist/bin.js --help
```

The CLI talks to the developer API under `/api/v1/cli` (backend `app/controllers/cli_controller.ts`).
