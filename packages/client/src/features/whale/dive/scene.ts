import * as THREE from "three";
import type { HabitatActivity } from "../ambient/contracts.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const DIVE_DURATION = 36;
export type DiveScene = { render: (seconds:number) => void; resize:()=>void; metrics:()=>{calls:number;triangles:number;geometries:number;textures:number;programs:number}; dispose:()=>void; };
type Options = { ambient?: boolean; canvas:HTMLCanvasElement; assetUrl:string; onReady:()=>void; onError:(error:Error)=>void; };
const clamp=THREE.MathUtils.clamp;
const smooth=(a:number,b:number,x:number)=>THREE.MathUtils.smoothstep(x,a,b);
const WATER_Y=5.4;

/** Real mesh + procedural deformation. Visual simulation, not a fluid solver. */
export function createDiveScene({canvas,assetUrl,onReady,onError,ambient=false}:Options):DiveScene {
 const renderer = new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:"low-power"});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));
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
 scene.add(new THREE.Mesh(volumeGeometry,volumeMaterial));resources.push(volumeGeometry,volumeMaterial);

 // Displaced, translucent water ceiling. Directional caustics are computed in world space.
 const waterGeometry=new THREE.PlaneGeometry(210,210,112,112);
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
 for(let i=0;i<9;i++){
  const beam=new THREE.Mesh(beamGeometry,beamMaterial);
  beam.position.set(-15+i*3.8,-7,-18-i%3*5);
  beam.scale.set(3+i%3*2,37,1);beam.rotation.z=-.26;
  scene.add(beam);
 }

 // Deterministic suspended particles: stable replay, no per-frame allocations.
 const count=520,positions=new Float32Array(count*3),sizes=new Float32Array(count);
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
 const dust=new THREE.Points(dustGeometry,dustMaterial);scene.add(dust);resources.push(dustGeometry,dustMaterial);

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

 const releaseModel=(root:THREE.Object3D)=>{
  root.traverse(object=>{
   if(!(object instanceof THREE.Mesh))return;
   object.geometry.dispose();
   const materials=Array.isArray(object.material)?object.material:[object.material];
   for(const material of materials){
    for(const value of Object.values(material))if(value instanceof THREE.Texture){value.dispose();const source=value.source?.data;if(source&&typeof source.close==="function")source.close();}
    material.dispose();
   }
  });
 };
 const loader=new GLTFLoader();
 loader.load(assetUrl,gltf=>{
  if(disposed){releaseModel(gltf.scene);return;}
  whale=gltf.scene;
  const bounds=new THREE.Box3().setFromObject(whale);
  const center=bounds.getCenter(new THREE.Vector3());
  whale.position.sub(center);
  whaleRoot.add(whale);
  whale.traverse(object=>{
   if(!(object instanceof THREE.Mesh))return;
   const materials=Array.isArray(object.material)?object.material:[object.material];
   for(const material of materials){
    if(!(material instanceof THREE.MeshStandardMaterial))continue;
    material.roughness=.66;material.metalness=.02;
    material.onBeforeCompile=shader=>{
     shader.uniforms.uSwimTime=clock;
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
  onReady();
 },undefined,error=>{if(!disposed)onError(error instanceof Error?error:new Error("鲸模型加载失败"));});

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
   whaleRoot.position.x+=Math.sin(seconds*.075)*1.1;
   whaleRoot.position.y+=Math.sin(seconds*.13)*.16;
   whaleRoot.rotation.y+=Math.sin(seconds*.075)*.08;
  }
  renderer.render(scene,camera);
 }
 const contextLost=(event:Event)=>{event.preventDefault();if(!disposed)onError(new Error("3D 画面连接中断，请重新载入。"));};
 canvas.addEventListener("webglcontextlost",contextLost);
 resize();
 return {render,resize,metrics:()=>({
  calls:renderer.info.render.calls, triangles:renderer.info.render.triangles,
  geometries:renderer.info.memory.geometries, textures:renderer.info.memory.textures,
  programs:renderer.info.programs?.length ?? 0
 }),dispose(){
  if(disposed)return;disposed=true;
  canvas.removeEventListener("webglcontextlost",contextLost);
  if(whale)releaseModel(whale);
  for(const resource of resources)resource.dispose();
  scene.clear();renderer.dispose();renderer.forceContextLoss();
 }};
}


// Ambient lifecycle adapter shares the existing renderer and asset disposal.
export type AmbientScene = DiveScene & { setActivity: (activity: HabitatActivity) => void };
export function createAmbientScene(options: Options & { activity: HabitatActivity }): AmbientScene {
 let activity = options.activity;
 let previous = 0, swimTime = 0;
 const scene = createDiveScene({ ...options, ambient: true });
 return {
  ...scene,
  setActivity(next) { activity = next; },
  render(seconds) {
   // Integrate activity speed rather than rescaling absolute time (which jumps).
   const speed = activity.observed && activity.active > 0 ? 1.08 : 1;
   swimTime += Math.max(0, seconds - previous) * speed;
   previous = seconds;
   scene.render(swimTime);
  },
 };
}
