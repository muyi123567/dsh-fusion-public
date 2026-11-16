import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Pause, Play, RotateCcw, X } from "lucide-react";
import "./whale-dive.css";

const DURATION=36;
const assetBase=import.meta.env.BASE_URL+"whale-assets/";
const phase=(t:number)=>t<5?"破水":t<14?"下潜":"深游";
const initialMotion=()=>!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export function WhaleDive(){
 const canvas=useRef<HTMLCanvasElement>(null);
 const position=useRef(initialMotion()?0:10);
 const active=useRef(initialMotion());
 const dirty=useRef(true);
 const [playing,setPlaying]=useState(active.current);
 const [time,setTime]=useState(position.current);
 const [ready,setReady]=useState(false);
 const [error,setError]=useState("");
 const [credits,setCredits]=useState(false);
 const creditButton=useRef<HTMLButtonElement>(null);
 const closeButton=useRef<HTMLButtonElement>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 function playback(next:boolean){active.current=next;setPlaying(next);}
 function seek(next:number){position.current=next;dirty.current=true;setTime(next);}
 useEffect(()=>{
  let disposed=false,failed=false,raf=0,last=0,published=-1,visible=!document.hidden,modelReady=false;
  let scene:import("./scene.js").DiveScene|undefined;
  const observer=new ResizeObserver(()=>{scene?.resize();dirty.current=true;});
  if(canvas.current)observer.observe(canvas.current);
  const visibility=()=>{visible=!document.hidden;last=0;dirty.current=true;};
  const media=window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced=()=>{if(media.matches){active.current=false;setPlaying(false);}};
  document.addEventListener("visibilitychange",visibility);
  media.addEventListener("change",reduced);
  const fail=(e:unknown)=>{
   if(disposed||failed)return;
   failed=true;active.current=false;setPlaying(false);
   setError(e instanceof Error?e.message:"此浏览器无法显示 3D 场景");
   cancelAnimationFrame(raf);scene?.dispose();scene=undefined;
  };
  const tick=(now:number)=>{
   if(disposed||failed)return;
   const delta=last===0?0:Math.min((now-last)/1000,.1);last=now;
   if(scene&&visible){
    if(active.current&&modelReady){
     position.current=Math.min(DURATION,position.current+delta);
     dirty.current=true;
     if(position.current>=DURATION){active.current=false;setPlaying(false);}
    }
    if(dirty.current){
     scene.render(position.current);dirty.current=false;
     if(Math.abs(position.current-published)>.16||!active.current){setTime(position.current);published=position.current;}
    }
   }
   raf=requestAnimationFrame(tick);
  };
  import("./scene.js").then(({createDiveScene})=>{
   if(disposed||!canvas.current)return;
   scene=createDiveScene({canvas:canvas.current,assetUrl:assetBase+"humpback-whale-light.glb",
    onReady:()=>{modelReady=true;if(!disposed){setReady(true);dirty.current=true;}},
    onError:fail
   });
   raf=requestAnimationFrame(tick);
  }).catch(fail);
  return ()=>{disposed=true;cancelAnimationFrame(raf);observer.disconnect();scene?.dispose();document.removeEventListener("visibilitychange",visibility);media.removeEventListener("change",reduced);};
 },[]);
 useEffect(()=>{
  if(credits){dialog.current?.showModal();closeButton.current?.focus();}
  else if(dialog.current?.open){dialog.current.close();creditButton.current?.focus();}
 },[credits]);
 return <main className="whale-dive" aria-label="鲸入深海动态原型">
  <canvas ref={canvas} className="wd-canvas" role="img" aria-label="真实纹理座头鲸，摆动尾鳍穿过波光水面，向深蓝海水中下潜" data-ready={ready&&!error?"true":"false"} data-phase={phase(time)} />
  {error&&<img className="wd-poster" src={assetBase+"whale-dive-poster.jpg"} alt="鲸鱼潜入深海的静态画面"/>}
  <div className="wd-vignette" aria-hidden="true"/>
  <header className="wd-header">
   <a className="wd-brand" href="./whale-dive.html" aria-label="鲸 · Whale"><span>鲸</span><span>WHALE</span></a>
   <a className="wd-back" href="./design-gallery.html?whaleDesign=bridge"><ArrowLeft size={16}/>返回舰桥</a>
  </header>
  <div className="wd-chapter" aria-live="polite"><span>{time<5?"01":time<14?"02":"03"} / 03</span><span>{phase(time)}</span></div>
  {!ready&&!error&&<div className="wd-loading" role="status"><span/>正在驶入深海</div>}
  {error&&<div className="wd-fallback" role="status">当前显示静态画面。<button type="button" onClick={()=>window.location.reload()}>重新载入动态</button></div>}
  <section className="wd-title" aria-labelledby="wd-title">
   <p>鲸群之间，万物相连。</p>
   <h1 id="wd-title">鲸入深海<span>Into the blue.</span></h1>
  </section>
  <footer className="wd-footer">
   <div className="wd-playback" role="group" aria-label="动画播放控制">
    <button type="button" disabled={!ready||!!error} aria-label={playing?"暂停动画":"播放动画"} onClick={()=>{if(time>=DURATION)seek(0);playback(!playing);}}>{playing?<Pause size={17} fill="currentColor"/>:<Play size={17} fill="currentColor"/>}</button>
    <button type="button" disabled={!ready||!!error} aria-label="重新播放" onClick={()=>{seek(0);playback(true);}}><RotateCcw size={17}/></button>
    <input type="range" aria-label="下潜进度" min="0" max={DURATION} step="0.05" value={time} disabled={!ready||!!error} onChange={e=>seek(Number(e.target.value))}/>
    <span className="wd-time">{Math.floor(time).toString().padStart(2,"0")} / {DURATION}s</span>
   </div>
   <button className="wd-credits-button" type="button" ref={creditButton} onClick={()=>setCredits(true)}>素材与代码<ArrowUpRight size={13}/></button>
  </footer>
  <dialog aria-labelledby="wd-credits-title" className="wd-credits" ref={dialog} onCancel={e=>{e.preventDefault();setCredits(false);}} onClose={()=>{setCredits(false);creditButton.current?.focus();}}>
   <button className="wd-close" type="button" ref={closeButton} aria-label="关闭素材说明" onClick={()=>setCredits(false)}><X size={18}/></button>
   <h2 id="wd-credits-title">深海，由真实细节构成。</h2>
   <p>座头鲸来自 Grab3D 的 CC0 纹理模型。摆尾、水面、光束、气泡与镜头由 Three.js 实时绘制，没有使用预录视频。</p>
   <p className="wd-credits-note">视觉动态原型，尚未接入真实团队状态。</p>
   <a href="https://grab3d.com/models/animals/humpback-whale/" target="_blank" rel="noreferrer">鲸鱼模型 · CC0 1.0<ArrowUpRight size={15}/></a>
   <a href="./whale-assets/LICENSE.txt" target="_blank" rel="noreferrer">查看素材原始许可<ArrowUpRight size={15}/></a>
   <a href="https://github.com/muyi123567/dsh-fusion-public" target="_blank" rel="noreferrer">查看开源代码<ArrowUpRight size={15}/></a>
  </dialog>
 </main>;
}
