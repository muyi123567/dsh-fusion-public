import { useEffect, useRef, useState } from "react";
import { fusionBrowserUrl } from "../routes.js";
import { backoffDelayMs, SseParser } from "./sse-reader.js";

export type FusionStreamStatus = "disabled" | "connecting" | "live" | "polling";

export type FusionStreamGapReason = "buffer-overflow" | "sequence-reset";

export interface FusionStreamGap {
  afterSeq: number;
  firstAvailableSeq: number;
  lastSeq: number;
  missingFrom: number;
  missingTo: number;
  reason: FusionStreamGapReason;
}

export interface FusionStreamOptions {
  /** The snapshot URL the client already polls. */
  snapshotUrl: string;
  /** Called whenever the server reports a change worth refetching. */
  onChange: () => void;
  /**
   * Called on a fusion.gap frame instead of onChange, so the caller
   * can force an immediate authoritative recovery instead of routing
   * the gap through any coalescing applied to ordinary changes.
   * Defaults to onChange.
   */
  onGap?: () => void;
  enabled?: boolean;
}

export interface FusionStreamState {
  status: FusionStreamStatus;
  lastEventAt?: number;
  gap?: FusionStreamGap;
  /**
   * Why the live stream is unavailable, when the server refused it outright.
   * An unauthenticated or rejected origin must be visible to the operator
   * instead of silently degrading to polling.
   */
  refusal?: string;
}

function parseFusionGap(data: string): FusionStreamGap | undefined {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    const numberFields = ["afterSeq", "firstAvailableSeq", "lastSeq", "missingFrom", "missingTo"] as const;
    if (
      !numberFields.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]))
      || (value.reason !== "buffer-overflow" && value.reason !== "sequence-reset")
    ) {
      return undefined;
    }
    return {
      afterSeq: value.afterSeq as number,
      firstAvailableSeq: value.firstAvailableSeq as number,
      lastSeq: value.lastSeq as number,
      missingFrom: value.missingFrom as number,
      missingTo: value.missingTo as number,
      reason: value.reason,
    };
  } catch {
    return undefined;
  }
}

/**
 * Derives the event-stream URL from the snapshot URL so the same client
 * works against the DSH plugin route and the standalone host.
 */
export function fusionEventsUrl(snapshotUrl: string): string | undefined {
  if (snapshotUrl.endsWith("/state")) {
    return `${snapshotUrl.slice(0, -"/state".length)}/events`;
  }
  if (snapshotUrl.endsWith("/snapshot")) {
    return `${snapshotUrl.slice(0, -"/snapshot".length)}/events`;
  }
  return undefined;
}

/**
 * Subscribes to the server event stream and reports live transitions.
 *
 * The event stream only signals that something changed; the client still
 * refetches the authoritative snapshot. That keeps one code path for
 * rendering and avoids trusting a partial event payload.
 *
 * The subscription uses `fetch` rather than `EventSource` for three reasons:
 * the HTTP status has to be visible so a refused stream can be reported, the
 * reconnect delay has to be bounded so a refusing server is not hammered, and
 * the last event id has to be replayed on reconnect, which only works when
 * the client controls the request.
 */
export function useFusionStream(options: FusionStreamOptions): FusionStreamState {
  const { snapshotUrl, onChange, onGap, enabled = true } = options;
  const [state, setState] = useState<FusionStreamState>({ status: "disabled" });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onGapRef = useRef(onGap);
  onGapRef.current = onGap;

  useEffect(() => {
    if (!enabled) {
      setState({ status: "disabled" });
      return;
    }
    const eventsUrl = fusionEventsUrl(snapshotUrl);
    if (eventsUrl === undefined || typeof fetch === "undefined") {
      setState({ status: "polling" });
      return;
    }

    let disposed = false;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastEventId: string | undefined;

    const scheduleRetry = () => {
      if (disposed || retry !== undefined) return;
      const delay = backoffDelayMs(attempt);
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        void connect();
      }, delay);
    };

    const handleFrame = (frame: { id?: string; event: string; data: string }) => {
      if (frame.id !== undefined) lastEventId = frame.id;
      if (frame.event === "fusion.gap") {
        const gap = parseFusionGap(frame.data);
        setState((current) => ({
          ...current,
          lastEventAt: Date.now(),
          ...(gap === undefined ? {} : { gap }),
        }));
        (onGapRef.current ?? onChangeRef.current)();
        return;
      }
      if (frame.event !== "message") return;
      setState((current) => {
        const { gap: _gap, ...rest } = current;
        return { ...rest, lastEventAt: Date.now() };
      });
      onChangeRef.current();
    };

    const connect = async () => {
      if (disposed) return;
      setState((current) => {
        // Dropping the key rather than setting it to undefined keeps the
        // optional property absent, which the exact-optional type requires.
        const { refusal: _refusal, ...rest } = current;
        return { ...rest, status: current.status === "live" ? "live" : "connecting" };
      });
      controller = new AbortController();
      try {
        const response = await fetch(fusionBrowserUrl(eventsUrl), {
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
            ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
          },
        });
        if (!response.ok) {
          // The server refused the stream outright. Report why instead of
          // degrading to a silent polling fallback.
          const refusal = response.status === 401
            ? "事件流未通过认证（401）"
            : response.status === 403
              ? "事件流被同源策略拒绝（403）"
              : `事件流返回 HTTP ${response.status}`;
          setState((current) => ({ ...current, status: "polling", refusal }));
          scheduleRetry();
          return;
        }
        if (response.body === null) {
          setState((current) => ({ ...current, status: "polling" }));
          scheduleRetry();
          return;
        }
        attempt = 0;
        setState((current) => {
          const { refusal: _refusal, ...rest } = current;
          return { ...rest, status: "live" };
        });
        const parser = new SseParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (disposed) return;
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            handleFrame(frame);
          }
        }
        for (const frame of parser.flush()) {
          handleFrame(frame);
        }
        if (disposed) return;
        setState((current) => ({ ...current, status: "polling" }));
        scheduleRetry();
      } catch (error) {
        if (disposed) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState((current) => ({ ...current, status: "polling" }));
        scheduleRetry();
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (retry !== undefined) clearTimeout(retry);
      controller?.abort();
    };
  }, [snapshotUrl, enabled]);

  return state;
}
