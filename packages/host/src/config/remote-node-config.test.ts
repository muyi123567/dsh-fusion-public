import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RemoteNodeConfigService,
  renderRemoteNodeConfig,
  type RemoteCommandResult,
  type RemoteNodeConfigInput,
} from "./remote-node-config.js";

const input: RemoteNodeConfigInput = {
  nodeId: "huawei-test",
  displayName: "Huawei Test",
  dshVersion: "0.2.0-rc.2",
  workspaceRoot: "/srv/dsh",
  capabilities: ["linux", "ssh", "hindsight"],
};

function doctorOutput(json?: string): RemoteCommandResult {
  if (json === undefined) return { stdout: "EXISTS=0\n", stderr: "", exitCode: 0 };
  return {
    stdout: `EXISTS=1\nDATA=${Buffer.from(json, "utf8").toString("base64")}\n`,
    stderr: "",
    exitCode: 0,
  };
}

async function applyWithRollbackResult(
  rollback: () => Promise<RemoteCommandResult>,
) {
  const previous = renderRemoteNodeConfig({ ...input, dshVersion: "0.1.5-rc.2" });
  const service = new RemoteNodeConfigService({
    configPath: "/etc/dsh-fusion/node.json",
    run: async (command) => {
      if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
        return { stdout: "", stderr: "mv failed", exitCode: 1 };
      }
      if (command.includes("REMOTE_NODE_CONFIG_ROLLBACK")) {
        return await rollback();
      }
      return doctorOutput(previous.json);
    },
  });
  return await service.apply(input);
}

describe("renderRemoteNodeConfig", () => {
  it("renders stable JSON with only allowlisted fields", () => {
    const rendered = renderRemoteNodeConfig(input);
    const expectedJson = [
      "{",
      '  "version": 1,',
      '  "nodeId": "huawei-test",',
      '  "displayName": "Huawei Test",',
      '  "dshVersion": "0.2.0-rc.2",',
      '  "workspaceRoot": "/srv/dsh",',
      '  "transport": "ssh",',
      '  "capabilities": [',
      '    "linux",',
      '    "ssh",',
      '    "hindsight"',
      "  ]",
      "}",
      "",
    ].join("\n");
    const expectedHash = createHash("sha256").update(expectedJson).digest("hex");

    expect(rendered.json).toBe(expectedJson);
    expect(rendered.hash).toBe(expectedHash);
    expect(rendered.config).not.toHaveProperty("apiKey");
    expect(rendered.config).not.toHaveProperty("password");
  });

  it("rejects unknown secret fields and secret-shaped values", () => {
    expect(() => renderRemoteNodeConfig({
      ...input,
      apiKey: "plain-text-key",
    } as RemoteNodeConfigInput)).toThrow();
    expect(() => renderRemoteNodeConfig({
      ...input,
      capabilities: ["ssh", "token=plain-text-token"],
    })).toThrow();
  });

  it("rejects unsafe workspace and version values", () => {
    expect(() => renderRemoteNodeConfig({
      ...input,
      workspaceRoot: "relative/workspace",
    })).toThrow();
    expect(() => renderRemoteNodeConfig({
      ...input,
      dshVersion: "latest\nrm -rf /",
    })).toThrow();
  });
});

