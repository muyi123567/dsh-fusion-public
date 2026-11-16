import * as THREE from "three";
import { samplePodMotion } from "../ambient/pod-motion.js";
import type { HabitatActivity, HabitatTier, HabitatPod, HabitatView } from "../ambient/contracts.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const DIVE_DURATION = 36;
export type DiveScene = { setPods:(pods:HabitatPod[])=>void; setView:(view:HabitatView)=>void; setSelected:(id:string|undefined)=>void; hitTest:(x:number,y:number)=>string|undefined; getMetrics:()=>import("../ambient/contracts.js").HabitatMetrics; setQuality:(quality:HabitatTier)=>void; setActivity:(activity:HabitatActivity)=>void; render: (seconds:number) => void; resize:()=>void; metrics:()=>{calls:number;triangles:number;geometries:number;textures:number;programs:number}; dispose:()=>void; };
type Options = { pods?:HabitatPod[]; view?:HabitatView; selectedPodId?:string; mode?: "dive" | "ambient"; quality?: HabitatTier; activity?: HabitatActivity; canvas:HTMLCanvasElement; assetUrl:string; onReady:()=>void; onError:(error:Error)=>void; };
const clamp=THREE.MathUtils.clamp;
const smooth=(a:number,b:number,x:number)=>THREE.MathUtils.smoothstep(x,a,b);
const WATER_Y=5.4;

