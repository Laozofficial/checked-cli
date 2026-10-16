import { spawn } from 'node:child_process'

/** Opens a URL in the default browser. Resolves false when that is not possible (CI, SSH, no display). */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false)
  const [cmd, args] =
    platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
      child.on('error', () => resolve(false))
      child.on('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}
