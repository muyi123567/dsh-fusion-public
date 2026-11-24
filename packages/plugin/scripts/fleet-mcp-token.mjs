#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = `用法：
  node scripts/fleet-mcp-token.mjs --file <mcp.json> --name <客户端名> [--request] [--approve]
  node scripts/fleet-mcp-token.mjs --file <mcp.json> --list
  node scripts/fleet-mcp-token.mjs --file <mcp.json> --revoke <client-id>
  node scripts/fleet-mcp-token.mjs --file <mcp.json> --enable

默认文件：${join(homedir(), ".dsh-fusion", "fleet", "mcp.json")}
明文令牌只在创建时输出一次；文件只保存 SHA-256。`;

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  file: { type: "string" }, name: { type: "string" }, list: { type: "boolean" },
  revoke: { type: "string" }, enable: { type: "boolean" }, help: { type: "boolean" },
  request: { type: "boolean" },
  approve: { type: "boolean" },
} });
if (values.help === true) {
  console.log(usage);
  process.exit(0);
}
const file = resolve(values.file ?? join(homedir(), ".dsh-fusion", "fleet", "mcp.json"));
const data = read(file);
if (values.list === true) {
  for (const client of data.clients) console.log(`${client.id}\t${client.name}\t${client.createdAt}`);
  process.exit(0);
}
if (values.enable === true) {
  data.enabled = true;
  write(file, data);
  console.log("enabled");
  process.exit(0);
}
if (values.revoke !== undefined) {
  const before = data.clients.length;
  data.clients = data.clients.filter(client => client.id !== values.revoke);
  if (data.clients.length === before) throw new Error("client not found");
  write(file, data);
  console.log("revoked");
  process.exit(0);
}
if (values.name === undefined || values.name.trim() === "" || values.name.length > 64) throw new Error("--name 必填");
const token = randomBytes(32).toString("base64url");
data.enabled = true;
data.clients.push({
  id: randomUUID(),
  name: values.name.trim(),
  tokenSha256: createHash("sha256").update(token).digest("hex"),
  scopes: [
    "read",
    ...(values.request === true ? ["request"] : []),
    ...(values.approve === true ? ["approve"] : []),
  ],
  createdAt: new Date().toISOString(),
});
write(file, data);
console.log(token);

function read(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.version !== 1 || !Array.isArray(value.clients) || typeof value.enabled !== "boolean"
      || !Number.isInteger(value.port)) throw new Error("mcp.json 格式无效");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, enabled: false, port: 8797, clients: [] };
    throw error;
  }
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, path);
}
