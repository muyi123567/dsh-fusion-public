import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Refreshes the machine-readable part of docs/project/status.md.
 *
 * The narrative in that file is written by hand; the facts in the generated
 * block are computed here so they cannot go stale. Run it after any change
 * to the repository shape:
 *
 *   node scripts/project-status.mjs
 *   node scripts/project-status.mjs --with-tests
 *
 * The `--with-tests` flag runs the full suite and records the real totals.
 * Without it the previous verified count is left untouched, because a
 * document that claims a test count nobody ran is worse than one that
 * keeps the last known number and says when it was taken.
 */

const root = resolve(import.meta.dirname, "..");
const statusPath = resolve(root, "docs/project/status.md");
const BEGIN = "<!-- BEGIN:generated-status -->";
const END = "<!-- END:generated-status -->";

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function countLines(files) {
  let total = 0;
  for (const file of files) {
    try {
      total += readFileSync(file, "utf8").split("\n").length;
    } catch {
      // A file that vanished between listing and reading is not worth failing over.
    }
  }
  return total;
}

function sourceFiles(pkg) {
  const dir = resolve(root, "packages", pkg, "src");
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const STALE_ISSUE_NOTE =
  "> ⚠ Issue 状态本轮未刷新（`gh` 不可用或未认证），以下为最近一次已知状态，可能已过期。";

/**
 * Fail-safe: a failed `gh` read must never erase known issue state.
 * When the live read fails (CLI missing, unauthenticated, malformed or
 * empty output), the previously recorded table is kept verbatim and
 * marked stale with STALE_ISSUE_NOTE. Only a successful live read
 * replaces it. Regression test: tests/project-status.test.mjs.
 */
function extractIssueSection(content) {
  const heading = "### Issue 状态";
  const start = content.indexOf(heading);
  if (start === -1) return [];
  const rest = content.slice(start + heading.length);
  let end = rest.length;
  const nextHeading = rest.indexOf("\n### ");
  if (nextHeading !== -1) end = Math.min(end, nextHeading);
  const endMarker = rest.indexOf(END);
  if (endMarker !== -1) end = Math.min(end, endMarker);
  const lines = rest
    .slice(0, end)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== STALE_ISSUE_NOTE);
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readIssuesRaw() {
  const args = ["issue", "list", "--repo", "muyi123567/dsh-fusion-public", "--state", "all",
    "--limit", "50", "--json", "number,title,state"];
  try {
    // On Windows `gh` may resolve to a .cmd shim, which Node refuses to
    // spawn directly since the CVE-2024-27980 fix — the same constraint
    // testTotal() documents for pnpm. A single command string always goes
    // through a shell, so it works for gh.exe, gh.cmd and test fixtures
    // alike. Every argument here is a constant, never user input.
    if (process.platform === "win32") {
      return execSync(`gh ${args.join(" ")}`, {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
    return execFileSync("gh", args, {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function issueTable(existingLines = []) {
  const raw = readIssuesRaw();
  let issues = null;
  if (raw !== "") {
    try {
      const parsed = JSON.parse(raw);
      // An empty or non-array result cannot be trusted either: with the
      // wrong account or repo it would silently wipe the known table.
      if (Array.isArray(parsed) && parsed.length > 0) issues = parsed;
    } catch {
      issues = null;
    }
  }
  if (issues === null) {
    const hasTable = existingLines.some((line) => line.startsWith("| #"));
    if (!hasTable) {
      return ["_Issue state unavailable: the `gh` CLI is not installed or not authenticated._", ""];
    }
    return [STALE_ISSUE_NOTE, "", ...existingLines];
  }
  issues = issues.sort((a, b) => a.number - b.number);
  const open = issues.filter((issue) => issue.state === "OPEN");
  const lines = [
    "| # | 状态 | 标题 |",
    "| --- | --- | --- |",
    ...issues.map((issue) => `| #${issue.number} | ${issue.state === "OPEN" ? "OPEN" : "CLOSED"} | ${issue.title} |`),
    "",
    `合计 ${issues.length} 个 issue：${issues.length - open.length} 已关闭，${open.length} 未关闭。`,
  ];
  return lines;
}

function testTotal() {
  // On Windows `pnpm` is a .cmd shim, which Node refuses to spawn directly
  // since the CVE-2024-27980 fix. execSync takes a single command string and
  // always goes through a shell, so it avoids both the spawn error and the
  // shell-with-arguments deprecation warning.
  const output = process.platform === "win32"
    ? execSync("pnpm test", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    : execFileSync("pnpm", ["test"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let total = 0;
  for (const match of output.matchAll(/Tests\s+(\d+)\s+passed/g)) {
    total += Number(match[1]);
  }
  return total;
}

const head = git(["rev-parse", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const remoteHead = git(["ls-remote", "origin", `refs/heads/${branch}`]).split("\t")[0] ?? "";
const inSync = remoteHead !== "" && remoteHead === head;
const commitCount = git(["rev-list", "--count", "HEAD"]);
// `--reverse` combined with `-1` would still yield the newest commit, so the
// whole log is walked and the first line is taken.
const firstCommit = git(["log", "--reverse", "--date=format:%Y-%m-%d", "--pretty=format:%ad"])
  .split("\n")[0] ?? "";
const lastCommit = git(["log", "-1", "--date=format:%Y-%m-%d", "--pretty=format:%ad"]);

const recent = git(["log", "-15", "--date=format:%m-%d %H:%M", "--pretty=format:%h|%ad|%s"])
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const [sha, date, ...rest] = line.split("|");
    return `| \`${sha}\` | ${date} | ${rest.join("|")} |`;
  });

const packages = ["core", "config", "host", "client", "plugin"];
const loc = packages.map((pkg) => `| \`packages/${pkg}\` | ${countLines(sourceFiles(pkg))} |`);

if (!existsSync(statusPath)) {
  console.error(`missing ${statusPath}`);
  process.exit(1);
}

const current = readFileSync(statusPath, "utf8");
const blockStart = current.indexOf(BEGIN);
const blockEnd = current.indexOf(END);
if (blockStart === -1 || blockEnd === -1) {
  console.error(`status.md is missing the ${BEGIN} / ${END} markers`);
  process.exit(1);
}
const existingIssueLines = extractIssueSection(current);

const lines = [
  BEGIN,
  "",
  "<!-- 本区块由 `node scripts/project-status.mjs` 生成，请勿手工编辑。 -->",
  "",
  "> 快照说明：本区块生成于下表「区块生成时间」那一刻，因此其中的 HEAD 比仓库当前",
  "> 提交落后一个——生成动作本身发生在提交之前。每轮收口重新生成即可。",
  "",
  "### 远端同步",
  "",
  "| 项 | 值 |",
  "| --- | --- |",
  `| 分支 | \`${branch}\` |`,
  `| 生成时本地 HEAD | \`${head}\` |`,
  `| 生成时远端 HEAD | \`${remoteHead || "读取失败"}\` |`,
  `| 生成时是否一致 | ${inSync ? "**是**" : "**否**"} |`,
  `| 区块生成时间 | ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC |`,
  `| 提交总数 | ${commitCount} |`,
  `| 首次提交 | ${firstCommit} |`,
  `| 最近提交 | ${lastCommit} |`,
  "",
  "### 各包源码行数",
  "",
  "| 包 | 行数 |",
  "| --- | --- |",
  ...loc,
  "",
  "### Issue 状态",
  "",
  ...issueTable(existingIssueLines),
  "",
  "### 最近提交",
  "",
  "| 提交 | 时间 | 说明 |",
  "| --- | --- | --- |",
  ...recent,
  "",
  END,
];

const next = `${current.slice(0, blockStart)}${lines.join("\n")}${current.slice(blockEnd + END.length)}`;
writeFileSync(statusPath, next, "utf8");
console.log(`updated ${statusPath}`);

if (process.argv.includes("--with-tests")) {
  const total = testTotal();
  console.log(`full suite: ${total} tests passed`);
}
