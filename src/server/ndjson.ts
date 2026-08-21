/**
 * Splits a byte stream into newline-delimited lines.
 *
 * ACP's stdio transport says messages are delimited by `\n` and MUST NOT
 * contain embedded newlines, so a plain splitter is sufficient and, crucially,
 * lossless: whatever the agent wrote is what the log records, including lines
 * that are not valid JSON at all.
 */
export class LineSplitter {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  /** Emit anything left in the buffer, e.g. when the process exits mid-line. */
  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest.length > 0) this.onLine(rest);
  }
}
