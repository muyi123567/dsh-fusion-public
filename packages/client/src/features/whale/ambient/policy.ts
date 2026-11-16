import type { HabitatQuality, HabitatTier } from "./contracts.js";

export function habitatPolicy(quality: HabitatQuality | "static", reducedMotion: boolean, saveData: boolean) {
 const poster = quality === "still" || quality === "static" || reducedMotion || saveData;
 const tier: HabitatTier = quality === "eco" ? "eco" : "balanced";
 return { poster, tier, fps: tier === "eco" ? 15 : 24 };
}
export function shouldSchedule(playing: boolean, visible: boolean, onscreen: boolean) {
 return playing && visible && onscreen;
}
