import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The right drawer is display:none at <=1120px and becomes a
// fixed overlay when open. The overlay presentation must
// live in the same breakpoint range that hides the drawer:
// when it only existed at <=760px, the details toggle at
// 761-1120px flipped state with no visible effect at all.
describe("drawer breakpoints", () => {
  // The suite runs from the package directory (pnpm --filter
  // or pnpm -r); the repo-root candidate covers direct runs.
  const candidates = [
    join(process.cwd(), "src/styles/app.css"),
    join(process.cwd(), "packages/client/src/styles/app.css"),
  ];
  const cssPath = candidates.find((candidate) => existsSync(candidate));
  const css = cssPath === undefined ? "" : readFileSync(cssPath, "utf8");

  it("presents the open drawer as an overlay across the whole hidden range", () => {
    expect(cssPath).toBeDefined();
    const segments = css.split("@media (max-width: 1120px)");
    expect(segments.length).toBeGreaterThan(1);
    const inRange = segments.slice(1).join("@media (max-width: 1120px)");
    expect(inRange).toContain(".fusion-drawer.is-mobile-open");
    expect(inRange).toContain("position: fixed");
  });

  it("keeps the details toggle and drawer close button out of the always-visible desktop layout", () => {
    // Above 1120px the drawer is permanently visible, so a
    // toggle reporting aria-expanded=false (or a close button
    // that cannot close anything) would contradict the
    // layout. Both controls exist only in the range where
    // the drawer can actually open and close.
    const beforeFirstMedia = css.split("@media")[0] ?? "";
    expect(beforeFirstMedia).toMatch(/\.fusion-details-toggle[^{}]*\{[^}]*display:\s*none/);
    expect(beforeFirstMedia).toMatch(/\.fusion-drawer-close[^{}]*\{[^}]*display:\s*none/);
    const segments = css.split("@media (max-width: 1120px)");
    const inRange = segments.slice(1).join("@media (max-width: 1120px)");
    expect(inRange).toMatch(/\.fusion-details-toggle\s*\{[^}]*display:/);
    expect(inRange).toMatch(/\.fusion-drawer-close\s*\{[^}]*display:/);
  });
});
