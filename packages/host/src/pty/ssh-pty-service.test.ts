import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SshPtyService,
  type Ssh2ClientLike,
  type Ssh2ConnectConfigLike,
  type Ssh2ModuleLike,
  type Ssh2ShellChannelLike,
} from "./ssh-pty-service.js";

class FakeShellChannel extends EventEmitter implements Ssh2ShellChannelLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Buffer[] = [];
  readonly signals: string[] = [];
  readonly setWindow = vi.fn();

  write(data: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data));
    return true;
  }

  close(): void {
    this.emit("close");
  }

  readonly destroy = vi.fn(() => {
    this.emit("close");
    return this;
  });

  signal(signalName: string): void {
    this.signals.push(signalName);
  }
}

class FakeSshClient extends EventEmitter implements Ssh2ClientLike {
  readonly channel = new FakeShellChannel();
  readonly shell = vi.fn((
    window: { term: string; cols: number; rows: number },
    callback: (error: Error | undefined, channel: FakeShellChannel) => void,
  ) => {
    this.shellWindow = window;
    queueMicrotask(() => callback(undefined, this.channel));
    return this;
  });
  readonly end = vi.fn(() => {
    this.emit("close");
    return this;
  });
  readonly destroy = vi.fn(() => {
    this.emit("close");
    return this;
  });
  readonly connect = vi.fn((config: Ssh2ConnectConfigLike) => {
    this.config = config;
    queueMicrotask(() => this.emit("ready"));
    return this;
  });
  config?: Ssh2ConnectConfigLike;
  shellWindow?: { term: string; cols: number; rows: number };
}

function fakeModule(): {
  module: Ssh2ModuleLike;
  clients: FakeSshClient[];
} {
  const clients: FakeSshClient[] = [];
  return {
    clients,
    module: {
      Client: class extends FakeSshClient {
        constructor() {
          super();
          clients.push(this);
        }
      },
    },
  };
}

async function fixture(knownHosts: string): Promise<{
  root: string;
  keyPath: string;
  knownHostsPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-fusion-pty-"));
  const keyPath = join(root, "host.key");
  const knownHostsPath = join(root, "known_hosts");
  await writeFile(keyPath, "private-key-material", "utf8");
  await writeFile(knownHostsPath, knownHosts, "utf8");
  return { root, keyPath, knownHostsPath };
}

function knownHostLine(host: string, key: Buffer): string {
  return `${host} ssh-ed25519 ${key.toString("base64")}\n`;
}

