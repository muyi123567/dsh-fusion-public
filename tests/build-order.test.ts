import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression pin for the clean-checkout gate failure at
// 7697b91: the root test entry built @dsh-fusion/host
// without first building @dsh-fusion/core / @dsh-fusion/config,
// whose dist type declarations the host compiles against.
// With no (or stale) core/config dists, `pnpm test` failed
// before running a single test — and running typecheck
// first masked it, because only the typecheck script had
// the full dependency order. Every gated entry point must
// build in dependency order: core -> config -> host ->
// plugin.
const rootPackage = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
) as { scripts: Record<string, string> };

const BUILD_STEPS = [
  "pnpm --filter @dsh-fusion/core build",
  "pnpm --filter @dsh-fusion/config build",
  "pnpm --filter @dsh-fusion/host build",
  "pnpm --filter dsh-fusion build",
] as const;

function expectDependencyOrder(scriptName: string): void {
  const script = rootPackage.scripts[scriptName];
  expect(script, `root script ${scriptName} exists`).toBeDefined();
  const positions = BUILD_STEPS.map((step) => {
    const position = script!.indexOf(step);
    expect(position, `${scriptName} builds ${step}`).toBeGreaterThanOrEqual(0);
    return position;
  });
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("root gate build order", () => {
  it("builds core and config before host in pnpm test", () => {
    expectDependencyOrder("test");
  });

  it("builds core and config before host in pnpm test:e2e", () => {
    expectDependencyOrder("test:e2e");
  });

  it("keeps the dependency order in pnpm typecheck", () => {
    const script = rootPackage.scripts.typecheck!;
    const positions = BUILD_STEPS.slice(0, 3).map((step) => script.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
