import { createInterface } from 'node:readline'
import type { Io } from './output.js'

/** Asks a yes/no question on stderr. Anything but y/yes is no. */
export async function confirm(io: Io, question: string): Promise<boolean> {
  const answer = await ask(io, `${question} [y/N] `)
  return /^y(es)?$/i.test(answer.trim())
}

export function ask(io: Io, question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: !!io.stdin.isTTY })
    rl.question(question, (a) => {
      rl.close()
      resolve(a)
    })
    rl.on('close', () => resolve(''))
  })
}

/** Reads a secret without echoing it (falls back to a normal read when stdin is not a terminal). */
export function askSecret(io: Io, question: string): Promise<string> {
  if (!io.stdin.isTTY || !io.stdin.setRawMode) return ask(io, question)
  return new Promise((resolve) => {
    io.stderr.write(question)
    const stdin = io.stdin
    let value = ''
    stdin.setRawMode!(true)
    stdin.resume()
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') {
          done()
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    const done = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode!(false)
      stdin.pause()
      io.stderr.write('\n')
      resolve(value)
    }
    stdin.on('data', onData)
  })
}

/** Everything on stdin (for `echo $KEY | checked login --with-key`). */
export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
