import * as THREE from "three";
import type {OceanLife} from "./life-types.js";
import type {HabitatView} from "./contracts.js";
export function createLifeLayer(scene:THREE.Scene){
 const root=new THREE.Group();scene.add(root);
 const ball=new THREE.SphereGeometry(1,12,8),fin=new THREE.ConeGeometry(1,1,3),ring=new THREE.RingGeometry(.7,.75,32);
 const gray=new THREE.MeshStandardMaterial({color:0x9dbbc5}),white=new THREE.MeshStandardMaterial({color:0xe5ecec,side:THREE.DoubleSide}),dark=new THREE.MeshBasicMaterial({color:0x334650}),lit=new THREE.MeshBasicMaterial({color:0x85dace,transparent:true,opacity:.65,side:THREE.DoubleSide});
 type Actor={g:THREE.Group;at:number;away:boolean};
 const actors=new Map<string,Actor>(),seen=new Set<string>();let first=true,disposed=false,last=0;
 const add=(g:THREE.Group,geo:THREE.BufferGeometry,m:THREE.Material,x:number,y:number,z:number,sx:number,sy:number,sz:number)=>{const o=new THREE.Mesh(geo,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);g.add(o);return o;};
 const pos=new Float32Array(360),geo=new THREE.BufferGeometry();geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
 const pm=new THREE.PointsMaterial({color:0xd3be88,size:.055});const points=new THREE.Points(geo,pm);points.frustumCulled=false;root.add(points);
 return {update(life:OceanLife,seconds:number,view:HabitatView){
 if(disposed)return;
 const records=[...life.subagents.slice(0,4).map(r=>({r,kind:"d"})),...(life.schedulesObserved?life.schedules.slice(0,3):[]).map(r=>({r,kind:"b"})),...life.hosts.filter(r=>r.ssh).slice(0,4).map(r=>({r,kind:"h"}))];
 const keep=new Set(records.map(({r,kind})=>kind+r.id));
 for(const [key,a] of actors)if(!keep.has(key)){root.remove(a.g);actors.delete(key);}
 for(const {r,kind} of records){
 const key=kind+r.id;if(actors.has(key))continue;
 const g=new THREE.Group();g.userData.entityId=r.id;root.add(g);actors.set(key,{g,at:-Infinity,away:false});
 if(kind==="d"){
 add(g,ball,gray,0,0,0,.25,.25,1);
 add(g,ball,gray,0,-.02,1.1,.085,.07,.45);
 add(g,fin,gray,0,.32,-.1,.13,.45,.35);
 for(const s of [-1,1]){add(g,ball,gray,s*.28,0,-1,.38,.05,.16);add(g,ball,gray,s*.28,-.12,.2,.3,.04,.14);}
 }else if(kind==="b"){
 add(g,ball,white,0,0,0,.12,.14,.32);
 for(const s of [-1,1])add(g,fin,white,s*.4,0,0,.7,.045,.27);
 add(g,ball,dark,0,0,.35,.04,.04,.15);
 }else{
 add(g,fin,dark,0,-.1,0,.12,.8,.12);
 add(g,ball,dark,0,.4,0,.17,.17,.17);
 add(g,ring,lit,0,-.48,0,1,1,1).rotation.x=-Math.PI/2;
 add(g,ball,dark,0,-.5,-1.7,.025,.025,1.5);
 }}
 const currentCueIds=new Set(life.cues.map(c=>c.id));for(const id of seen)if(!currentCueIds.has(id))seen.delete(id);
 for(const cue of life.cues){if(seen.has(cue.id))continue;seen.add(cue.id);
 if(!first&&life.phase!=="stale")for(const a of actors.values())if(a.g.userData.entityId===cue.entityId){
 if(cue.kind==="subagent-start")a.away=true;
 if(cue.kind==="subagent-stop")a.away=false;
 if(["schedule-trigger","host-online","host-offline"].includes(cue.kind))a.at=seconds;
 }}
 while(seen.size>256)seen.delete(seen.values().next().value!);first=false;
 const dt=Math.max(0,Math.min(.1,seconds-last));last=seconds;
 records.forEach(({r,kind},i)=>{
 const a=actors.get(kind+r.id)!;const g=a.g;g.userData.name=r.name;g.userData.status=life.phase==="stale"?"stale":r.status;
 if(kind==="d"){
 const t=seconds*(r.status==="running"?.42:.13)+i*1.7;
 const target=-7+Math.sin(t)*(a.away?4:2.3);
 g.position.x+=(target-g.position.x)*Math.min(1,dt*2);
 g.scale.setScalar(1.25);g.position.y=-3.5+i*.35;g.position.z=3+Math.cos(t)*1.4;
 g.rotation.set(r.status==="failed"?-.18:Math.sin(t*2)*.04,t+Math.PI/2,r.status==="failed"?.22:0);
 }else if(kind==="b"){
 const age=seconds-a.at,pass=age>=0&&age<3,t=seconds*.2+i*2;
 g.scale.setScalar(1.4);g.visible=view==="surface"&&r.status!=="disabled";g.position.set(pass?-9+age*6:Math.sin(t)*4,9+(i%3)*.6,-6+Math.cos(t)*2);g.rotation.y=pass?Math.PI/2:t+Math.PI/2;
 for(let n=1;n<=2;n++)g.children[n]!.rotation.z=(n===1?-1:1)*(.12+Math.sin(seconds*3.2+i+n*.65)*.22);
 }else{
 g.position.set(7+(i%4)*1.4,view==="surface"?5.8:.1,-9-(i%4)*.9);
 const online=r.status==="online"&&life.phase!=="stale";
 (g.children[1] as THREE.Mesh).material=online?lit:dark;
 (g.children[3] as THREE.Mesh).material=online?lit:dark;
 const age=seconds-a.at;g.children[2]!.visible=life.phase!=="stale"&&age>=0&&age<2;g.children[2]!.scale.setScalar(1+Math.max(0,Math.min(age,2))*1.8);
 }});
 const tasks=life.tasks.slice(0,20);points.userData.entityIds=tasks.map(t=>t.id);
 tasks.forEach((t,i)=>{for(let k=0;k<6;k++){const n=i*6+k;const flow=life.phase!=="stale"&&!t.blocked&&["running","active"].includes(t.status)?(seconds*.65+k*.16)%1:0;pos[n*3]=-4+i%5*1.5+Math.sin(k*2.4)*.3+flow;pos[n*3+1]=-3+Math.floor(i/5)*.35+Math.cos(k)*.12;pos[n*3+2]=-1+Math.sin(k*1.3)*.35-flow*.7;}});
 geo.setDrawRange(0,tasks.length*6);geo.attributes.position!.needsUpdate=true;
 },getMetrics(){return {dolphins:[...actors.keys()].filter(k=>k.startsWith("d")).length,gulls:[...actors.keys()].filter(k=>k.startsWith("b")).length,beacons:[...actors.keys()].filter(k=>k.startsWith("h")).length,krill:geo.drawRange.count};},dispose(){if(disposed)return;disposed=true;scene.remove(root);root.clear();actors.clear();seen.clear();[ball,fin,ring,geo].forEach(g=>g.dispose());[gray,white,dark,lit,pm].forEach(m=>m.dispose());}};
}
