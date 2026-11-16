import { describe, expect, it } from "vitest";
import { sampleAmbientMotion } from "./motion";
import type { AmbientMotion, HabitatActivity } from "./contracts";

const idle: HabitatActivity = { active: 0, blocked: 0, completed: 0, observed: false };
const values = (m: AmbientMotion) => [
 ...m.position, ...m.rotation, ...m.cameraPosition, ...m.cameraTarget, m.swimTime,
];

describe("sampleAmbientMotion", () => {
 it("stays bounded through one hour without a looping descent or full turn", () => {
  for (const aspect of [0.4, 0.75, 1, 2.4]) {
   let previousClock = -1;
   for (let t = 0; t <= 3600; t += 0.25) {
    const m = sampleAmbientMotion(t, idle, aspect);
    expect(values(m).every(Number.isFinite)).toBe(true);
    expect(Math.abs(m.position[0])).toBeLessThanOrEqual(0.55);
    expect(Math.abs(m.position[2])).toBeLessThanOrEqual(0.3);
    expect(m.position[1]).toBeGreaterThanOrEqual(-1.66);
    expect(m.position[1]).toBeLessThanOrEqual(1.66);
    expect(Math.abs(m.rotation[1] + 0.85)).toBeLessThanOrEqual(0.065000001);
    expect(m.swimTime).toBeGreaterThan(previousClock);
    previousClock = m.swimTime;
    if (t >= 6) expect(m.position[1]).toBeLessThan(-1.3);
   }
  }
 });
 it("is continuous at descent and former 36-second boundaries", () => {
  for (const t of [0, 3, 6, 36, 72, 3600]) {
   const a = values(sampleAmbientMotion(Math.max(0, t - 1e-5), idle, 0.5));
   const b = values(sampleAmbientMotion(t + 1e-5, idle, 0.5));
   a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(0.0001));
  }
  const h = 0.001;
  for (const t of [0, 6]) {
   const y = (s: number) => sampleAmbientMotion(s, idle, 1).position[1];
   expect(Math.abs((y(t + h) - y(t)) / h - (y(t) - y(t - h)) / h)).toBeLessThan(0.001);
  }
 });
 it("ignores unobserved counts and limits observed activity to a subtle change", () => {
  const busy = { ...idle, active: 100000, observed: true };
  for (const t of [6, 36, 3600]) {
   const base = sampleAmbientMotion(t, idle, 1);
   expect(sampleAmbientMotion(t, { ...busy, observed: false }, 1)).toEqual(base);
   values(base).forEach((v, i) =>
    expect(Math.abs(v - values(sampleAmbientMotion(t, busy, 1))[i]!)).toBeLessThan(0.04));
  }
 });
 it("sanitizes illegal inputs and remains deterministic", () => {
  for (const t of [NaN, Infinity, -Infinity, -10, Number.MAX_VALUE]) {
   for (const aspect of [NaN, Infinity, -Infinity, 0, -1, Number.MIN_VALUE]) {
    const activity = { active: NaN, blocked: Infinity, completed: -1, observed: true };
    const m = sampleAmbientMotion(t, activity, aspect);
    expect(values(m).every(Number.isFinite)).toBe(true);
    expect(sampleAmbientMotion(t, activity, aspect)).toEqual(m);
   }
  }
  expect(sampleAmbientMotion(NaN, idle, 1)).toEqual(sampleAmbientMotion(0, idle, 1));
 });
 it("widens portrait framing continuously without moving the target", () => {
  const wide = sampleAmbientMotion(20, idle, 1);
  const phone = sampleAmbientMotion(20, idle, 0.4);
  expect(phone.cameraPosition[2]).toBeGreaterThan(wide.cameraPosition[2]);
  expect(phone.cameraTarget).toEqual(wide.cameraTarget);
  expect(Math.abs(sampleAmbientMotion(20, idle, 1 - 1e-6).cameraPosition[2] -
   sampleAmbientMotion(20, idle, 1 + 1e-6).cameraPosition[2])).toBeLessThan(0.001);
 });
});
