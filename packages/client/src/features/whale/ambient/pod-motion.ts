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
 * `out` lets the render loop reuse one buffer per pod instead of allocating
 * fresh tuples every frame; `viewMix` (0 = deep, 1 = surface) lets the scene
 * ease between views instead of hard-cutting.
 */
export function samplePodMotion(
 seconds: number, index: number, count: number, view: HabitatView,
 _activity: HabitatActivity, aspect: number,
 out?: PodMotion, viewMix?: number,
): PodMotion {
 const t = Math.max(0, finite(seconds, 0));
 const n = Math.max(1, Math.min(3, Math.trunc(finite(count, 1))));
 const i = Math.max(0, Math.min(n - 1, Math.trunc(finite(index, 0))));
 const lane = i - (n - 1) / 2;
 const a = Math.max(0.1, finite(aspect, 1));
 const portrait = 1 - smooth((a - 0.45) / 0.65);
 const phase = t * 0.19 + i * 2.1;
 const scale = [0.85, 0.72, 0.6][i]!;
 const mix = typeof viewMix === "number" && Number.isFinite(viewMix) ? Math.max(0, Math.min(1, viewMix))
  : view === "surface" ? 1 : 0;
 // A common 36s cycle with 12s offsets guarantees non-overlapping breaths.
 // Only the cycle phase wraps; all envelopes have matching flat endpoints.
 const cycle = ((t % 36) + i * 12) % 36;
 const rise = smooth(cycle / 7);
 const fall = smooth((cycle - 10) / 8);
 const exposure = rise * (1 - fall);
 const surfaceY = 5.4 - 0.8 * scale + 0.10;
 const deepY = -2.4 + lane * 0.85;
 const cruising = -1.8 + lane * (2.6 + portrait * 0.5) + Math.sin(phase) * 0.18;
 const surfaced = deepY + (surfaceY - deepY) * exposure;
 // A slower, shallower swell keeps the deep cruise from feeling frozen.
 const bob = Math.sin(t * 0.9 + i * 2.3) * 0.07 * (1 - mix);
 const y = cruising + (surfaced - cruising) * mix + bob;
 // Breath only on the flat surfaced interval, a short smooth mist pulse.
 const spout = mix * smooth((cycle - 7.5) / 0.25) * (1 - smooth((cycle - 8) / 0.7));
 // Bank into the lateral turn: the derivative of the x lane, kept subtle.
 const bank = -Math.cos(phase * 0.71) * 0.018;
 const motion = out ?? {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: 0, swimTime: 0, spout: 0,
 };
 motion.position[0] = lane * (3.6 - portrait * 2.4) + Math.sin(phase * 0.71) * 0.32;
 motion.position[1] = y;
 motion.position[2] = -lane * 3.2 + Math.sin(phase * 0.53) * 0.24;
 motion.rotation[0] = 0.2 + Math.sin(phase) * 0.025 + (rise - fall) * 0.06 * mix;
 motion.rotation[1] = -0.85 + Math.sin(phase * 0.61) * 0.045;
 motion.rotation[2] = -0.06 + Math.sin(phase * 0.83) * 0.02 + bank;
 motion.scale = scale;
 motion.swimTime = t * 0.85 + i * 1.8;
 motion.spout = spout;
 return motion;
}
