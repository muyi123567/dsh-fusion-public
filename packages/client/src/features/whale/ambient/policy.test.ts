import { describe, expect, it } from "vitest";
import { frameDelta, frameDelay, habitatPolicy, shouldSchedule } from "./policy.js";

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

describe("habitat scheduler budget", () => {
 it("starts and resumes with zero elapsed delta and caps delayed wakeups", () => {
  expect(frameDelta(90000, undefined)).toBe(0);
  expect(frameDelta(1040, 1000)).toBeCloseTo(.04);
  expect(frameDelta(90000, 1000)).toBe(.25);
  expect(frameDelta(900, 1000)).toBe(0);
 });
 it("subtracts render cost without exceeding the tier frame rate", () => {
  expect(frameDelay("balanced", 10)).toBeCloseTo(1000 / 24 - 10);
  expect(frameDelay("eco", 10)).toBeCloseTo(1000 / 15 - 10);
  expect(frameDelay("eco", 100)).toBe(0);
 });
});
