#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FleetTrustStore } from "../dist/index.js";

const usage = `用法：
  node scripts/fleet-trust.mjs --list [--file <trusted-hosts.json>]
  node scripts/fleet-trust.mjs --host <hostId> --public-key <host-public.pem> [--replace]
  node scripts/fleet-trust.mjs --revoke <hostId>

默认文件：${join(homedir(), ".dsh-fusion", "fleet", "trusted-hosts.json")}
hostId 必须与公钥派生的 sha256 一致；轮换密钥会得到新的 hostId。`;

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  file: { type: "string" },
  list: { type: "boolean" },
  host: { type: "string" },
  "public-key": { type: "string" },
  revoke: { type: "string" },
  replace: { type: "boolean" },
  help: { type: "boolean" },
} });

if (values.help === true) {
  console.log(usage);
  process.exit(0);
}

const file = resolve(values.file ?? join(homedir(), ".dsh-fusion", "fleet", "trusted-hosts.json"));
const store = new FleetTrustStore({ path: file });

try {
  if (values.list === true) {
    for (const entry of store.list()) {
      console.log(`${entry.hostId}\t${entry.source}\t${entry.fingerprint}\t${entry.publicKeyPem.split("\n")[0]}`);
    }
    process.exit(0);
  }
  if (typeof values.revoke === "string") {
    console.log(store.revoke(values.revoke) ? "revoked" : "not-found");
    process.exit(0);
  }
  if (typeof values.host !== "string" || typeof values["public-key"] !== "string") {
    console.error(usage);
    process.exit(2);
  }
  const publicKeyPem = readFileSync(resolve(values["public-key"]), "utf8");
  const entry = store.trust(values.host, publicKeyPem, "manual", values.replace === true);
  console.log(JSON.stringify(entry, null, 2));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}
