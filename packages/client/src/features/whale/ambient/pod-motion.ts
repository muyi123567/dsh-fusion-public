import type { HabitatActivity, HabitatView } from "./contracts.js";

export interface PodMotion {
 position: [number, number, number];
 rotation: [number, number, number];
 scale: number;
 swimTime: number;
 spout: number;
}

const smooth = (x: number) => {
 const u = Math.max(0, Math.min(1, x));
 return u * u * u * (10 + u * (-15 + 6 * u));
};
const finite = (x: number, fallback: number) => Number.isFinite(x) ? x : fallback;

/**
 * Centered 14-unit mesh, head +Z. Life motion is independent of task counts:
 * no activity snapshot (including stale snapshots) can reset or jump its clock.
 * Surface altitude assumes a dorsal/blowhole offset about 0.8 mesh units.
 * Caller advances seconds only while visible and playing.
 */
export function samplePodMotion(
 seconds: number, index: number, count: number, view: HabitatView,
 _activity: HabitatActivity, aspect: number,
): PodMotion {
 const t = Math.max(0, finite(seconds, 0));
 const n = Math.max(1, Math.min(3, Math.trunc(finite(count, 1))));
 const i = Math.max(0, Math.min(n - 1, Math.trunc(finite(index, 0))));
 const lane = i - (n - 1) / 2;
 const a = Math.max(0.1, finite(aspect, 1));
 const portrait = 1 - smooth((a - 0.45) / 0.65);
 const phase = t * 0.19 + i * 2.1;
 const scale = [0.85, 0.72, 0.6][i]!;
 const surface = view === "surface";
 // A common 36s cycle with 12s offsets guarantees non-overlapping breaths.
 // Only the cycle phase wraps; all envelopes have matching flat endpoints.
 const cycle = ((t % 36) + i * 12) % 36;
 const rise = smooth(cycle / 7);
 const fall = smooth((cycle - 10) / 8);
 const exposure = rise * (1 - fall);
 const surfaceY = 5.4 - 0.8 * scale + 0.10;
 const deepY = -2.4 + lane * 0.85;
 const y = surface ? deepY + (surfaceY - deepY) * exposure
  : -1.8 + lane * (0.8 + portrait * 1.5) + Math.sin(phase) * 0.18;
 // Breath only on the flat surfaced interval, a short smooth mist pulse.
 const spout = surface
  ? smooth((cycle - 7.5) / 0.25) * (1 - smooth((cycle - 8) / 0.7))
  : 0;
 return {
  position: [
   lane * (3.6 - portrait * 2.4) + Math.sin(phase * 0.71) * 0.32,
   y,
   -lane * 3.2 + Math.sin(phase * 0.53) * 0.24,
  ],
  rotation: [
   0.2 + Math.sin(phase) * 0.025 + (surface ? (rise - exposure) * 0.06 : 0),
   -0.85 + Math.sin(phase * 0.61) * 0.045,
   -0.06 + Math.sin(phase * 0.83) * 0.02,
  ],
  scale,
  swimTime: t * 0.85 + i * 1.8,
  spout,
 };
}
