import { describe, expect, it } from "vitest";
import { samplePodMotion } from "./pod-motion.js";
import type { HabitatActivity, HabitatView } from "./contracts.js";

const idle: HabitatActivity = { active: 0, blocked: 0, completed: 0, observed: false };
const sample = (t: number, i = 0, view: HabitatView = "surface", aspect = 0.4) =>
 samplePodMotion(t, i, 3, view, idle, aspect);
const values = (m: ReturnType<typeof sample>) =>
 [...m.position, ...m.rotation, m.scale, m.swimTime, m.spout];

describe("pod life motion", () => {
 it("stays bounded for an hour in both views and portrait/landscape", () => {
  for (const view of ["deep", "surface"] as const) for (const aspect of [0.4, 1.8]) {
   for (let t = 0; t <= 3600; t += 0.5) for (let i = 0; i < 3; i++) {
    const m = sample(t, i, view, aspect);
    expect(values(m).every(Number.isFinite)).toBe(true);
    expect(Math.abs(m.position[0])).toBeLessThan(4);
    expect(Math.abs(m.position[2])).toBeLessThan(3.5);
    expect(m.position[1]).toBeGreaterThan(-5.2);
    expect(m.position[1]).toBeLessThan(5.1);
    expect(Math.abs(m.rotation[1] + 0.85)).toBeLessThan(0.046);
    expect(m.scale).toBeGreaterThanOrEqual(0.6);
    expect(m.scale).toBeLessThanOrEqual(0.85);
   }
  }
 });
 it("breathes briefly only near the surface and never in synchrony", () => {
  const breaths = [0, 0, 0];
  for (let t = 0; t < 72; t += 0.05) {
   let simultaneous = 0;
   for (let i = 0; i < 3; i++) {
    const m = sample(t, i);
    expect(m.spout).toBeGreaterThanOrEqual(0);
    expect(m.spout).toBeLessThanOrEqual(1);
    if (m.spout > 0) {
     simultaneous++; breaths[i]!++;
     expect(m.position[1] + 0.8 * m.scale).toBeCloseTo(5.5, 6);
    }
    expect(sample(t, i, "deep").spout).toBe(0);
   }
   expect(simultaneous).toBeLessThanOrEqual(1);
  }
  for (const steps of breaths) {
   expect(steps).toBeGreaterThan(0);
   expect(steps * 0.05).toBeLessThan(3);
  }
 });
 it("keeps cycle joins and rise/fall boundaries continuous", () => {
  for (let i = 0; i < 3; i++) for (const t of [0, 7, 7.5, 7.75, 8, 8.7, 10, 18, 24, 36, 72]) {
   for (const view of ["deep", "surface"] as const) {
    const left = values(sample(Math.max(0, t - 1e-5), i, view));
    const right = values(sample(t + 1e-5, i, view));
    left.forEach((v, k) => expect(Math.abs(v - right[k]!)).toBeLessThan(0.001));
   }
  }
 });
 it("preserves independent phases and ignores activity clock changes", () => {
  expect(sample(20, 0).swimTime).not.toBe(sample(20, 1).swimTime);
  for (const observed of [false, true]) {
   expect(samplePodMotion(3600, 1, 3, "deep",
    { active: 99, blocked: 4, completed: 1000, observed }, 0.4))
    .toEqual(sample(3600, 1, "deep"));
  }
  expect(sample(50, 1, "surface").swimTime).toBe(sample(50, 1, "deep").swimTime);
 });
 it("handles nonfinite time, index, count and aspect safely", () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1, Number.MAX_VALUE]) {
   const m = samplePodMotion(invalid, invalid, invalid, "surface", idle, invalid);
   expect(values(m).every(Number.isFinite)).toBe(true);
  }
 });
});
