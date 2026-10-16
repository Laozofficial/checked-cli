#!/usr/bin/env node
import { main } from './cli/main.js'
import { openInBrowser } from './cli/browser.js'

const major = Number(process.versions.node.split('.')[0])
if (major < 20) {
  process.stderr.write(`checked needs Node.js 20 or newer (this is ${process.versions.node}).\n`)
  process.exit(70)
}

main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env }, { openUrl: (u) => openInBrowser(u) }).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    process.stderr.write(`${(e as Error)?.stack ?? e}\n`)
    process.exitCode = 70
  }
)