/** Real mesh + procedural deformation. Visual simulation, not a fluid solver. */
export function createDiveScene({canvas,assetUrl,onReady,onError,mode="dive",quality="balanced",pods=[],view="deep",selectedPodId}:Options):DiveScene {
 const ambient = mode === "ambient";
 let currentPods = pods.filter((pod,index,list)=>pod.id&&list.findIndex(p=>p.id===pod.id)===index).slice(0,3);
 let currentView = view;
 let selectedId = selectedPodId;
 type PodWhale = {id:string; root:THREE.Group; clock:{value:number}; materials:THREE.Material[];
  spout:THREE.Points<THREE.BufferGeometry,THREE.PointsMaterial>;
  krill:THREE.Points<THREE.BufferGeometry,THREE.PointsMaterial>;
  ripple:THREE.Mesh<THREE.RingGeometry,THREE.MeshBasicMaterial>;
  workTime:number};
 const podWhales:PodWhale[]=[];
 const breathLocal=new THREE.Vector3(), breathWorld=new THREE.Vector3();
 let modelRadius=8;
 const raycaster=new THREE.Raycaster(), pointer=new THREE.Vector2();
 const skyColor=new THREE.Color("#6999b5"), deepColor=new THREE.Color("#032333");

 let currentQuality = quality;
 let renderedFrames = 0, renderedTime = 0;
 const renderer = new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:"low-power"});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio,ambient && quality === "eco" ? 1 : 1.5));
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.toneMapping=THREE.ACESFilmicToneMapping;
 renderer.toneMappingExposure=1.1;
 const scene = new THREE.Scene();
 scene.background = new THREE.Color("#032333");
 scene.fog = new THREE.FogExp2("#06405a",0.022);
 const camera=new THREE.PerspectiveCamera(42,1,0.1,250);
 const clock={value:0};
 const resources:Array<{dispose:()=>void}>=[];
 let disposed=false;
 let whale:THREE.Group|undefined;
 const whaleRoot = new THREE.Group();
 scene.add(whaleRoot);

 scene.add(new THREE.HemisphereLight("#bde9ed","#031622",2.0));
 const sun=new THREE.DirectionalLight("#e0fbf5",3.1);
 sun.position.set(-12,30,8); scene.add(sun);
 const fill=new THREE.DirectionalLight("#458aaa",0.9);
 fill.position.set(12,-7,15);scene.add(fill);
 const rim=new THREE.DirectionalLight("#559da8",1.4);
 rim.position.set(-8,3,-15);scene.add(rim);

 // The water volume is a camera-facing background, with no downloaded sky image.
 const volumeGeometry=new THREE.SphereGeometry(160,32,20);
 const volumeMaterial=new THREE.ShaderMaterial({
  side:THREE.BackSide,depthWrite:false,
  uniforms:{time:clock},
  vertexShader:`varying vec3 vDirection;void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader:`varying vec3 vDirection;uniform float time;
   void main(){vec3 d=normalize(vDirection);
    float up=smoothstep(-.6,.75,d.y);
    vec3 color=mix(vec3(.002,.025,.045),vec3(.024,.21,.28),up);
    vec3 light=normalize(vec3(-.38,.8,-.2));
    float sun=pow(max(dot(d,light),0.),12.);
    color+=vec3(.08,.19,.2)*sun;
    color+=vec3(.015,.04,.05)*pow(max(dot(d,normalize(vec3(-.5,.25,-1.))),0.),5.);
    gl_FragColor=vec4(color,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
   }`
 });
 const volume=new THREE.Mesh(volumeGeometry,volumeMaterial);scene.add(volume);resources.push(volumeGeometry,volumeMaterial);

 // Displaced, translucent water ceiling. Directional caustics are computed in world space.
 const segments=ambient ? (quality === "eco" ? 28 : 48) : 112;
 let waterGeometry=new THREE.PlaneGeometry(210,210,segments,segments);
 waterGeometry.rotateX(-Math.PI/2);
 const waterMaterial=new THREE.ShaderMaterial({
  side:THREE.DoubleSide,transparent:true,depthWrite:false,
  uniforms:{time:clock},
  vertexShader:`uniform float time;varying vec3 vWorld;
   void main(){vec3 p=position;
    p.y+=sin(p.x*.32+p.z*.24-time*.54)*.13+sin(p.z*.67-p.x*.43+time*.39)*.07+sin(p.x*1.8+time*.8)*.018;
    vWorld=(modelMatrix*vec4(p,1.)).xyz;
    gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);
   }`,
  fragmentShader:`uniform float time;varying vec3 vWorld;
   float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
   float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
   void main(){
    vec2 p=vWorld.xz*.45;float t=time*.16;
    vec2 q=vec2(noise(p+vec2(t,-t)),noise(p*1.8-vec2(t,0.)));
    float a=noise(p*2.4+q*2.+t),b=noise(p*5.2-q*2.-t);
    float ridges=pow(1.-abs(a*2.-1.),11.)*.7+pow(1.-abs(b*2.-1.),14.)*.22;
    float light=exp(-length((vWorld.xz-vec2(-16.,-18.))*.028));
    vec3 col=mix(vec3(.018,.14,.2),vec3(.10,.36,.4),light);
    col+=vec3(.12,.22,.2)*ridges*light;
    col+=vec3(.2,.28,.23)*pow(light,10.);
    float horizon=(1.-smoothstep(12.,115.,length(vWorld.xz)));
    gl_FragColor=vec4(col,mix(.08,.85,horizon));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
   }`
 });
 const water=new THREE.Mesh(waterGeometry,waterMaterial);water.position.y=WATER_Y;scene.add(water);resources.push(waterGeometry,waterMaterial);

 const beamGeometry=new THREE.PlaneGeometry(1,1);
 const beamMaterial=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,
  uniforms:{time:clock},
  vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader:`varying vec2 vUv;uniform float time;
   void main(){float width=mix(.08,.5,1.-vUv.y);
    float a=exp(-pow((vUv.x-.5)/width,2.)*4.)*sin(vUv.y*3.14159);
    float pulse=.8+.2*sin(time*.28+vUv.x*4.);
    gl_FragColor=vec4(.25,.64,.69,a*.075*pulse);}`
 });
 resources.push(beamGeometry,beamMaterial);
 const beams: THREE.Mesh[] = [];
 for(let i=0;i<9;i++){
  const beam=new THREE.Mesh(beamGeometry,beamMaterial);
  beam.position.set(-15+i*3.8,-7,-18-i%3*5);
  beam.scale.set(3+i%3*2,37,1);beam.rotation.z=-.26;
  beam.visible = !ambient || quality !== "eco";
  beams.push(beam);scene.add(beam);
 }

 // Deterministic suspended particles: stable replay, no per-frame allocations.
 const count=ambient ? 220 : 520,positions=new Float32Array(count*3),sizes=new Float32Array(count);
 let seed=71231;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let i=0;i<count;i++){
  positions.set([(random()-.5)*65,random()*35-25,(random()-.5)*65],i*3);sizes[i]=random();
 }
 const dustGeometry=new THREE.BufferGeometry();
 dustGeometry.setAttribute("position",new THREE.BufferAttribute(positions,3));
 dustGeometry.setAttribute("size",new THREE.BufferAttribute(sizes,1));
 const dustMaterial=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{time:clock},
  vertexShader:`uniform float time;attribute float size;varying float vAlpha;
   void main(){vec3 p=position;p.x+=sin(time*.08+p.y*.3)*.45;p.y+=sin(time*.12+size*6.)*.2;
    vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
    gl_PointSize=clamp((12.+size*21.)/-mv.z,1.,2.6);vAlpha=(.12+size*.3)*(1.-smoothstep(8.,65.,-mv.z));}`,
  fragmentShader:`varying float vAlpha;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;gl_FragColor=vec4(.55,.84,.86,(1.-smoothstep(.05,.5,d))*vAlpha);}`
 });
 const dust=new THREE.Points(dustGeometry,dustMaterial);
 dustGeometry.setDrawRange(0,ambient && quality==="eco" ? 90 : count);
 scene.add(dust);resources.push(dustGeometry,dustMaterial);

 const bubbleCount=150,bubblePositions=new Float32Array(bubbleCount*3),bubbleSeeds=new Float32Array(bubbleCount);
 for(let i=0;i<bubbleCount;i++){bubblePositions.set([(random()-.5)*4,random()*7-2,random()*5+1],i*3);bubbleSeeds[i]=random();}
 const bubblesGeometry=new THREE.BufferGeometry();
 bubblesGeometry.setAttribute("position",new THREE.BufferAttribute(bubblePositions,3));
 bubblesGeometry.setAttribute("seed",new THREE.BufferAttribute(bubbleSeeds,1));
 const bubblesMaterial=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,uniforms:{time:clock},
  vertexShader:`uniform float time;attribute float seed;varying float vAlpha;
   void main(){vec3 p=position;float age=time-seed*3.;
    p.y+=max(0.,age)*.48;p.x+=sin(age*2.+seed*12.)*.22;p.z+=sin(age+seed*3.)*.15;
    vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
    gl_PointSize=clamp((30.+seed*65.)/-mv.z,1.,10.);
    vAlpha=smoothstep(-.5,1.,age)*(1.-smoothstep(4.4,5.5,p.y))*(1.-smoothstep(8.,13.,time))*.5;}`,
  fragmentShader:`varying float vAlpha;void main(){float d=length(gl_PointCoord-.5);if(d>.48)discard;
    float ring=smoothstep(.29,.42,d)*(1.-smoothstep(.42,.48,d));
    float spec=exp(-length((gl_PointCoord-vec2(.32,.28))*14.));
    gl_FragColor=vec4(.75,.94,.96,(ring*.65+spec)*vAlpha);}`
 });
 const bubbles=new THREE.Points(bubblesGeometry,bubblesMaterial);bubbles.position.set(3.8,0,-3.2);scene.add(bubbles);resources.push(bubblesGeometry,bubblesMaterial);

 const rings:THREE.Mesh<THREE.RingGeometry,THREE.MeshBasicMaterial>[]=[];
 for(let i=0;i<3;i++){
  const geometry=new THREE.RingGeometry(.98,1,96);
  const material=new THREE.MeshBasicMaterial({color:"#a6dee0",transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false});
  const ring=new THREE.Mesh(geometry,material);ring.rotation.x=-Math.PI/2;ring.position.set(4.8,WATER_Y-.05,-2.6);scene.add(ring);
  rings.push(ring);resources.push(geometry,material);
 }

 // GLB clones share geometry/textures; only their materials belong to the instance.
 const releaseModel=(root:THREE.Object3D)=>{
  const geometries=new Set<THREE.BufferGeometry>(), materials=new Set<THREE.Material>();
  const textures=new Set<THREE.Texture>(), images=new Set<{close:()=>void}>();
  root.traverse(object=>{
   if(!(object instanceof THREE.Mesh))return;
   geometries.add(object.geometry);
   for(const material of Array.isArray(object.material)?object.material:[object.material]){
    materials.add(material);
    for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);
   }
  });
  for(const geometry of geometries)geometry.dispose();
  for(const material of materials)material.dispose();
  for(const texture of textures){
   const image=texture.source?.data;
   if(image&&typeof image.close==="function")images.add(image);
   texture.dispose();
  }
  for(const image of images)image.close();
 };
 const sprayGeometry=new THREE.BufferGeometry(), krillGeometry=new THREE.BufferGeometry();
 const sprayPositions=new Float32Array(48*3), krillPositions=new Float32Array(60*3);
 for(let i=0;i<48;i++)sprayPositions.set([0,0,0],i*3);
 for(let i=0;i<60;i++)krillPositions.set([Math.cos(i*2.4)*(1+i%7*.12),Math.sin(i*1.7)*.55,Math.sin(i*2.4)*(1+i%7*.12)],i*3);
 sprayGeometry.setAttribute("position",new THREE.BufferAttribute(sprayPositions,3));
 krillGeometry.setAttribute("position",new THREE.BufferAttribute(krillPositions,3));
 resources.push(sprayGeometry,krillGeometry);
 const rippleGeometry=new THREE.RingGeometry(.94,1,48);resources.push(rippleGeometry);
 function clearPod(entry:PodWhale){
  scene.remove(entry.root,entry.spout,entry.krill,entry.ripple);
  for(const material of entry.materials)material.dispose();
  entry.spout.material.dispose();entry.krill.material.dispose();entry.ripple.material.dispose();
 }
 function syncPods(){
  if(!ambient||!whale||disposed)return;
  const ids=new Set(currentPods.map(p=>p.id));
  for(let i=podWhales.length-1;i>=0;i--)if(!ids.has(podWhales[i]!.id))clearPod(podWhales.splice(i,1)[0]!);
  for(const pod of currentPods){
   if(podWhales.some(entry=>entry.id===pod.id))continue;
   const model=whale.clone(true), root=new THREE.Group(), swimClock={value:0};
   const materials:THREE.Material[]=[];
   const copies=new Map<THREE.Material,THREE.Material>();
   model.traverse(object=>{
    object.userData.teamId=pod.id;
    if(!(object instanceof THREE.Mesh))return;
    const copy=(source:THREE.Material)=>{
     let material=copies.get(source);
     if(!material){material=source.clone();copies.set(source,material);materials.push(material);}
     return material;
    };
    object.material=Array.isArray(object.material)?object.material.map(copy):copy(object.material);
   });
   root.userData.teamId=pod.id;root.add(model);deformModel(model,swimClock);
   const spout=new THREE.Points(sprayGeometry,new THREE.PointsMaterial({color:"#e1f3f3",size:.16,transparent:true,opacity:0,depthWrite:false}));
   const krill=new THREE.Points(krillGeometry,new THREE.PointsMaterial({color:"#a6ced3",size:.045,transparent:true,opacity:.35,depthWrite:false}));
   const ripple=new THREE.Mesh(rippleGeometry,new THREE.MeshBasicMaterial({color:"#b5dfe1",transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false}));
   ripple.rotation.x=-Math.PI/2;spout.visible=false;krill.visible=false;ripple.visible=false;
   scene.add(root,spout,krill,ripple);
   podWhales.push({id:pod.id,root,clock:swimClock,materials,spout,krill,ripple,workTime:0});
  }
 }
 function deformModel(model:THREE.Object3D,swimClock:{value:number}){
  model.traverse(object=>{
   if(!(object instanceof THREE.Mesh))return;
   const materials=Array.isArray(object.material)?object.material:[object.material];
   for(const material of materials){
    if(!(material instanceof THREE.MeshStandardMaterial))continue;
    material.roughness=.66;material.metalness=.02;
    material.onBeforeCompile=shader=>{
     shader.uniforms.uSwimTime=swimClock;
     shader.vertexShader=`uniform float uSwimTime;varying vec3 vWhaleWorld;
      float whaleBend(vec3 p){
       float tail=smoothstep(-.8,6.5,-p.z);
       float fin=smoothstep(1.85,4.3,abs(p.x))*(1.-smoothstep(2.,5.,-p.z));
       return sin(uSwimTime*1.36+p.z*.48)*tail*tail*.95+sin(uSwimTime*.95+.4)*fin*.38;
      }
`+shader.vertexShader;
     shader.vertexShader=shader.vertexShader.replace("#include <beginnormal_vertex>",`
      #include <beginnormal_vertex>
      float dx=(whaleBend(position+vec3(.02,0.,0.))-whaleBend(position-vec3(.02,0.,0.)))/.04;
      float dz=(whaleBend(position+vec3(0.,0.,.02))-whaleBend(position-vec3(0.,0.,.02)))/.04;
      objectNormal.x-=dx*objectNormal.y;objectNormal.z-=dz*objectNormal.y;
      objectNormal=normalize(objectNormal);
     `);
     shader.vertexShader=shader.vertexShader.replace("#include <begin_vertex>",`
      #include <begin_vertex>
      transformed.y+=whaleBend(position);
     `);
     shader.vertexShader=shader.vertexShader.replace("#include <project_vertex>","vWhaleWorld=(modelMatrix*vec4(transformed,1.)).xyz;\n#include <project_vertex>");
     shader.fragmentShader="uniform float uSwimTime;varying vec3 vWhaleWorld;\n"+shader.fragmentShader;
     shader.fragmentShader=shader.fragmentShader.replace("#include <opaque_fragment>",`
      vec2 p=vWhaleWorld.xz*.85;
      float ripple=sin(p.x*2.2+sin(p.y*1.9+uSwimTime*.38))+sin(p.y*2.4+sin(p.x*1.7-uSwimTime*.27));
      float caustic=pow(1.-abs(ripple)*.5,16.);
      outgoingLight+=vec3(.07,.19,.2)*caustic*.12;
      #include <opaque_fragment>
     `);
    };
   }
  });
 }
 const loader=new GLTFLoader();
 loader.load(assetUrl,gltf=>{
  if(disposed){releaseModel(gltf.scene);return;}
  whale=gltf.scene;
  const bounds=new THREE.Box3().setFromObject(whale);
  const center=bounds.getCenter(new THREE.Vector3());
  whale.position.sub(center);
  if(!ambient)whaleRoot.add(whale);
  if(ambient){
   whaleRoot.remove(whale);
   const modelBounds=new THREE.Box3().setFromObject(whale);
   // Coordinates are in the centered clone root, not the translated GLTF node.
   breathLocal.set(0,modelBounds.max.y,modelBounds.max.z*.15);
   modelRadius=modelBounds.getBoundingSphere(new THREE.Sphere()).radius;
   syncPods();
  }else deformModel(whale,clock);
  onReady();
 },undefined,error=>{if(!disposed)onError(error instanceof Error?error:new Error("鲸模型加载失败"));});

 const deepFog=scene.fog;
 let lastPodTime=0;
 // Fixed point cloud is shared across the at-most-three short mist bursts.
 for(let i=0;i<48;i++){
  const a=i*2.39996, h=(i+.5)/48;
  sprayPositions.set([Math.cos(a)*Math.sqrt(h)*.7,h*1.7,Math.sin(a)*Math.sqrt(h)*.5],i*3);
 }
 sprayGeometry.attributes.position!.needsUpdate=true;
 sprayGeometry.setDrawRange(0,quality==="eco"?24:48);
 const target=new THREE.Vector3();
 function resize(){
  if(disposed)return;
  const width=canvas.clientWidth,height=canvas.clientHeight;
  if(width===0||height===0)return;
  renderer.setSize(width,height,false);camera.aspect=width/height;
  camera.fov=camera.aspect<.75?57:42;camera.updateProjectionMatrix();
 }
 function render(seconds:number){
  if(disposed)return;
  const t=ambient ? 18 : clamp(seconds,0,DIVE_DURATION);clock.value=ambient ? seconds : t;
  const descend=smooth(0,13,t);
  const deep=smooth(12,36,t);
  whaleRoot.position.set(2.0-descend*2.3-deep*5,3.05-descend*5.5-deep*3.7+Math.sin(t*1.36)*.07,1-deep*5);
  whaleRoot.rotation.set(.44-descend*.18+deep*.05+Math.sin(t*1.36)*.025,-.95+deep*.3,-.08-descend*.14+Math.sin(t*.18)*.025);
  const mobile=camera.aspect<.75;
  camera.position.set(mobile?19:15,1.0-descend*.7, mobile?31:24);
  target.set(-.6-deep*2,-1.0-descend*1.1-deep*1.2,-1.0);
  camera.lookAt(target);
  for(let i=0;i<rings.length;i++){
   const ring=rings[i]!;const age=t-i*1.35;
   const radius=Math.max(.01,age)*1.7+.3;
   ring.scale.setScalar(radius);
   ring.material.opacity=age<0?0:Math.exp(-age*.45)*.22;
  }
  if(ambient){
   const surface=currentView==="surface";
   whaleRoot.visible=false;bubbles.visible=false;
   volume.visible=!surface;dust.visible=!surface;
   scene.background=surface?skyColor:deepColor;
   scene.fog=surface?null:deepFog;
   for(const beam of beams)beam.visible=!surface&&currentQuality!=="eco";
   // Keep the surface camera above the 5.4 water plane, including mobile.
   camera.position.set(surface?18:15,surface?16:1,mobile?(surface?40:36):(surface?28:26));
   target.set(0,surface?3:-1,0);
   // Fit a conservative envelope of all motion lanes and the full source mesh.
   // Horizontal FOV, not just vertical FOV, limits narrow portrait canvases.
   const halfVertical=THREE.MathUtils.degToRad(camera.fov*.5);
   const halfHorizontal=Math.atan(Math.tan(halfVertical)*camera.aspect);
   const podEnvelope=modelRadius*.85+6;
   const fitDistance=podEnvelope/Math.sin(Math.min(halfVertical,halfHorizontal))*1.08;
   const currentDistance=camera.position.distanceTo(target);
   if(fitDistance>currentDistance)camera.position.sub(target).multiplyScalar(fitDistance/currentDistance).add(target);
   camera.far=Math.max(250,fitDistance+200);camera.updateProjectionMatrix();
   camera.lookAt(target);
   const delta=Math.max(0,Math.min(.1,seconds-lastPodTime));lastPodTime=seconds;
   for(let index=0;index<currentPods.length;index++){
    const pod=currentPods[index]!, entry=podWhales.find(w=>w.id===pod.id);
    if(!entry)continue;
    const motion=samplePodMotion(seconds,index,currentPods.length,currentView,pod,camera.aspect);
    entry.root.position.set(...motion.position);entry.root.rotation.set(...motion.rotation);
    entry.root.scale.setScalar(motion.scale);entry.clock.value=motion.swimTime;
    // Preserve original texture; selected team gets only a restrained material lift.
    for(const material of entry.materials)if(material instanceof THREE.MeshStandardMaterial){
     material.emissive.set(selectedId===entry.id?"#12353e":"#000000");
     material.emissiveIntensity=selectedId===entry.id ? .22 : 0;
    }
    entry.root.updateMatrixWorld(true);
    breathWorld.copy(breathLocal).applyMatrix4(entry.root.matrixWorld);
    const wave=.13*Math.sin(breathWorld.x*.32+breathWorld.z*.24-seconds*.54)
      +.07*Math.sin(breathWorld.z*.67-breathWorld.x*.43+seconds*.39)
      +.018*Math.sin(breathWorld.x*1.8+seconds*.8);
    const strength=clamp(motion.spout,0,1);
    const breathing=surface&&strength>0&&breathWorld.y>WATER_Y+wave+.03;
    entry.spout.visible=breathing;entry.spout.material.opacity=breathing?strength*.45:0;
    entry.spout.position.copy(breathWorld);
    // Expand into a short soft mist, never a continuous underwater jet.
    entry.spout.scale.set(.25+strength*.65,.25+strength*.9,.25+strength*.65);
    entry.ripple.visible=breathing;
    entry.ripple.position.set(breathWorld.x,WATER_Y+.04,breathWorld.z);
    entry.ripple.scale.setScalar(.6+(1-strength)*2.2);
    entry.ripple.material.opacity=breathing?strength*.13:0;
    const working=pod.observed&&pod.active>0;
    entry.krill.visible=working;
    if(working)entry.workTime+=delta*Math.min(1,pod.active/(pod.active+Math.max(0,pod.blocked)));
    entry.krill.position.copy(entry.root.position);entry.krill.position.y-=.7;
    entry.krill.rotation.y=entry.workTime*.2;
    entry.krill.geometry.setDrawRange(0,currentQuality==="eco"?24:60);
   }
   clock.value=seconds;
   // A shared immutable mist distribution; each team has its own transform/material.
   for(let i=0;i<rings.length;i++)rings[i]!.visible=false;
  }
  renderer.render(scene,camera);
  renderedFrames++;renderedTime=seconds;
 }
 const contextLost=(event:Event)=>{event.preventDefault();if(!disposed)onError(new Error("3D 画面连接中断，请重新载入。"));};
 canvas.addEventListener("webglcontextlost",contextLost);
 resize();
 const getMetrics=()=>({
  frames:renderedFrames, elapsed:renderedTime, tier:currentQuality,
  calls:renderer.info.render.calls, triangles:renderer.info.render.triangles,
  geometries:renderer.info.memory.geometries, textures:renderer.info.memory.textures,
  programs:renderer.info.programs?.length ?? 0
 });
 const setQuality=(next:HabitatTier)=>{
  if(disposed)return;
  currentQuality=next;
  if(ambient){
   for(const beam of beams)beam.visible=currentView==="deep"&&next!=="eco";
   dustGeometry.setDrawRange(0,next==="eco"?90:count);
   sprayGeometry.setDrawRange(0,next==="eco"?24:48);
   const nextSegments=next==="eco"?28:48;
   if(waterGeometry.parameters.widthSegments!==nextSegments){
    const old=waterGeometry;
    waterGeometry=new THREE.PlaneGeometry(210,210,nextSegments,nextSegments);
    waterGeometry.rotateX(-Math.PI/2);
    water.geometry=waterGeometry;
    const index=resources.indexOf(old);
    if(index>=0)resources[index]=waterGeometry;
    old.dispose();
   }
   renderer.setPixelRatio(Math.min(window.devicePixelRatio,next==="eco"?1:1.5));
   resize();
  }
 };
 const setPods=(next:HabitatPod[])=>{
  if(disposed)return;
  const ids=new Set<string>();
  currentPods=next.filter(p=>p.id&&!ids.has(p.id)&&!!ids.add(p.id)).slice(0,3);
  syncPods();
 };
 const hitTest=(x:number,y:number)=>{
  if(disposed||!ambient)return undefined;
  const bounds=canvas.getBoundingClientRect();
  if(bounds.width<=0||bounds.height<=0)return undefined;
  // DOM client coordinates, matching PointerEvent.clientX/clientY.
  pointer.set((x-bounds.left)/bounds.width*2-1,-(y-bounds.top)/bounds.height*2+1);
  camera.updateMatrixWorld();scene.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer,camera);
  const hit=raycaster.intersectObjects(podWhales.map(w=>w.root),true)[0];
  return hit?.object.userData.teamId as string|undefined;
 };
 return {render,resize,getMetrics,setQuality,setPods,
 setView:(next:HabitatView)=>{currentView=next;},
 setSelected:(id:string|undefined)=>{selectedId=id;},hitTest,setActivity:(_next:HabitatActivity)=>{},metrics:()=>({
  calls:renderer.info.render.calls, triangles:renderer.info.render.triangles,
  geometries:renderer.info.memory.geometries, textures:renderer.info.memory.textures,
  programs:renderer.info.programs?.length ?? 0
 }),dispose(){
  if(disposed)return;disposed=true;
  canvas.removeEventListener("webglcontextlost",contextLost);
  for(const entry of podWhales)clearPod(entry);
  podWhales.length=0;
  if(whale)releaseModel(whale);
  for(const resource of resources)resource.dispose();
  scene.clear();renderer.dispose();renderer.forceContextLoss();
 }};
}


/** Explicit ambient mode; legacy callers retain the original 36-second dive. */
export type AmbientScene = DiveScene;
export function createAmbientScene(options: Options): AmbientScene {
 return createDiveScene({ ...options, mode: "ambient" });
}
