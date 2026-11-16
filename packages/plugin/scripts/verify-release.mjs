#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseContract } from "./release-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { packageJson } = loadReleaseContract(packageRoot);
const required = [
  "dist/THIRD_PARTY_NOTICES.txt",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/client.js",
  "dist/client.workspace.js",
  "dist/client.terminal.js",
  "dist/standalone.js",
  "cordis.patch.yml",
  "compatibility.json",
  "release.json",
  "scripts/setup.mjs",
  "scripts/installer.mjs",
  "scripts/release-contract.mjs",
];
const missing = required.filter((path) => !existsSync(resolve(packageRoot, path)));
const forbidden = existsSync(resolve(packageRoot, "dist"))
  ? readdirSync(resolve(packageRoot, "dist")).filter((name) => /\.(?:cjs|css|map)$/u.test(name))
  : [];
const exportFiles = Object.values(packageJson.exports ?? {}).flatMap((entry) =>
  typeof entry === "string" ? [entry] : Object.values(entry));
const missingExports = exportFiles.filter((path) => !existsSync(resolve(packageRoot, path)));
const fileList = new Set(packageJson.files ?? []);
const requiredFileEntries = [
  "dist",
  "scripts/setup.mjs",
  "scripts/installer.mjs",
  "scripts/release-contract.mjs",
  "release.json",
  "compatibility.json",
  "cordis.patch.yml",
];
const missingFileEntries = requiredFileEntries.filter((path) => !fileList.has(path));
const ok = missing.length === 0
  && forbidden.length === 0
  && missingExports.length === 0
  && missingFileEntries.length === 0;
const result = { ok, missing, forbidden, missingExports, missingFileEntries };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!ok) process.exitCode = 1;
