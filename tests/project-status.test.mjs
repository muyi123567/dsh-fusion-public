import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Fail-safe contract for scripts/project-status.mjs:
 *
 * When `gh` is unavailable or unauthenticated, refreshing the generated
 * status block must NOT erase the previously recorded Issue table. The old
 * table is kept and marked stale. Only a successful `gh` read replaces it.
 *
 * Run with: node tests/project-status.test.mjs
 */

const repoRoot = join(import.meta.dirname, "..");

const EXISTING_TABLE = [
  "| # | 状态 | 标题 |",
  "| --- | --- | --- |",
  "| #1 | CLOSED | 示例已关闭 |",
  "| #5 | OPEN | 示例未关闭 |",
  "",
  "合计 2 个 issue：1 已关闭，1 未关闭。",
];

function makeFixture(issueSectionLines) {
  const dir = mkdtempSync(join(tmpdir(), "project-status-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "docs/project"), { recursive: true });
  cpSync(join(repoRoot, "scripts/project-status.mjs"), join(dir, "scripts/project-status.mjs"));
  const status = [
    "# fixture",
    "",
    "<!-- BEGIN:generated-status -->",
    "",
    "### Issue 状态",
    "",
    ...issueSectionLines,
    "",
    "### 最近提交",
    "",
    "| 提交 | 时间 | 说明 |",
    "| --- | --- | --- |",
    "",
    "<!-- END:generated-status -->",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docs/project/status.md"), status, "utf8");
  return dir;
}

function runScript(dir, extraPath) {
  const env = { ...process.env };
  // A PATH without `gh` simulates "not installed"; a fixture bin dir with a
  // fake `gh` simulates a working, authenticated CLI. Windows env keys are
  // case-insensitive, so drop every Path/PATH variant before setting ours —
  // otherwise the child could inherit the real PATH alongside the fixture.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = extraPath ?? join(dir, "empty-bin");
  execFileSync(process.execPath, [join(dir, "scripts/project-status.mjs")], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return readFileSync(join(dir, "docs/project/status.md"), "utf8");
}

test("gh unavailable: existing issue table is preserved and marked stale", () => {
  const dir = makeFixture(EXISTING_TABLE);
  try {
    const out = runScript(dir);
    assert.match(out, /\| #1 \| CLOSED \| 示例已关闭 \|/);
    assert.match(out, /\| #5 \| OPEN \| 示例未关闭 \|/);
    assert.match(out, /合计 2 个 issue/);
    assert.match(out, /未刷新|stale/i, "preserved table must be marked as not refreshed");
    assert.doesNotMatch(out, /Issue state unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gh unavailable twice: stale note does not stack and table survives", () => {
  const dir = makeFixture(EXISTING_TABLE);
  try {
    runScript(dir);
    const out = runScript(dir);
    assert.match(out, /\| #5 \| OPEN \| 示例未关闭 \|/);
    const notes = out.split("\n").filter((line) => /未刷新|stale/i.test(line));
    assert.equal(notes.length, 1, `stale note must appear exactly once, got ${notes.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gh unavailable and no prior table: unavailable line is kept, nothing invented", () => {
  const dir = makeFixture(["_Issue state unavailable: the `gh` CLI is not installed or not authenticated._"]);
  try {
    const out = runScript(dir);
    assert.match(out, /Issue state unavailable/);
    assert.doesNotMatch(out, /\| # \| 状态 \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gh available: issue table is regenerated from live data without stale note", () => {
  const dir = makeFixture(EXISTING_TABLE);
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // Cross-platform fake CLI: the payload printer is a Node fixture, and
    // only the thin launcher differs per platform. A POSIX `#!/bin/sh`
    // script cannot be executed as `gh` on Windows; a `gh.cmd` can, and
    // the script under test invokes `gh` through a shell on win32 for
    // exactly this reason (CVE-2024-27980 .cmd spawn restriction).
    const payload = JSON.stringify([{ number: 9, title: "实时标题", state: "OPEN" }]);
    const fixturePath = join(bin, "gh-fixture.mjs");
    writeFileSync(
      fixturePath,
      `process.stdout.write(${JSON.stringify(payload)});\n`,
      "utf8",
    );
    if (process.platform === "win32") {
      writeFileSync(
        join(bin, "gh.cmd"),
        `@"${process.execPath}" "${fixturePath}" %*\r\n`,
        "utf8",
      );
    } else {
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`,
        { mode: 0o755 },
      );
    }
    const out = runScript(dir, bin);
    assert.match(out, /\| #9 \| OPEN \| 实时标题 \|/);
    assert.match(out, /合计 1 个 issue/);
    assert.doesNotMatch(out, /示例未关闭/);
    assert.doesNotMatch(out, /未刷新|stale/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
