import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NativePanelDetails } from "./NativePanelDetails.js";
import { useNativeData } from "./use-native-data.js";
import type { NativePanelSelection, NativeWhalePanelProps } from "./types.js";
import styles from "./native-panel.module.css";

import { NativeOceanBoundary } from "./NativeOceanBoundary.js";
const labels: Record<string,string> = {blocked:"受阻",queued:"排队",claimed:"已认领",running:"运行中",verifying:"待验收",completed:"已完成",failed:"失败",cancelled:"已取消",online:"在线",offline:"离线",degraded:"降级",staged:"准备中",archived:"已归档"};
const tabs = [{id:"task",label:"任务"},{id:"host",label:"主机"},{id:"team",label:"团队"},{id:"ocean",label:"海域"}] as const;
export function NativeWhalePanel({snapshotUrl="/plugins/dsh-fusion/state",visible=true}:NativeWhalePanelProps) {
 const {data,refresh,refreshing,sourceWarning}=useNativeData(snapshotUrl,visible);
 const [tab,setTab]=useState<string>("task");
 const [oceanVisited,setOceanVisited]=useState(false);
 const [query,setQuery]=useState("");
 const [status,setStatus]=useState("");
 const [history,setHistory]=useState<NativePanelSelection[]>([]);
 const selection=history[history.length-1];
 const root=useRef<HTMLElement>(null);
 const detail=useRef<HTMLDivElement>(null);
 const oceanTab=useRef<HTMLButtonElement>(null);
 const rowsRef=useRef(new Map<string,HTMLButtonElement>());
 const originRow=useRef<string>();
 const focusPending=useRef(false);
 const select=(next:NativePanelSelection)=>{
  if (selection?.kind===next.kind && selection.id===next.id) return;
  focusPending.current=true;
  if (!selection) originRow.current=next.id;
  setHistory(current=>[...current,next]);
 };
 const back=()=>{
  focusPending.current=true;
  setHistory(current=>current.slice(0,-1));
 };
 useLayoutEffect(()=>{
  if (!focusPending.current) return;
  focusPending.current=false;
  const panel=root.current;
  if (!visible || !panel) return;
  const active=panel.ownerDocument.activeElement;
  // A removed row leaves body active; never take focus from another DSH pane.
  if (active && active!==panel.ownerDocument.body && !panel.contains(active)) return;
  if (selection) detail.current?.focus({preventScroll:true});
  else if (tab==="ocean") oceanTab.current?.focus({preventScroll:true});
  else if (originRow.current) rowsRef.current.get(originRow.current)?.focus({preventScroll:true});
 },[history,visible,selection]);
 const projected = new Map(data.model.krill.map(task=>[task.id,task]));
 const priority = (task:typeof data.tasks[number]) => projected.get(task.id)?.blocked ? 0 : task.status==="failed" ? 1 : task.status==="verifying" ? 2 : 3;
 const rows = tab==="task" ? [...data.tasks].sort((a,b)=>priority(a)-priority(b)).map(task=>{
  const projection=projected.get(task.id);
  return {
   id:task.id,title:task.goal,status:projection?.blocked ? "blocked" : task.status,
   detail:[...data.teams.filter(team=>team.taskIds.includes(task.id)).map(team=>team.name),...task.targetNodeIds.map(id=>data.nodes.find(node=>node.id===id)?.name ?? id)].join(" · ") || "归属未知",
   evidence:[projection?.blocked ? "受阻" : "", projection?.dependencies ? projection.dependencies+" 个依赖" : "", task.evidence.length ? task.evidence.length+" 条证据" : "暂无证据"].filter(Boolean).join(" · "),
  };
 }) : tab==="host" ? data.nodes.map(node=>({id:node.id,title:node.name,status:node.status,detail:node.platform,evidence:node.unavailableReason ?? node.transports.join(" · ")}))
 : data.teams.map(team=>({id:team.id,title:team.name,status:team.phase,detail:team.workspace,evidence:team.taskIds.length+" 个任务"}));
 useEffect(()=>{setHistory([]);setStatus("");},[snapshotUrl]);
 const effectiveStatus=rows.some(row=>row.status===status) ? status : "";
 const filtered=rows.filter(row=>(!effectiveStatus || row.status===effectiveStatus) && (row.title+" "+row.detail+" "+row.id).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 return <section ref={root} className={styles.panel} aria-label="鲸" hidden={!visible} onKeyDown={event=>{if(event.key==="Escape" && selection && !event.nativeEvent.isComposing){event.stopPropagation();back();}}}>
  <div className={styles.toolbar}><span className={styles.source} role="status">{data.error ? (data.loaded ? "全局来源不可用 · 显示陈旧快照" : "全局来源不可用 · 请重试") : data.loaded ? ["全局来源：DSH Fusion",data.model.demo ? "演示数据" : "",sourceWarning].filter(Boolean).join(" · ") : "正在读取来源…"}</span><button type="button" disabled={!visible || refreshing} onClick={refresh}>{refreshing?"读取中…":"刷新"}</button></div>
  {selection ? <div ref={detail} tabIndex={-1} aria-label="详情导航" className={styles.content}><NativePanelDetails selection={selection} data={data} onBack={back} onSelect={select} backLabel={history.length>1 ? "返回"+({task:"任务",host:"主机",team:"团队"}[history[history.length-2]!.kind])+"详情" : tab==="ocean" ? "返回海域" : "返回"+({task:"任务",host:"主机",team:"团队"}[tab] ?? "")+"列表"}/></div> : <>
   <nav className={styles.tabs} aria-label="面板视图">{tabs.map(item=><button type="button" key={item.id} ref={item.id==="ocean" ? oceanTab : undefined} aria-pressed={tab===item.id} onClick={()=>{setTab(item.id);if(item.id==="ocean") setOceanVisited(true);setStatus("");}}>{item.label}</button>)}</nav>
   {tab!=="ocean" && <>
    <div className={styles.filters}><input aria-label="搜索名称或归属" placeholder="搜索名称或归属" value={query} onChange={event=>setQuery(event.target.value)}/><select aria-label="状态筛选" value={effectiveStatus} onChange={event=>setStatus(event.target.value)}><option value="">全部状态</option>{[...new Set(rows.map(row=>row.status))].map(value=><option key={value} value={value}>{labels[value] ?? value}</option>)}</select></div>
    <div className={styles.content} aria-busy={refreshing}>{!data.loaded ? <p className={styles.message}>{data.error ? "读取失败，点击刷新重试。" : "正在加载…"}</p> : filtered.length===0 ? <p className={styles.message}>{rows.length ? "没有符合筛选条件的记录。" : "当前来源暂无记录。"}</p> : <ul className={styles.list}>{filtered.map(row=><li key={row.id}><button ref={element=>{if(element) rowsRef.current.set(row.id,element);else rowsRef.current.delete(row.id);}} className={styles.row} type="button" onClick={()=>select({kind:tab as NativePanelSelection["kind"],id:row.id})}><span className={styles.heading}><span className={styles.title}>{row.title}</span><span className={styles.state}>{labels[row.status] ?? row.status}</span></span><span className={styles.secondary} title={row.detail+" · "+row.evidence}>{row.detail} · {row.evidence}</span></button></li>)}</ul>}</div>
   </>}
  </>}
  {oceanVisited && <div className={styles.content} hidden={!visible || !!selection || tab!=="ocean"}>
   <NativeOceanBoundary model={data.model} visible={visible && !selection && tab==="ocean"} onSelectTeam={(id:string)=>select({kind:"team",id})}/>
  </div>}
 </section>;
}