describe("RemoteNodeConfigService", () => {
  it("reports current when the active remote config hash matches", async () => {
    const rendered = renderRemoteNodeConfig(input);
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async () => doctorOutput(rendered.json),
    });

    await expect(service.doctor(input)).resolves.toMatchObject({
      ok: true,
      state: "current",
      activeHash: rendered.hash,
    });
  });

  it("does not attempt rollback when the desired config is already current", async () => {
    const rendered = renderRemoteNodeConfig(input);
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        return doctorOutput(rendered.json);
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
      doctor: { state: "current" },
    });
    expect(commands).toHaveLength(1);
  });

  it("reports drift without rewriting the remote config", async () => {
    const previous = renderRemoteNodeConfig({ ...input, dshVersion: "0.1.5-rc.2" });
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        return doctorOutput(previous.json);
      },
    });

    await expect(service.doctor(input)).resolves.toMatchObject({
      ok: false,
      state: "drift",
      activeHash: previous.hash,
    });
    expect(commands).toHaveLength(1);
  });

  it("applies through a same-directory atomic rename and verifies the doctor", async () => {
    const rendered = renderRemoteNodeConfig(input);
    const commands: string[] = [];
    let doctorCalls = 0;
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
          return {
            stdout: `APPLIED=1\nSHA256=${rendered.hash}\nATOMIC=1\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        doctorCalls += 1;
        return doctorCalls === 1 ? doctorOutput() : doctorOutput(rendered.json);
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: true,
      rolledBack: false,
      rollbackAttempted: false,
      activeHash: rendered.hash,
      desiredHash: rendered.hash,
    });
    expect(result.doctor.state).toBe("current");
    expect(commands).toHaveLength(3);
    expect(commands[1]).toContain('tmp="${target}.tmp.$$"');
    expect(commands[1]).toContain('backup_tmp="${backup}.tmp.$$"');
    expect(commands[1]).toContain("mkdir -p --");
    expect(commands[1]).toContain("base64 -d");
    expect(commands[1]).toContain('mv -f -- "$backup_tmp" "$backup"');
    expect(commands[1]).toContain('mv -f -- "$tmp" "$target"');
    expect(commands[1]).not.toContain("plain-text-key");
  });

  it("uses an installed JSON parser without requiring Node on the remote host", async () => {
    const rendered = renderRemoteNodeConfig(input);
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
          return {
            stdout: `APPLIED=1\nSHA256=${rendered.hash}\nATOMIC=1\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return doctorOutput(commands.length === 1 ? undefined : rendered.json);
      },
    });

    await service.apply(input);

    const apply = commands.find((command) => command.includes("REMOTE_NODE_CONFIG_APPLY"));
    expect(apply).toBeDefined();
    const applyCommand = apply ?? "";
    expect(applyCommand).toContain("command -v python3");
    expect(applyCommand).toContain("json.load");
    expect(applyCommand).toContain("command -v jq");
    expect(applyCommand).toContain("command -v node");
    expect(applyCommand).toContain("REMOTE_CONFIG_VALIDATOR_UNAVAILABLE");
    expect(applyCommand).toContain("REMOTE_CONFIG_JSON_INVALID");
    expect(applyCommand.indexOf("command -v node")).toBeLessThan(
      applyCommand.indexOf("node -e"),
    );
  });

  it("restores the previous file when post-apply drift is detected", async () => {
    const previous = renderRemoteNodeConfig({ ...input, dshVersion: "0.1.5-rc.2" });
    const rendered = renderRemoteNodeConfig(input);
    const commands: string[] = [];
    let doctorCalls = 0;
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
          return {
            stdout: `APPLIED=1\nSHA256=${rendered.hash}\nATOMIC=1\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (command.includes("REMOTE_NODE_CONFIG_ROLLBACK")) {
          return { stdout: "ROLLED_BACK=1\n", stderr: "", exitCode: 0 };
        }
        doctorCalls += 1;
        return doctorCalls === 1 ? doctorOutput(previous.json) : doctorOutput(previous.json);
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: true,
      rollbackAttempted: true,
      activeHash: previous.hash,
      previousHash: previous.hash,
      desiredHash: rendered.hash,
    });
    expect(result).not.toHaveProperty("rollbackError");
    expect(commands.some((command) => command.includes("REMOTE_NODE_CONFIG_APPLY"))).toBe(true);
    const rollback = commands.find((command) => command.includes("REMOTE_NODE_CONFIG_ROLLBACK"));
    expect(rollback).toContain('rollback_tmp="${target}.rollback.$$"');
    expect(rollback).toContain('mv -f -- "$rollback_tmp" "$target"');
    expect(rollback).toContain("sha256sum -- \"$target\"");
  });

  it("attempts rollback when the atomic apply command fails", async () => {
    const previous = renderRemoteNodeConfig({ ...input, dshVersion: "0.1.5-rc.2" });
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
          return { stdout: "", stderr: "mv failed", exitCode: 1 };
        }
        if (command.includes("REMOTE_NODE_CONFIG_ROLLBACK")) {
          return { stdout: "ROLLED_BACK=1\n", stderr: "", exitCode: 0 };
        }
        return doctorOutput(previous.json);
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: true,
      rollbackAttempted: true,
      activeHash: previous.hash,
    });
    expect(result.doctor.message).toContain("mv failed");
    expect(commands.at(-1)).toContain("REMOTE_NODE_CONFIG_ROLLBACK");
  });

  it.each([
    {
      name: "command rejection",
      rollback: async (): Promise<RemoteCommandResult> => {
        throw new Error("rollback channel closed");
      },
      expected: "rollback channel closed",
    },
    {
      name: "non-zero exit",
      rollback: async (): Promise<RemoteCommandResult> => ({
        stdout: "",
        stderr: "restore denied",
        exitCode: 2,
      }),
      expected: "restore denied",
    },
    {
      name: "missing success marker",
      rollback: async (): Promise<RemoteCommandResult> => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      expected: "ROLLED_BACK",
    },
  ])("reports rollback failure on $name", async ({ rollback, expected }) => {
    const previous = renderRemoteNodeConfig({ ...input, dshVersion: "0.1.5-rc.2" });
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
          return { stdout: "", stderr: "mv failed", exitCode: 1 };
        }
        if (command.includes("REMOTE_NODE_CONFIG_ROLLBACK")) {
          return await rollback();
        }
        return doctorOutput(previous.json);
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: false,
      rollbackAttempted: true,
    });
    expect(result.rollbackError).toContain(expected);
  });

  it("limits rollback diagnostics to one control-free line", async () => {
    const result = await applyWithRollbackResult(async () => ({
      stdout: "",
      stderr: "restore denied\u0000\u0007\n    at rollback.ts:12\n/etc/passwd\n/tmp/a:/tmp/b",
      exitCode: 1,
    }));

    expect(result.rollbackError).toBe("REMOTE_CONFIG_ROLLBACK_FAILED:restore denied");
  });

  it("caps rollback diagnostics at 240 characters", async () => {
    const result = await applyWithRollbackResult(async () => ({
      stdout: "",
      stderr: "x".repeat(400),
      exitCode: 1,
    }));

    expect(result.rollbackError).toHaveLength(240);
    expect(result.rollbackError).toMatch(/\.\.\.$/);
  });

  it.each([
    {
      diagnostic: "password=hunter2",
      secret: "hunter2",
      redacted: "password=[REDACTED]",
    },
    {
      diagnostic: "token: abc123",
      secret: "abc123",
      redacted: "token: [REDACTED]",
    },
    {
      diagnostic: "secret=topsecret",
      secret: "topsecret",
      redacted: "secret=[REDACTED]",
    },
    {
      diagnostic: "api-key: apiValue",
      secret: "apiValue",
      redacted: "api-key: [REDACTED]",
    },
    {
      diagnostic: "private-key=privateValue",
      secret: "privateValue",
      redacted: "private-key=[REDACTED]",
    },
    {
      diagnostic: "Authorization: Bearer bearerValue",
      secret: "bearerValue",
      redacted: "Authorization: [REDACTED]",
    },
    {
      diagnostic: "access_token: compoundToken",
      secret: "compoundToken",
      redacted: "access_token: [REDACTED]",
    },
    {
      diagnostic: '"password": "jsonPassword"',
      secret: "jsonPassword",
      redacted: '"password": [REDACTED]',
    },
  ])("redacts sensitive rollback key/value: $diagnostic", async ({
    diagnostic,
    secret,
    redacted,
  }) => {
    const result = await applyWithRollbackResult(async () => ({
      stdout: "",
      stderr: diagnostic,
      exitCode: 1,
    }));

    expect(result.rollbackError).toContain(redacted);
    expect(result.rollbackError).not.toContain(secret);
  });

  it("requires atomic completion evidence before reporting success", async () => {
    const previous = renderRemoteNodeConfig({ ...input, dshVersion: "0.1.5-rc.2" });
    const rendered = renderRemoteNodeConfig(input);
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        if (command.includes("REMOTE_NODE_CONFIG_APPLY")) {
          return {
            stdout: `APPLIED=1\nSHA256=${rendered.hash}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (command.includes("REMOTE_NODE_CONFIG_ROLLBACK")) {
          return { stdout: "ROLLED_BACK=1\n", stderr: "", exitCode: 0 };
        }
        return doctorOutput(previous.json);
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: true,
      rollbackAttempted: true,
      doctor: {
        state: "apply-failed",
        message: "REMOTE_CONFIG_APPLY_NOT_CONFIRMED",
      },
    });
    expect(commands.at(-1)).toContain("REMOTE_NODE_CONFIG_ROLLBACK");
  });

  it("does not mutate the host when the preflight doctor cannot connect", async () => {
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        return { stdout: "", stderr: "connection reset", exitCode: 255 };
      },
    });

    const result = await service.apply(input);

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackAttempted).toBe(false);
    expect(result.doctor).toMatchObject({
      ok: false,
      state: "unreachable",
      message: expect.stringContaining("connection reset"),
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("REMOTE_NODE_CONFIG_DOCTOR");
  });

  it("does not apply when the doctor returns an invalid protocol response", async () => {
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        return { stdout: "not-a-key-value-response", stderr: "", exitCode: 0 };
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
      doctor: {
        ok: false,
        state: "doctor-failed",
      },
    });
    expect(commands).toHaveLength(1);
  });

  it("reports a remote doctor capability failure without mutating the host", async () => {
    const commands: string[] = [];
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async (command) => {
        commands.push(command);
        return {
          stdout: "",
          stderr: "REMOTE_CONFIG_TOOL_UNAVAILABLE:base64",
          exitCode: 127,
        };
      },
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
      doctor: {
        ok: false,
        state: "doctor-failed",
        message: expect.stringContaining("REMOTE_CONFIG_TOOL_UNAVAILABLE:base64"),
        checks: [
          { id: "ssh", ok: true },
          { id: "config-output", ok: false },
        ],
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("REMOTE_NODE_CONFIG_DOCTOR");
  });

  it("reports a remote config read denial as doctor-failed rather than unreachable", async () => {
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async () => ({
        stdout: "",
        stderr: "/etc/dsh-fusion/node.json: Permission denied",
        exitCode: 1,
      }),
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
      doctor: {
        state: "doctor-failed",
        checks: [
          { id: "ssh", ok: true },
          { id: "config-output", ok: false },
        ],
      },
    });
  });

  it("reports a local SSH spawn failure as unreachable", async () => {
    const service = new RemoteNodeConfigService({
      configPath: "/etc/dsh-fusion/node.json",
      run: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 1,
        errorCode: "EPERM",
      }),
    });

    const result = await service.apply(input);

    expect(result).toMatchObject({
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
      doctor: {
        state: "unreachable",
        message: expect.stringContaining("EPERM"),
      },
    });
  });
});
