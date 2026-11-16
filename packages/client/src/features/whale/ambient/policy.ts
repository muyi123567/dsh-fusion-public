import type { HabitatQuality, HabitatTier } from "./contracts.js";

export function habitatPolicy(quality: HabitatQuality | "static", reducedMotion: boolean, saveData: boolean) {
 // Accessibility and saveData always win, including explicit balanced/eco.
 const poster = quality === "still" || quality === "static" || reducedMotion || saveData;
 const tier: HabitatTier = quality === "eco" ? "eco" : "balanced";
 return { poster, tier, fps: tier === "eco" ? 15 : 24 };
}
export function shouldSchedule(playing: boolean, visible: boolean, onscreen: boolean) {
 return playing && visible && onscreen;
}

/** Slow/background timer wakeups never replay a backlog of animation time. */
export function frameDelta(now: number, previous: number | undefined): number {
 return previous === undefined ? 0 : Math.min(0.25, Math.max(0, now - previous) / 1000);
}
export function frameDelay(tier: HabitatTier, workMs: number): number {
 return Math.max(0, 1000 / (tier === "eco" ? 15 : 24) - Math.max(0, workMs));
}
