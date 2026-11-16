/** Shared boundary for the single-canvas, continuously swimming panel. */
export type HabitatQuality = "auto" | "balanced" | "eco" | "still";
export type HabitatTier = "balanced" | "eco";
export interface HabitatActivity {
 active: number;
 blocked: number;
 completed: number;
 observed: boolean;
}
export interface HabitatMetrics {
 frames: number;
 calls: number;
 triangles: number;
 geometries: number;
 textures: number;
 programs: number;
 elapsed: number;
 tier: HabitatTier;
}
export interface WhaleHabitatProps {
 activity: HabitatActivity;
 quality: HabitatQuality;
 playing: boolean;
 className?: string;
 onStateChange?: (state: "loading" | "running" | "paused" | "still" | "error") => void;
 onMetrics?: (metrics: HabitatMetrics) => void;
}
export interface AmbientMotion {
 position: [number, number, number];
 rotation: [number, number, number];
 cameraPosition: [number, number, number];
 cameraTarget: [number, number, number];
 swimTime: number;
}
