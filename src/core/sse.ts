/**
 * A minimal Server-Sent Events parser (the subset the Check’d API sends:
 * `event:`, `data:`, comments and blank-line separators).
 */
export type SseMessage = { event: string; data: string }

export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []

  /** Feed a chunk of text; returns the messages it completed. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk
    const out: SseMessage[] = []
    let idx: number
    while ((idx = this.buffer.search(/\r?\n/)) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + (this.buffer[idx] === '\r' ? 2 : 1))
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') })
        this.event = ''
        this.data = []
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') this.event = value
      else if (field === 'data') this.data.push(value)
    }
    return out
  }
}
