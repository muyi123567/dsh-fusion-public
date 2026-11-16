import { describe, expect, it } from "vitest";
import { habitatPolicy, shouldSchedule } from "./policy.js";

describe("habitat energy policy", () => {
 it("never enables 3D for still/static, reduced motion or saveData", () => {
  for (const quality of ["auto", "balanced", "eco", "still"] as const) {
   expect(habitatPolicy(quality, true, false).poster).toBe(true);
   expect(habitatPolicy(quality, false, true).poster).toBe(true);
  }
  expect(habitatPolicy("still", false, false).poster).toBe(true);
  expect(habitatPolicy("static", false, false).poster).toBe(true);
 });
 it("uses bounded frame budgets", () => {
  expect(habitatPolicy("auto", false, false).fps).toBe(24);
  expect(habitatPolicy("balanced", false, false).fps).toBe(24);
  expect(habitatPolicy("eco", false, false).fps).toBe(15);
 });
 it("suspends for every inactive lifecycle state", () => {
  for (const playing of [false, true]) for (const visible of [false, true])
   for (const onscreen of [false, true])
    expect(shouldSchedule(playing, visible, onscreen)).toBe(playing && visible && onscreen);
 });
});
