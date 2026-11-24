#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FleetTrustStore, importFleetHostBundle } from "../dist/index.js";

const usage = `用法：
  node scripts/fleet-join.mjs --bundle <host-bundle.json> [--fleet <dir>] [--trust] [--expected]

默认 fleet 目录：${join(homedir(), ".dsh-fusion", "fleet")}
--trust     把加入包公钥写入 trusted-hosts.json
--expected  把加入包清单保存为 expected-manifest.json`;

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  bundle: { type: "string" },
  fleet: { type: "string" },
  trust: { type: "boolean" },
  expected: { type: "boolean" },
  help: { type: "boolean" },
} });

if (values.help === true || typeof values.bundle !== "string") {
  console.log(usage);
  process.exit(values.help === true ? 0 : 2);
}

const fleetDirectory = resolve(values.fleet ?? join(homedir(), ".dsh-fusion", "fleet"));
const bundle = JSON.parse(readFileSync(resolve(values.bundle), "utf8"));
const trust = new FleetTrustStore({ path: join(fleetDirectory, "trusted-hosts.json") });
try {
  const result = importFleetHostBundle(bundle, {
    directory: fleetDirectory,
    trust,
    pinTrust: values.trust === true,
    saveExpected: values.expected === true,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}
