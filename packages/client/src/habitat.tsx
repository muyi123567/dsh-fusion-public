import {StrictMode,useState,useRef,useEffect,useMemo} from "react";
import {createRoot} from "react-dom/client";
import {WhaleLivingPanel} from "./features/whale/ambient/WhaleLivingPanel.js";
import {WHALE_DEMO_MODEL} from "./features/whale/demo-fixture.js";
import {WHALE_STATUS_TEXT} from "./features/whale/types.js";
import "./features/whale/ambient/habitat-preview.css";
function Preview(){
 const [detail,setDetail]=useState<{kind:"task"|"host"|"destination";id:string}>();
 const [state,setState]=useState("current");const dialog=useRef<HTMLDialogElement>(null);
 const [demoCase,setDemoCase]=useState("startup"),[replay,setReplay]=useState(0),[event,setEvent]=useState(false);
 useEffect(()=>{setEvent(false);const t=setTimeout(()=>setEvent(true),500);return()=>clearTimeout(t);},[demoCase,replay]);
 const fixture=useMemo(()=>{
 const m=structuredClone(WHALE_DEMO_MODEL);
 if(demoCase==="ssh")m.hosts=m.hosts.map((h,i)=>i?h:{...h,transports:["ssh"],status:event?"online":"offline"});
 if(["start","verify","complete"].includes(demoCase))m.krill=m.krill.map((t,i)=>i?t:{...t,status:event?(demoCase==="start"?"running":demoCase==="verify"?"verifying":"completed"):(demoCase==="start"?"queued":"running")});
 if(demoCase==="subagent")m.subagents=[{id:"demo-dolphin",name:"合成协作子代理",status:event?"running":"idle"}];
 if(demoCase==="schedule"){m.schedulesObserved=true;m.schedules=[{id:"demo-gull",name:"合成定时任务",status:event?"running":"waiting",...(event?{lastRunId:"demo-"+replay}:{})}];}
 if(demoCase==="stale"&&event)m.freshness="stale";
 m.summary={...m.summary,active:m.krill.filter(t=>["running","claimed","verifying"].includes(t.status)).length,completed:m.krill.filter(t=>t.status==="completed").length,online:m.hosts.filter(h=>h.status==="online").length};
 return m;
 },[demoCase,replay,event]);
 const empty=state==="empty";
 const model=useMemo(()=>({...fixture,...(empty?{pods:[],hosts:[],krill:[],attention:[],subagents:[],schedules:[],summary:{hosts:0,online:0,teams:0,active:0,waiting:0,completed:0,unknownHosts:0}}:{}),freshness:state==="stale"?"stale" as const:state==="unobserved"?"unobserved" as const:fixture.freshness}),[fixture,empty,state]);
 useEffect(()=>{if(detail)dialog.current?.showModal();else dialog.current?.close();},[detail]);
 const task=model.krill.find(t=>t.id===detail?.id),host=model.hosts.find(h=>h.id===detail?.id);
 return <><div className="whale-preview-toolbar"><a href="./design-gallery.html">舰桥展厅</a><span>合成数据 · 不派发真实任务</span><label>情境演示<select aria-label="情境演示" value={demoCase} onChange={e=>{setEvent(false);setDemoCase(e.target.value);}}>{[["startup","启动"],["ssh","SSH主机上线"],["start","任务启动"],["verify","待验收"],["complete","完成"],["subagent","子代理协作"],["schedule","定时触发"],["stale","断连/失去观测"]].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><button onClick={()=>{setEvent(false);setReplay(v=>v+1);}}>重播情境</button><span data-demo-state={demoCase+":"+(event?"event":"baseline")+":"+replay}>{event?"事件":"基线"}</span><label>预览状态<select aria-label="预览状态" value={state} onChange={e=>setState(e.target.value)}><option value="current">已观测</option><option value="empty">空海域</option><option value="stale">连接中断</option><option value="unobserved">未观测</option></select></label><a href="./whale-dive.html">入海动画</a></div>
 <WhaleLivingPanel model={model} onOpenTask={id=>setDetail({kind:"task",id})} onOpenHost={id=>setDetail({kind:"host",id})} onNavigate={id=>setDetail({kind:"destination",id})}/>
 <dialog className="whale-preview-dialog" ref={dialog} aria-label="预览详情" data-task-id={detail?.kind==="task"?detail.id:undefined} onCancel={()=>setDetail(undefined)} onClose={()=>setDetail(undefined)}>
 <h2>{task?.title??host?.name??"工作区入口"}</h2><p>{task?WHALE_STATUS_TEXT[task.status]+" · "+task.evidenceCount+" 份证据":host?"主机资源与连接详情":"正式插件进入相应工作区。"}</p><p>合成数据 · 不派发真实任务</p><button type="button" onClick={()=>setDetail(undefined)}>关闭详情</button></dialog></>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Preview/></StrictMode>);