function hashedHostField(host: string, salt: Buffer): string {
  const digest = createHmac("sha1", salt).update(host).digest("base64");
  return `|1|${salt.toString("base64")}|${digest}`;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SshPtyService", () => {
  it("opens an xterm-256color shell with strict plain known_hosts verification", async () => {
    const hostKey = Buffer.from("plain-host-key-material");
    const paths = await fixture(knownHostLine("example.test", hostKey));
    roots.push(paths.root);
    const fake = fakeModule();
    const service = new SshPtyService({
      host: "root@example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => fake.module,
    });

    const terminal = await service.create({ cols: 120, rows: 40 });
    const client = fake.clients[0];
    expect(client).toBeDefined();
    expect(client?.config).toMatchObject({
      host: "example.test",
      username: "root",
      privateKey: Buffer.from("private-key-material"),
      hostHash: "sha256",
    });
    expect(client?.shellWindow).toEqual({ term: "xterm-256color", cols: 120, rows: 40 });
    expect(terminal.id).toMatch(/^pty-/);
    expect(terminal.state).toBe("connected");

    const verifier = client?.config?.hostVerifier;
    if (typeof verifier !== "function") throw new Error("hostVerifier missing");
    const digest = createHash("sha256").update(hostKey).digest("hex");
    expect(verifier(digest)).toBe(true);
    expect(verifier(createHash("sha256").update("wrong").digest("hex"))).toBe(false);
  });

  it("supports |1| hashed known_hosts entries and rejects another host", async () => {
    const hostKey = Buffer.from("hashed-host-key-material");
    const salt = Buffer.from("known-host-salt");
    const hashed = hashedHostField("example.test", salt);
    const paths = await fixture(`|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("example.test").digest("base64")} ssh-ed25519 ${hostKey.toString("base64")}\n`);
    roots.push(paths.root);
    const fake = fakeModule();
    const service = new SshPtyService({
      host: "ops@example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => fake.module,
    });

    await service.create({ cols: 80, rows: 24 });
    const verifier = fake.clients[0]?.config?.hostVerifier;
    if (typeof verifier !== "function") throw new Error("hostVerifier missing");
    expect(hashed.startsWith("|1|")).toBe(true);
    expect(verifier(createHash("sha256").update(hostKey).digest("hex"))).toBe(true);
    expect(verifier(createHash("sha256").update("wrong").digest("hex"))).toBe(false);

    const other = fakeModule();
    const otherService = new SshPtyService({
      host: "ops@other.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => other.module,
    });
    await otherService.create({ cols: 80, rows: 24 });
    const otherVerifier = other.clients[0]?.config?.hostVerifier;
    if (typeof otherVerifier !== "function") throw new Error("hostVerifier missing");
    expect(otherVerifier(createHash("sha256").update(hostKey).digest("hex"))).toBe(false);
  });

  it("honors negative patterns, revoked keys, and refuses cert-authority entries", async () => {
    const hostKey = Buffer.from("policy-host-key");
    const wildcard = knownHostLine("!bad.example.test,*.example.test", hostKey);
    const paths = await fixture(wildcard);
    roots.push(paths.root);
    const good = fakeModule();
    const goodService = new SshPtyService({
      host: "root@good.example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => good.module,
    });
    await goodService.create({ cols: 80, rows: 24 });
    const goodVerifier = good.clients[0]?.config?.hostVerifier;
    if (typeof goodVerifier !== "function") throw new Error("hostVerifier missing");
    expect(goodVerifier(createHash("sha256").update(hostKey).digest("hex"))).toBe(true);

    const bad = fakeModule();
    const badService = new SshPtyService({
      host: "root@bad.example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => bad.module,
    });
    await badService.create({ cols: 80, rows: 24 });
    const badVerifier = bad.clients[0]?.config?.hostVerifier;
    if (typeof badVerifier !== "function") throw new Error("hostVerifier missing");
    expect(badVerifier(createHash("sha256").update(hostKey).digest("hex"))).toBe(false);

    const revokedPaths = await fixture([
      knownHostLine("example.test", hostKey).trimEnd(),
      `@revoked example.test ssh-ed25519 ${hostKey.toString("base64")}`,
      "",
    ].join("\n"));
    roots.push(revokedPaths.root);
    const revoked = fakeModule();
    const revokedService = new SshPtyService({
      host: "root@example.test",
      keyPath: revokedPaths.keyPath,
      knownHostsPath: revokedPaths.knownHostsPath,
      ssh2Factory: async () => revoked.module,
    });
    await revokedService.create({ cols: 80, rows: 24 });
    const revokedVerifier = revoked.clients[0]?.config?.hostVerifier;
    if (typeof revokedVerifier !== "function") throw new Error("hostVerifier missing");
    expect(revokedVerifier(createHash("sha256").update(hostKey).digest("hex"))).toBe(false);

    const caPaths = await fixture([
      `@cert-authority example.test ssh-ed25519 ${hostKey.toString("base64")}`,
      "",
    ].join("\n"));
    roots.push(caPaths.root);
    const certificateAuthority = fakeModule();
    const caService = new SshPtyService({
      host: "root@example.test",
      keyPath: caPaths.keyPath,
      knownHostsPath: caPaths.knownHostsPath,
      ssh2Factory: async () => certificateAuthority.module,
    });
    await expect(caService.create({ cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "PTY_KNOWN_HOSTS_CERT_AUTHORITY_UNSUPPORTED",
    });
    expect(certificateAuthority.clients).toHaveLength(0);
  });

  it("reads the private key only when create runs and reports an unreadable key safely", async () => {
    const paths = await fixture(knownHostLine("example.test", Buffer.from("host-key")));
    roots.push(paths.root);
    const fake = fakeModule();
    const missingKey = join(paths.root, "missing.key");
    const service = new SshPtyService({
      host: "root@example.test",
      keyPath: missingKey,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => fake.module,
    });

    await expect(service.create({ cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "PTY_KEY_UNREADABLE",
    });
    expect(fake.clients).toHaveLength(0);
  });

  it("streams output, resizes the channel, and keeps a bounded raw snapshot", async () => {
    const paths = await fixture(knownHostLine("example.test", Buffer.from("host-key")));
    roots.push(paths.root);
    const fake = fakeModule();
    const service = new SshPtyService({
      host: "root@example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      snapshotBytes: 8,
      ssh2Factory: async () => fake.module,
    });
    const terminal = await service.create({ cols: 80, rows: 24 });
    const events: Array<{ sequence: number; data: Buffer }> = [];
    terminal.subscribe((event) => {
      if (event.type === "output") events.push(event);
    });

    fake.clients[0]?.channel.stdout.write(Buffer.from("abcdefghij"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual([
      expect.objectContaining({ sequence: 1, data: Buffer.from("abcdefghij") }),
    ]);
    expect(terminal.snapshot()).toEqual({
      sequence: 1,
      data: Buffer.from("cdefghij"),
      truncated: true,
      state: "connected",
    });

    terminal.resize(100, 30);
    expect(fake.clients[0]?.channel.setWindow).toHaveBeenCalledWith(30, 100, 0, 0);
    terminal.close();
    expect(fake.clients[0]?.end).toHaveBeenCalledOnce();
    expect(terminal.state).toBe("closed");
  });

  it("limits concurrent terminals to four and disposes every live channel", async () => {
    const paths = await fixture(knownHostLine("example.test", Buffer.from("host-key")));
    roots.push(paths.root);
    const fake = fakeModule();
    const service = new SshPtyService({
      host: "root@example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => fake.module,
    });
    const terminals = await Promise.all([
      service.create({ cols: 80, rows: 24 }),
      service.create({ cols: 80, rows: 24 }),
      service.create({ cols: 80, rows: 24 }),
      service.create({ cols: 80, rows: 24 }),
    ]);

    expect(service.activeCount).toBe(4);
    await expect(service.create({ cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "PTY_LIMIT_REACHED",
    });

    service.dispose();
    expect(service.activeCount).toBe(0);
    expect(terminals.every((terminal) => terminal.state === "closed")).toBe(true);
    expect(fake.clients.filter((client) => client.destroy.mock.calls.length > 0)).toHaveLength(4);
  });

  it("reserves pending creation slots synchronously before awaiting SSH", async () => {
    const paths = await fixture(knownHostLine("example.test", Buffer.from("host-key")));
    roots.push(paths.root);
    const fake = fakeModule();
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const service = new SshPtyService({
      host: "root@example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => {
        await factoryGate;
        return fake.module;
      },
    });

    const pending = Array.from({ length: 4 }, () => service.create({ cols: 80, rows: 24 }));
    await expect(service.create({ cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "PTY_LIMIT_REACHED",
    });
    releaseFactory?.();
    await Promise.all(pending);
    expect(service.activeCount).toBe(4);
  });

  it("always destroys the SSH client even when channel disposal throws", async () => {
    const paths = await fixture(knownHostLine("example.test", Buffer.from("host-key")));
    roots.push(paths.root);
    const fake = fakeModule();
    const service = new SshPtyService({
      host: "root@example.test",
      keyPath: paths.keyPath,
      knownHostsPath: paths.knownHostsPath,
      ssh2Factory: async () => fake.module,
    });
    await service.create({ cols: 80, rows: 24 });
    const client = fake.clients[0]!;
    client.channel.destroy.mockImplementationOnce(() => {
      throw new Error("channel destroy failed");
    });

    service.dispose();

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(service.activeCount).toBe(0);
  });
});
