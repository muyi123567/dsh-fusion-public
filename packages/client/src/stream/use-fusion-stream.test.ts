import { createElement } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotRecord, NodeRecord } from "@dsh-fusion/core";
import { Topbar } from "../shell/Topbar.js";
import {
  fusionEventsUrl,
  useFusionStream,
  type FusionStreamGap,
} from "./use-fusion-stream.js";

describe("fusionEventsUrl", () => {
  it("maps the plugin state route to its event route", () => {
    expect(fusionEventsUrl("/plugins/dsh-fusion/state"))
      .toBe("/plugins/dsh-fusion/events");
  });

  it("maps the standalone snapshot route to its event route", () => {
    expect(fusionEventsUrl("/api/fusion/snapshot")).toBe("/api/fusion/events");
  });

  it("returns undefined for a route without a known event twin", () => {
    expect(fusionEventsUrl("/custom/thing")).toBeUndefined();
  });
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useFusionStream", () => {
  it("reports live and signals a change for every message frame", async () => {
    const encoder = new TextEncoder();
    let sent = false;
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode("id: 1\ndata: {\"type\":\"state.updated\"}\n\n"));
            controller.enqueue(encoder.encode("id: 2\ndata: {\"type\":\"node.updated\"}\n\n"));
            return;
          }
          // Stay open so the stream keeps reporting "live".
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();

    const { result } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange,
    }));

    await waitFor(() => expect(result.current.status).toBe("live"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
  });

  it("replays the last event id when it reconnects", async () => {
    const seen: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("last-event-id") ?? undefined);
      if (seen.length === 1) {
        return new Response(streamOf(["id: 42\ndata: {}\n\n"]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      // The second connection stays open so the test does not spin.
      return new Response(new ReadableStream<Uint8Array>({ start() { /* hold open */ } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange: () => {},
    }));

    await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(seen[1]).toBe("42"), { timeout: 5_000 });
  });

  it("recovers once from a gap and advances Last-Event-ID", async () => {
    const gap: FusionStreamGap = {
      afterSeq: 8,
      firstAvailableSeq: 10,
      lastSeq: 12,
      missingFrom: 9,
      missingTo: 9,
      reason: "buffer-overflow",
    };
    const seen: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("last-event-id") ?? undefined);
      if (seen.length === 1) {
        return new Response(streamOf([
          `event: fusion.gap\nid: 12\ndata: ${JSON.stringify(gap)}\n\n`,
        ]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(new ReadableStream<Uint8Array>({ start() { /* hold open */ } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();

    const { result } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange,
    }));

    await waitFor(() => expect(result.current.gap).toEqual(gap));
    expect(onChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seen[1]).toBe("12"), { timeout: 5_000 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("routes gap frames to onGap and message frames to onChange", async () => {
    const gap: FusionStreamGap = {
      afterSeq: 8,
      firstAvailableSeq: 10,
      lastSeq: 12,
      missingFrom: 9,
      missingTo: 9,
      reason: "buffer-overflow",
    };
    const fetchMock = vi.fn(async () => new Response(streamOf([
      "id: 1\ndata: {\"type\":\"state.updated\"}\n\n",
      `event: fusion.gap\nid: 12\ndata: ${JSON.stringify(gap)}\n\n`,
    ]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();
    const onGap = vi.fn();

    renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange,
      onGap,
    }));

    await waitFor(() => expect(onGap).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clears the previous gap when a normal message arrives", async () => {
    const gap: FusionStreamGap = {
      afterSeq: 8,
      firstAvailableSeq: 10,
      lastSeq: 12,
      missingFrom: 9,
      missingTo: 9,
      reason: "buffer-overflow",
    };
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const onChange = vi.fn();
    const { result } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange,
    }));

    await waitFor(() => expect(result.current.status).toBe("live"));
    act(() => controller?.enqueue(encoder.encode(
      `event: fusion.gap\nid: 12\ndata: ${JSON.stringify(gap)}\n\n`,
    )));
    await waitFor(() => expect(result.current.gap).toEqual(gap));
    act(() => controller?.enqueue(encoder.encode(
      "id: 13\ndata: {\"type\":\"state.updated\"}\n\n",
    )));
    await waitFor(() => expect(result.current.gap).toBeUndefined());
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("surfaces a refused stream instead of degrading silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));

    const { result } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange: () => {},
    }));

    await waitFor(() => expect(result.current.refusal).toContain("401"));
    expect(result.current.status).toBe("polling");
  });

  it("does not subscribe when disabled", () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange: () => {},
      enabled: false,
    }));

    expect(result.current.status).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the request when the panel unmounts", async () => {
    const aborts: boolean[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => aborts.push(true));
      return new Response(new ReadableStream<Uint8Array>({ start() { /* hold open */ } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));

    const { unmount } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange: () => {},
    }));
    await waitFor(() => expect(aborts.length).toBe(0));
    await act(async () => { unmount(); });
    expect(aborts.length).toBeGreaterThan(0);
  });

  it("does not process a chunk that resolves after unmount", async () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        // Simulate a transport that has not observed the abort yet.
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() => useFusionStream({
      snapshotUrl: "/plugins/dsh-fusion/state",
      onChange,
    }));

    await waitFor(() => expect(result.current.status).toBe("live"));
    await act(async () => {
      controller?.enqueue(encoder.encode(
        "id: 7\ndata: {\"type\":\"state.updated\"}",
      ));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      unmount();
      controller?.close();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("FusionStreamGap UI", () => {
  it("shows the missing sequence range and pull-request state in the Topbar", () => {
    const bot: BotRecord = {
      id: "chief",
      providerId: "test",
      name: "Chief",
      role: "Chief of Staff",
      model: "test-model",
      isMain: true,
      status: "idle",
    };
    const node: NodeRecord = {
      id: "node",
      externalId: "node",
      providerId: "test",
      name: "Node",
      platform: "linux",
      roles: ["worker"],
      status: "online",
      transports: [],
      capabilities: [],
      configState: "current",
    };
    const gap: FusionStreamGap = {
      afterSeq: 8,
      firstAvailableSeq: 10,
      lastSeq: 12,
      missingFrom: 9,
      missingTo: 9,
      reason: "buffer-overflow",
    };

    render(createElement(Topbar, {
      mode: "fleet",
      selectedBot: bot,
      selectedNode: node,
      onToggleSidebar: () => {},
      onToggleDetails: () => {},
      onOpenConfig: () => {},
      streamStatus: "live",
      streamGap: gap,
    }));

    const notice = screen.getByText("缺口 seq 9-9");
    expect(notice).toBeVisible();
    expect(notice).toHaveAttribute("title", expect.stringContaining("已请求全量快照拉取"));
  });
});
