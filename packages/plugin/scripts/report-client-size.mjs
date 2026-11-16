import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = resolve(root, "packages/plugin/dist");
const report = {
  generatedAt: new Date().toISOString(),
  measurement: "production file bytes; gzipSync defaults; not runtime latency",
  files: readdirSync(dist).filter((name) => name.startsWith("client") && name.endsWith(".js")).sort().map((file) => {
    const bytes = readFileSync(resolve(dist, file));
    return { file, raw: bytes.length, gzip: gzipSync(bytes).length };
  }),
};
const output = resolve(root, "artifacts/qa/native-client-size.json");
mkdirSync(resolve(root, "artifacts/qa"), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, ...report }, null, 2));
