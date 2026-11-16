import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { WhaleHabitatProps } from "./contracts.js";
import type { AmbientScene } from "../dive/scene.js";
import { frameDelta, frameDelay, habitatPolicy, shouldSchedule } from "./policy.js";
import "./habitat.css";

type Connection = EventTarget & { saveData?: boolean };
import posterAsset from "./assets/poster.jpg?url";

export function WhaleHabitat(props: WhaleHabitatProps) {
 const host = useRef<HTMLDivElement>(null);
 const canvas = useRef<HTMLCanvasElement>(null);
 const latest = useRef(props);
 latest.current = props;
 const sceneRef = useRef<AmbientScene | undefined>(undefined);
 const resume = useRef<() => void>(() => {});
 const elapsed = useRef(0);
 const frames = useRef(0);
 const lastMetrics = useRef(-Infinity);
 const qualityUpdate = useRef<(tier: "balanced" | "eco") => void>(() => {});
 const publishState = (state: "loading" | "running" | "paused" | "still" | "error") => {
  if(host.current) host.current.dataset.habitatState = state;
  latest.current.onStateChange?.(state);
 };
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
   if(host.current) {
    host.current.dataset.habitatQuality = "still";
    host.current.dataset.habitatFrames = String(frames.current);
    host.current.dataset.habitatElapsed = String(elapsed.current);
   }
   publishState("still");
   return;
  }
  setReady(false);
  let disposed = false, failed = false, loading = false, loaded = false;
  let onscreen = typeof IntersectionObserver === "undefined";
  let visible = !document.hidden;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: number | undefined;

  let tier = policy.tier;
  let slowFrames = 0;
  let needsResize = true;
  let scene: AmbientScene | undefined;
  const stop = () => {
   if (timer !== undefined) clearTimeout(timer);
   timer = undefined;
   last = undefined;
   if(host.current){
    host.current.dataset.habitatFrames=String(frames.current);
    host.current.dataset.habitatElapsed=String(elapsed.current);
   }
  };
  const fail = () => {
   if (disposed || failed) return;
   failed = true;
   stop();
   scene?.dispose();
   scene = undefined;
   sceneRef.current = undefined;
   setReady(false);
   publishState("error");
  };
  const active = () => !disposed && !failed && shouldSchedule(latest.current.playing, visible, onscreen);
  const tick = () => {
   timer = undefined;
   if (!active() || !loaded || !scene) return;
   const now = performance.now();
   elapsed.current += frameDelta(now, last);
   last = now;
   try {
    const begin = performance.now();
    if (needsResize) { scene.resize(); needsResize = false; }
    scene.render(elapsed.current);
    const cost = performance.now() - begin;
    if (tier === "balanced") {
     slowFrames = cost > 1000 / 24 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
     if (slowFrames >= 24) { tier = "eco"; scene.setQuality(tier); }
    }
    frames.current++;
    if (now - lastMetrics.current >= 1000) {
     if(host.current){
      host.current.dataset.habitatFrames=String(frames.current);
      host.current.dataset.habitatElapsed=String(elapsed.current);
      host.current.dataset.habitatQuality=tier;
     }
     if(host.current) {
      const m=scene.getMetrics();
      host.current.dataset.habitatMetrics=JSON.stringify(m);
     }
     lastMetrics.current = now;
     latest.current.onMetrics?.({ ...scene.getMetrics(), frames: frames.current, elapsed: elapsed.current, tier });
    }
    if (active()) timer = setTimeout(tick, frameDelay(tier, performance.now() - now));
   } catch { fail(); }
  };
  const sync = () => {
   stop();
   if(host.current){
    host.current.dataset.habitatQuality=tier;
    host.current.dataset.habitatFrames=String(frames.current);
    host.current.dataset.habitatElapsed=String(elapsed.current);
   }
   if (!active()) {
    if (!failed && !disposed) publishState("paused");
    return;
   }
   if (loaded) {
    publishState("running");
    timer = setTimeout(tick, 0);
   } else if (!loading) {
    loading = true;
    publishState("loading");
    import("../dive/scene.js").then(({ createAmbientScene }) => {
     if (disposed || failed || !canvas.current) return;
     if (!active()) { loading = false; return; }
     scene = createAmbientScene({
      canvas: canvas.current,
      mode: "ambient",
      quality: tier,
      activity: latest.current.activity,
      pods: latest.current.pods ?? [],
      view: latest.current.view ?? "deep",
      ...(latest.current.selectedPodId===undefined?{}:{selectedPodId:latest.current.selectedPodId}),
      onReady: () => {
       // GLTF callbacks are asynchronous; scene assignment completes first.
       if (disposed || failed) return;
       queueMicrotask(() => {
        if(disposed || failed || !scene) return;
        scene.setPods(latest.current.pods ?? []);
        scene.setActivity(latest.current.activity);
        scene.setView(latest.current.view ?? "deep");
        scene.setSelected(latest.current.selectedPodId);
        loaded = true;
        setReady(true);
        sync();
       });
      },
      onError: fail,
     });
     if (failed || disposed) { scene.dispose(); scene = undefined; return; }
     sceneRef.current = scene;
    }).catch(fail);
   }
  };
  resume.current = sync;
  qualityUpdate.current = next => {
   tier=next; slowFrames=0; scene?.setQuality(next); sync();
  };
  const resize = new ResizeObserver(() => { needsResize = true; });
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
   qualityUpdate.current = () => {};
   resize.disconnect();
   intersection?.disconnect();
   document.removeEventListener("visibilitychange", visibility);
   scene?.dispose();
   sceneRef.current = undefined;
  };
 }, [policy.poster]);
 useEffect(() => { qualityUpdate.current(policy.tier); }, [policy.tier]);
 useEffect(() => { resume.current(); }, [props.playing]);
 useEffect(() => { sceneRef.current?.setActivity(props.activity); }, [props.activity]);
 useEffect(() => { sceneRef.current?.setPods(props.pods ?? []); }, [props.pods]);
 useEffect(() => { sceneRef.current?.setView(props.view ?? "deep"); }, [props.view]);
 useEffect(() => { sceneRef.current?.setSelected(props.selectedPodId); }, [props.selectedPodId]);
 const selectPod = (event: MouseEvent<HTMLCanvasElement>) => {
  const rect = event.currentTarget.getBoundingClientRect();
  if (!rect.width || !rect.height || policy.poster) return;
  const id = sceneRef.current?.hitTest(
   (event.clientX - rect.left) / rect.width * 2 - 1,
   1 - (event.clientY - rect.top) / rect.height * 2,
  );
  if (id) latest.current.onSelectPod?.(id);
 };
 return <div ref={host} className={["whale-habitat", props.className].filter(Boolean).join(" ")} data-ready={ready && !policy.poster ? "true" : "false"}>
  <img className="whale-habitat__poster" src={posterAsset} alt="鲸鱼潜入深海的静态画面" />
  <canvas onClick={selectPod} key={policy.poster?"poster":"dynamic"} ref={canvas} className="whale-habitat__canvas" role="img" aria-label="持续巡游的鲸鱼海域" />
 </div>;
}
