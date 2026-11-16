import { useEffect, useRef, useState } from "react";
import type { WhaleHabitatProps } from "./contracts.js";
import type { AmbientScene } from "../dive/scene.js";
import { habitatPolicy, shouldSchedule } from "./policy.js";
import "./habitat.css";

type Connection = EventTarget & { saveData?: boolean };
const assets = import.meta.env.BASE_URL + "whale-assets/";

export function WhaleHabitat(props: WhaleHabitatProps) {
 const host = useRef<HTMLDivElement>(null);
 const canvas = useRef<HTMLCanvasElement>(null);
 const latest = useRef(props);
 latest.current = props;
 const sceneRef = useRef<AmbientScene | undefined>(undefined);
 const resume = useRef<() => void>(() => {});
 const elapsed = useRef(0);
 const [ready, setReady] = useState(false);
 const [preferences, setPreferences] = useState({ reduced: true, saveData: false });
 useEffect(() => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  const update = () => setPreferences({ reduced: media.matches, saveData: !!connection?.saveData });
  update();
  media.addEventListener("change", update);
  connection?.addEventListener("change", update);
  return () => {
   media.removeEventListener("change", update);
   connection?.removeEventListener("change", update);
  };
 }, []);
 const policy = habitatPolicy(props.quality, preferences.reduced, preferences.saveData);
 useEffect(() => {
  if (policy.poster) {
   setReady(false);
   latest.current.onStateChange?.("still");
   return;
  }
  setReady(false);
  let disposed = false, failed = false, loading = false, loaded = false;
  let onscreen = typeof IntersectionObserver === "undefined";
  let visible = !document.hidden;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: number | undefined;
  let published = -Infinity;
  let frames = 0;
  let tier = policy.tier;
  let slowFrames = 0;
  let scene: AmbientScene | undefined;
  const stop = () => {
   if (timer !== undefined) clearTimeout(timer);
   timer = undefined;
   last = undefined;
  };
  const fail = () => {
   if (disposed || failed) return;
   failed = true;
   stop();
   scene?.dispose();
   scene = undefined;
   sceneRef.current = undefined;
   setReady(false);
   latest.current.onStateChange?.("error");
  };
  const active = () => !disposed && !failed && shouldSchedule(latest.current.playing, visible, onscreen);
  const tick = () => {
   timer = undefined;
   if (!active() || !loaded || !scene) return;
   const now = performance.now();
   if (last !== undefined) elapsed.current += Math.max(0, now - last) / 1000;
   last = now;
   try {
    const begin = performance.now();
    scene.render(elapsed.current);
    const cost = performance.now() - begin;
    if (tier === "balanced") {
     slowFrames = cost > 1000 / 24 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
     if (slowFrames >= 24) tier = "eco";
    }
    frames++;
    if (now - published >= 1000) {
     published = now;
     latest.current.onMetrics?.({ ...scene.metrics(), frames, elapsed: elapsed.current, tier });
    }
    if (active()) timer = setTimeout(tick, Math.max(0, 1000 / (tier === "eco" ? 15 : 24) - (performance.now() - now)));
   } catch { fail(); }
  };
  const sync = () => {
   stop();
   if (!active()) {
    if (!failed && !disposed) latest.current.onStateChange?.("paused");
    return;
   }
   if (loaded) {
    latest.current.onStateChange?.("running");
    timer = setTimeout(tick, 0);
   } else if (!loading) {
    loading = true;
    latest.current.onStateChange?.("loading");
    import("../dive/scene.js").then(({ createAmbientScene }) => {
     if (disposed || failed || !canvas.current) return;
     scene = createAmbientScene({
      canvas: canvas.current,
      assetUrl: assets + "humpback-whale-light.glb",
      activity: latest.current.activity,
      onReady: () => {
       // GLTF callbacks are asynchronous; scene assignment completes first.
       if (disposed || failed) return;
       loaded = true;
       setReady(true);
       sync();
      },
      onError: fail,
     });
     if (failed || disposed) { scene.dispose(); scene = undefined; return; }
     sceneRef.current = scene;
    }).catch(fail);
   }
  };
  resume.current = sync;
  const resize = new ResizeObserver(() => {
   try { scene?.resize(); } catch { fail(); }
  });
  if (host.current) resize.observe(host.current);
  const intersection = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
   onscreen = entries.some(entry => entry.isIntersecting);
   sync();
  });
  if (host.current) intersection?.observe(host.current);
  const visibility = () => { visible = !document.hidden; sync(); };
  document.addEventListener("visibilitychange", visibility);
  sync();
  return () => {
   disposed = true;
   stop();
   resume.current = () => {};
   resize.disconnect();
   intersection?.disconnect();
   document.removeEventListener("visibilitychange", visibility);
   scene?.dispose();
   sceneRef.current = undefined;
  };
 }, [policy.poster, policy.tier]);
 useEffect(() => { resume.current(); }, [props.playing]);
 useEffect(() => { sceneRef.current?.setActivity(props.activity); }, [props.activity]);
 return <div ref={host} className={["whale-habitat", props.className].filter(Boolean).join(" ")} data-ready={ready && !policy.poster ? "true" : "false"}>
  <img className="whale-habitat__poster" src={assets + "whale-dive-poster.jpg"} alt="鲸鱼潜入深海的静态画面" />
  <canvas ref={canvas} className="whale-habitat__canvas" role="img" aria-label="持续巡游的鲸鱼海域" />
 </div>;
}
