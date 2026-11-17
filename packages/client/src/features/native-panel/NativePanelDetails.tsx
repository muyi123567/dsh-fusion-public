import { useState } from "react";
import type { NativePanelDetailsProps } from "./types.js";
import { WHALE_STATUS_TEXT } from "../whale/types.js";
import styles from "./native-details.module.css";
const enumLabels: Record<string,string> = { online:"在线", offline:"离线", degraded:"降级", current:"一致", drift:"存在漂移", unknown:"未知", staged:"准备中", running:"运行中", archived:"已归档", dedicated:"独享", shared:"共享", ssh:"SSH", seekfleet:"Seekfleet", "dsh-fleet":"DSH Fleet", yobiru:"Yobiru", tincan:"Tincan" };
const enumLabel = (value:string) => enumLabels[value] ?? value;
export function safeEvidenceUrl(value:string) { try { const u=new URL(value); return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password?u.href:undefined; } catch { return undefined; } }
export function NativePanelDetails({selection,data,onBack,onSelect,backLabel}:NativePanelDetailsProps) {
 const [copied,setCopied]=useState("");
 const task=selection.kind==="task"?data.tasks.find(x=>x.id===selection.id):undefined;
 const host=selection.kind==="host"?data.nodes.find(x=>x.id===selection.id):undefined;
 const team=selection.kind==="team"?data.teams.find(x=>x.id===selection.id):undefined;
 const label={task:"任务",host:"主机",team:"团队"}[selection.kind];
 const tasks=(ids:string[])=><ul>{[...new Set(ids)].map(id=><li key={id}><button type="button" onClick={()=>onSelect({kind:"task",id})}>{data.tasks.find(t=>t.id===id)?.goal??id}</button></li>)}</ul>;
 return <section className={styles.details} aria-label={label+"详情"} tabIndex={-1} onKeyDown={e=>{if(e.key==="Escape"&&!e.defaultPrevented&&!e.nativeEvent.isComposing&&e.currentTarget.contains(e.target as Node)){e.preventDefault();e.stopPropagation();onBack();}}}>
 <header><button type="button" onClick={onBack}>{backLabel ?? "返回列表"}</button><h2>{label}详情</h2></header>
 <code>{selection.id}</code><button type="button" onClick={()=>{void navigator.clipboard?.writeText(selection.id).then(()=>setCopied(selection.id),()=>setCopied("复制不可用，请手动选择 ID")); if(!navigator.clipboard)setCopied("复制不可用，请手动选择 ID");}}>复制 ID</button><p role="status">{copied===selection.id?"已复制":copied.startsWith("复制")?copied:""}</p>
 {!task&&!host&&!team&&<p role="alert">记录已移除或未返回（record missing），请返回列表。</p>}
 {task&&<><h3>执行目标</h3><pre>{task.goal}</pre><p>状态：{WHALE_STATUS_TEXT[task.status]??task.status} · 进度：{task.progress===undefined?"未报告":task.progress+"%"} · 传输：{enumLabel(task.transport)}</p>{task.error&&<pre>{task.error}</pre>}
 <h3>目标主机</h3>{task.targetNodeIds.map(id=><button type="button" key={id} onClick={()=>onSelect({kind:"host",id})}>{data.nodes.find(n=>n.id===id)?.name??id}</button>)}
 <h3>依赖任务</h3>{tasks(task.dependsOnTaskIds??[])}<h3>子任务</h3>{tasks((task.childTaskRefs??[]).map(x=>x.id))}
 <h3>所属团队</h3>{[...new Map(data.teams.map(t=>[t.id,t])).values()].filter(t=>t.taskIds.includes(task.id)).map(t=><button type="button" key={t.id} onClick={()=>onSelect({kind:"team",id:t.id})}>{t.name}</button>)}
 <h3>证据</h3><p>以下为来源记录，任务状态或证据条目本身不代表独立验收通过。</p>{!(task.evidence??[]).length&&<p>证据未提供，尚不能据此确认成功。</p>}{(task.evidence??[]).map((e,i)=><article key={i}><h4>{e.label} · {e.kind}</h4>{safeEvidenceUrl(e.value)?<a href={safeEvidenceUrl(e.value)} target="_blank" rel="noreferrer noopener">{e.value}</a>:<pre><code>{e.value}</code></pre>}{e.sha256&&<pre>SHA-256: {e.sha256}</pre>}</article>)}</>}
 {host&&<><h3>{host.name}</h3><p>状态：{enumLabel(host.status)} · 传输：{host.transports.map(enumLabel).join("、")} · 配置：{enumLabel(host.configState)}</p><p>CPU：{host.cpuPercent===undefined?"未报告":host.cpuPercent+"%"} · 内存：{host.memoryPercent===undefined?"未报告":host.memoryPercent+"%"}</p>{host.transports.includes("ssh")&&<p>SSH 在线仅表示可达，不代表 PTY 已连接或任务已完成。</p>}{host.unavailableReason&&<pre>{host.unavailableReason}</pre>}<h3>连接 / 兼容 / 能力 / 权限</h3><dl><dt>连接</dt><dd>{enumLabel(host.status)}；PTY 状态未提供</dd><dt>兼容</dt><dd>DSH {host.dshVersion??"版本未提供"}；兼容性未验证</dd><dt>能力</dt><dd>{host.capabilities.join("、")||"未报告"}（声明不等于运行验证）</dd><dt>权限</dt><dd>{host.hostAccess ? "共享策略："+enumLabel(host.hostAccess.sharingMode)+"；Owner："+(host.hostAccess.ownerId??"未提供")+"；实际授权未验证" : "权限策略未提供，实际授权未知"}</dd></dl><h3>关联任务</h3>{tasks(data.tasks.filter(t=>t.targetNodeIds.includes(host.id)).map(t=>t.id))}</>}
 {team&&<><h3>{team.name}</h3><p>{enumLabel(team.phase)} · {team.workspace}</p><h3>关联任务</h3>{tasks(team.taskIds)}</>}
 </section>;
}