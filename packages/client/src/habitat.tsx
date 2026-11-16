import {StrictMode,useState,useRef,useEffect} from "react";
import {createRoot} from "react-dom/client";
import {WhaleLivingPanel} from "./features/whale/ambient/WhaleLivingPanel.js";
import {WHALE_DEMO_MODEL} from "./features/whale/demo-fixture.js";
import {WHALE_STATUS_TEXT} from "./features/whale/types.js";
import "./features/whale/ambient/habitat-preview.css";
function Preview(){
 const [detail,setDetail]=useState<{kind:"task"|"host"|"destination";id:string}>();
 const [state,setState]=useState("current");const dialog=useRef<HTMLDialogElement>(null);
 const empty=state==="empty";
 const model={...WHALE_DEMO_MODEL,...(empty?{pods:[],hosts:[],krill:[],attention:[],summary:{hosts:0,online:0,teams:0,active:0,waiting:0,completed:0,unknownHosts:0}}:{}),freshness:state==="stale"?"stale" as const:state==="unobserved"?"unobserved" as const:"current" as const};
 useEffect(()=>{if(detail)dialog.current?.showModal();else dialog.current?.close();},[detail]);
 const task=model.krill.find(t=>t.id===detail?.id),host=model.hosts.find(h=>h.id===detail?.id);
 return <><div className="whale-preview-toolbar"><a href="./design-gallery.html">舰桥展厅</a><span>合成数据 · 只读预览</span><label>预览状态<select aria-label="预览状态" value={state} onChange={e=>setState(e.target.value)}><option value="current">已观测</option><option value="empty">空海域</option><option value="stale">连接中断</option><option value="unobserved">未观测</option></select></label><a href="./whale-dive.html">入海动画</a></div>
 <WhaleLivingPanel model={model} onOpenTask={id=>setDetail({kind:"task",id})} onOpenHost={id=>setDetail({kind:"host",id})} onNavigate={id=>setDetail({kind:"destination",id})}/>
 <dialog className="whale-preview-dialog" ref={dialog} aria-label="预览详情" data-task-id={detail?.kind==="task"?detail.id:undefined} onCancel={()=>setDetail(undefined)} onClose={()=>setDetail(undefined)}>
 <h2>{task?.title??host?.name??"工作区入口"}</h2><p>{task?WHALE_STATUS_TEXT[task.status]+" · "+task.evidenceCount+" 份证据":host?"主机资源与连接详情":"正式插件进入相应工作区。"}</p><p>合成数据 · 不派发真实任务</p><button type="button" onClick={()=>setDetail(undefined)}>关闭详情</button></dialog></>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Preview/></StrictMode>);
