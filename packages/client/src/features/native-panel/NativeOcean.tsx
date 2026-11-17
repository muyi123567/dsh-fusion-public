import { lazy, Suspense, useMemo, useRef, useState } from "react";
import type { WhalePanelModel } from "../whale/types.js";
import type { HabitatPod, HabitatQuality, HabitatView } from "../whale/ambient/contracts.js";
import { projectOceanLife } from "../whale/ambient/life-director.js";
import styles from "./native-ocean.module.css";

const Habitat = lazy(() => import("../whale/ambient/WhaleHabitat.js").then(m => ({ default: m.WhaleHabitat })));

export function NativeOcean({ model, visible, onSelectTeam }: {
 model: WhalePanelModel; visible: boolean; onSelectTeam: (id: string) => void;
}) {
 const [view, setView] = useState<HabitatView>("deep");
 const [quality, setQuality] = useState<HabitatQuality>("auto");
 const [playing, setPlaying] = useState(true);
 const [page, setPage] = useState(0);
 const [selected, setSelected] = useState("");
 const [state, setState] = useState("loading");
 // Retain the same pure diff across StrictMode render replays.
 const cache = useRef<{ model: WhalePanelModel; life: ReturnType<typeof projectOceanLife> } | null>(null);
 if (cache.current?.model !== model) {
  cache.current = { model, life: projectOceanLife(model, cache.current?.model) };
 }
 const life = cache.current.life;
 const observed = model.freshness === "current";
 const lastPage = Math.max(0, Math.ceil(model.pods.length / 3) - 1);
 const currentPage = Math.min(page, lastPage);
 const pods: HabitatPod[] = useMemo(() => model.pods.slice(currentPage * 3, currentPage * 3 + 3).map(p => ({
  id: p.id, name: p.name, active: p.active, blocked: p.blocked, completed: p.completed, observed,
 })), [model.pods, currentPage, observed]);
 const activity = useMemo(() => ({ active: model.summary.active, blocked: model.krill.filter(t => t.blocked || t.status === "failed").length, completed: model.summary.completed, observed }), [model.summary.active, model.summary.completed, model.krill, observed]);
 const select = (id: string) => {
  if (model.demo || !hasSource || !model.pods.some(p => p.id === id)) return;
  setSelected(id);
  onSelectTeam(id);
 };
 const hasSource = model.freshness !== "unobserved";
 return <section className={styles.ocean} aria-label="团队海域">
  <div className={styles.toolbar} role="group" aria-label="海域控制">
   <button type="button" aria-pressed={view === "deep"} onClick={() => setView("deep")}>深海</button>
   <button type="button" aria-pressed={view === "surface"} onClick={() => setView("surface")}>海面</button>
   <button type="button" aria-pressed={!playing} onClick={() => setPlaying(p => !p)}>{playing ? "暂停" : "继续"}</button>
   <select aria-label="海域质量" value={quality} onChange={e => setQuality(e.target.value as HabitatQuality)}>
    <option value="auto">自动质量</option><option value="balanced">平衡</option><option value="eco">节能</option><option value="still">静态</option>
   </select>
  </div>
  {model.demo && <p className={styles.note} role="note">合成演示 · 不是真实团队，不能打开真实团队详情。</p>}
  <div className={styles.viewport}>
   {visible && hasSource && pods.length > 0 ? <Suspense fallback={<p className={styles.message}>海域加载中</p>}>
    <Habitat className={styles.habitat ?? ""} life={life} pods={pods} view={view}
     selectedPodId={pods.some(p => p.id === selected) ? selected : ""}
     onSelectPod={select} quality={quality} playing={visible && playing}
     activity={activity}
     onStateChange={setState}/>
   </Suspense> : <p className={styles.message}>{!visible ? "海域已停止" : !hasSource ? "尚未观测到来源" : "当前没有团队记录"}</p>}
  </div>
  <div className={styles.teams} aria-label="海域团队选择">
   <button type="button" aria-label="上一组团队" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button>
   {pods.map(p => <button type="button" key={p.id} aria-pressed={selected === p.id} disabled={model.demo || !hasSource} aria-label={"查看团队详情：" + p.name} onClick={() => select(p.id)}>{p.name}</button>)}
   <button type="button" aria-label="下一组团队" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>›</button>
  </div>
  <p className={styles.note} role="status">{model.freshness === "stale" ? "来源陈旧 · " : ""}{!visible ? "海域已停止。" : !hasSource ? "尚未观测到来源，无法判断任务状态。" : !pods.length ? "当前没有团队记录，不代表任务完成。" : state === "error" ? "海域加载失败，请在任务或主机页查看记录。" : "自然巡游与呼吸不代表任务完成。"}</p>
  <details className={styles.legend}><summary>海域图例与主机连接</summary>
   <p>鲸：团队；海豚：子代理；磷虾：任务；海鸥：定时任务。仅显示来源中的记录。</p>
   <p>航标：SSH 主机可达性，不代表终端连接或任务成功。</p>
   {life.hosts.filter(h => h.ssh).map(h => <p key={h.id}>{h.name} · {observed ? h.status : "未确认当前状态"}</p>)}
   {!life.hosts.some(h => h.ssh) && <p>尚无 SSH 主机记录。</p>}
  </details>
 </section>;
}
