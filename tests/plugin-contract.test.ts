import { describe, expect, it } from "vitest";
import * as clientPlugin from "../packages/plugin/src/client.js";
import * as hostPlugin from "../packages/plugin/src/index.js";
import {
  assertDshInstallable,
  resolveDshCompatibility,
} from "../packages/plugin/src/compatibility.js";

describe("DSH plugin contract", () => {
  it("exports host and client apply functions with declared injections", () => {
    expect(typeof hostPlugin.apply).toBe("function");
    expect(Array.isArray(hostPlugin.inject)).toBe(true);
    expect(typeof clientPlugin.apply).toBe("function");
    expect(clientPlugin.inject).toContain("slots");
  });

  it("fails closed on unsupported DSH versions and degrades untested hosts", () => {
    expect(() => assertDshInstallable(resolveDshCompatibility({
      configuredVersion: "0.1.5-rc.2",
    }))).toThrow("DSH_INCOMPATIBLE_VERSION");
    expect(() => assertDshInstallable(resolveDshCompatibility({
      configuredVersion: "0.2.0-rc.2",
    }))).not.toThrow();
    const latest = resolveDshCompatibility({ configuredVersion: "0.2.2-rc.5" });
    expect(latest.state).toBe("verified");
    expect(() => assertDshInstallable(latest)).not.toThrow();
    const untested = resolveDshCompatibility({ configuredVersion: "0.2.1-rc.5" });
    expect(untested.state).toBe("untested");
    expect(() => assertDshInstallable(untested)).not.toThrow();
  });

  it("registers the DSH web state route and fusion status tool", async () => {
    const routes: Array<{
      kind: string;
      path: string;
      handler: (
        request: { method?: string; headers?: Record<string, string | string[] | undefined> },
        response: {
          writeHead: (status: number, headers: Record<string, string>) => void;
          end: (body?: string) => void;
        },
      ) => void | Promise<void>;
    }> = [];
    const tools: Array<{ name: string }> = [];
    const disposers: Array<() => void> = [];
    const ctx = new Proxy({
      tools: {
        register(tool: { name: string }) {
          tools.push(tool);
          return () => tools.splice(tools.indexOf(tool), 1);
        },
        guard() {
          return () => {};
        },
      },
      get(name: string) {
        if (name === "webServer") {
          return {
            register(route: (typeof routes)[number]) {
              routes.push(route);
              return () => routes.splice(routes.indexOf(route), 1);
            },
          };
        }
        if (name === "connection") {
          return { requestRejection: () => undefined };
        }
        return undefined;
      },
      on() {
        return () => {};
      },
      effect(callback: () => void) {
        disposers.push(callback());
        return () => {};
      },
    }, {
      get(target, property, receiver) {
        if (property === "config") throw new Error("ctx.config must not be read");
        return Reflect.get(target, property, receiver);
      },
    }) as Parameters<typeof hostPlugin.apply>[0];

    await hostPlugin.apply(ctx, {
      dshVersion: "0.2.0-rc.2",
      standalone: false,
    });

    expect(routes).toContainEqual(expect.objectContaining({
      kind: "exact",
      path: "/plugins/dsh-fusion/state",
    }));
    expect(tools).toContainEqual(expect.objectContaining({ name: "fusion_status" }));
    expect(tools.map((tool) => tool.name)).not.toContain("fusion_task_dispatch");

    const route = routes.find((entry) => entry.path === "/plugins/dsh-fusion/state");
    expect(route).toBeDefined();
    let status = 0;
    let body = "";
    await route!.handler({ method: "GET", headers: {} }, {
      writeHead(nextStatus) {
        status = nextStatus;
      },
      end(nextBody) {
        body = nextBody ?? "";
      },
    });

    const payload = JSON.parse(body) as {
      demo: boolean;
      sources: Record<string, string>;
      providers: Record<string, { state: string }>;
      config: { revision: string; nodeStates: Record<string, string> };
    };
    expect(status).toBe(200);
    expect(payload.demo).toBe(false);
    expect(payload.sources.nodes).toBe("unavailable");
    expect(payload.sources.agentTeams).toBe("unavailable");
    expect(payload.providers.agentTeams.state).toBe("not-configured");
    expect(payload.config.revision).toBe("live");
    expect(payload.config.nodeStates).toEqual({});
  });

  it("rejects raw web mutations before DSH Connection authentication", async () => {
    const routes: Array<{
      path: string;
      handler: (...args: any[]) => void | Promise<void>;
    }> = [];
    const ctx = {
      tools: { register: () => () => {}, guard: () => () => {} },
      get(name: string) {
        if (name === "webServer") {
          return {
            register(route: { path: string; handler: any }) {
              routes.push(route);
              return () => {};
            },
          };
        }
        if (name === "connection") {
          return { requestRejection: () => 401 as const };
        }
        return undefined;
      },
      on() {
        return () => {};
      },
      effect(callback: () => () => void) {
        callback();
        return () => {};
      },
    } as Parameters<typeof hostPlugin.apply>[0];

    await hostPlugin.apply(ctx, {
      dshVersion: "0.2.0-rc.2",
      standalone: false,
    });
    const taskRoute = routes.find((route) => route.path === "/plugins/dsh-fusion/tasks");
    if (taskRoute === undefined) throw new Error("task route missing");
    let status = 0;
    let body = "";
    await taskRoute.handler(
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        async *[Symbol.asyncIterator]() {
          yield JSON.stringify({ goal: "unsafe", command: "id" });
        },
      },
      {
        writeHead(nextStatus: number) {
          status = nextStatus;
        },
        end(nextBody?: string) {
          body = nextBody ?? "";
        },
      },
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toEqual({ error: "AUTHENTICATION_REQUIRED" });
  });
});
