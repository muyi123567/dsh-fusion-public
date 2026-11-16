import type { AmbientMotion, HabitatActivity } from "./contracts";

const smooth = (x: number): number => x * x * x * (10 + x * (-15 + 6 * x));
const count = (x: number): number => Number.isFinite(x) ? Math.max(0, x) : 0;

/**
 * Stateless world-space motion for the centered, roughly 14-unit whale mesh.
 * One six-second descent, then bounded oscillations; no looping dive clock.
 * Caller owns snapshot freshness: stale data must have observed=false.
 */
export function sampleAmbientMotion(
 seconds: number, activity: HabitatActivity, aspect: number,
): AmbientMotion {
 const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
 const descend = smooth(Math.min(1, t / 6));
 // Bounded phase modulation avoids a phase jump proportional to elapsed time
 // when a new activity snapshot arrives. Unobserved counts carry no signal.
 const signal = activity?.observed === true
  ? Math.min(1, count(activity.active) / 8) : 0;
 const phase = t * 0.24 + signal * 0.06 * Math.sin(t * 0.09);
 const drift = descend;
 const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
 // Continuous framing across portrait/landscape. Fit horizontal extent at 42deg
 // (also conservative if the renderer chooses a wider portrait field of view).
 const distance = 28 * Math.max(1, 1 / Math.max(0.1, safeAspect));
 return {
  position: [
   0.55 * Math.sin(phase * 0.71) * drift,
   1.5 - 3 * descend + 0.16 * Math.sin(phase) * drift,
   0.3 * Math.sin(phase * 0.53) * drift,
  ],
  rotation: [
   0.32 - 0.12 * descend + 0.025 * Math.sin(phase) * drift,
   -0.85 + 0.065 * Math.sin(phase * 0.61) * drift,
   -0.06 + 0.025 * Math.sin(phase * 0.83) * drift,
  ],
  cameraPosition: [distance * 0.45, 1, distance],
  cameraTarget: [0, -0.5, 0],
  // Monotonic animation clock, independent of snapshot updates. Multiplying
  // finite near-MAX_VALUE input by a factor <=1 also avoids overflow.
  swimTime: t * 0.85,
 };
}
