/**
 * Minimal server-sent events reader.
 *
 * The Fusion panel needs more than the browser's `EventSource` offers:
 *
 - the response status must be visible, so an authentication refusal (401) or a
     rejected origin (403) can be reported instead of failing silently;
 - the reconnection delay must be under the panel's control, so a server that
   keeps refusing does not get hammered;
 - the last event id must be replayed on reconnect, which `EventSource` only
   does for its own internal reconnects, not for a replacement instance.
 *
 * A `fetch` response with a `text/event-stream` body covers all three.
 */

export interface SseFrame {
  /** The `id:` field, or undefined when the frame carried none. */
  id?: string;
  /** The `event:` field, defaulting to "message" per the SSE specification. */
  event: string;
  /** The joined `data:` payload. */
  data: string;
  /** The `retry:` reconnection delay in milliseconds, when the server sent one. */
  retry?: number;
}

/**
 * Incremental parser for the SSE wire format.
 *
 * Frames are separated by a blank line. A line starting with `:` is a comment
 * and is ignored. Every other line is `field: value`, where a single leading
 * space after the colon is stripped. A field with no colon is a field name
 * with an empty value.
 */
export class SseParser {
  private buffer = "";
  private readonly dataLines: string[] = [];
  private frameId: string | undefined;
  private frameEvent: string | undefined;
  private frameRetry: number | undefined;

  /** Feeds a chunk of text and returns every complete frame it completed. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // Frames are separated by a blank line, which may arrive as \n\n or \r\n\r\n.
    let separator = this.buffer.search(/\r?\n\r?\n/);
    while (separator !== -1) {
      const raw = this.buffer.slice(0, separator);
      const match = /\r?\n\r?\n/.exec(this.buffer.slice(separator));
      this.buffer = this.buffer.slice(separator + (match?.[0].length ?? 0));
      const frame = this.consume(raw);
      if (frame !== undefined) frames.push(frame);
      separator = this.buffer.search(/\r?\n\r?\n/);
    }
    return frames;
  }

  /**
   * Consumes whatever is left once the stream ends. A last frame that was
   * never terminated by a blank line is still a frame.
   */
  flush(): SseFrame[] {
    const raw = this.buffer;
    this.buffer = "";
    const frame = this.consume(raw);
    return frame === undefined ? [] : [frame];
  }

  private consume(raw: string): SseFrame | undefined {
    if (raw.length > 0) {
      for (const line of raw.split(/\r?\n/)) {
        this.consumeLine(line);
      }
    }
    if (this.dataLines.length === 0 && this.frameEvent === undefined && this.frameId === undefined) {
      return undefined;
    }
    const frame: SseFrame = {
      event: this.frameEvent ?? "message",
      data: this.dataLines.join("\n"),
      ...(this.frameId === undefined ? {} : { id: this.frameId }),
      ...(this.frameRetry === undefined ? {} : { retry: this.frameRetry }),
    };
    this.dataLines.length = 0;
    this.frameEvent = undefined;
    this.frameId = undefined;
    this.frameRetry = undefined;
    return frame;
  }

  private consumeLine(line: string): void {
    if (line.length === 0 || line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "id") {
      // The specification ignores an id containing a NUL character.
      if (!value.includes("\0")) this.frameId = value;
    } else if (field === "event") {
      this.frameEvent = value;
    } else if (field === "retry") {
      const retry = Number(value);
      if (Number.isInteger(retry) && retry >= 0) this.frameRetry = retry;
    }
  }
}

/**
 * Exponential backoff with jitter, matching the recovery shape DSH's own
 * connection client uses (base 500ms, factor 2, cap 10s).
 */
export function backoffDelayMs(attempt: number, random = Math.random): number {
  const base = 500;
  const factor = 2;
  const cap = 10_000;
  const exponential = Math.min(cap, base * factor ** Math.max(0, attempt));
  // Jitter keeps a fleet of panels from reconnecting in lockstep.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
