const ORIGIN="https://raw.githubusercontent.com/muyi123567/dsh-fusion-public/e8d7a19c13e5c0b4bb975ce7f21cc9d4be668487/";
const SOURCE="e8d7a19c13e5c0b4bb975ce7f21cc9d4be668487";
const FILES=new Set(["assets/TerminalWindow-Cl-oSmf4.js","assets/TerminalWindow-DFuMZ0ql.css","assets/arrow-left-zGCgGcau.js","assets/dive-BheBY-wM.css","assets/dive-DxnBhU5j.js","assets/gallery-BYt49AZO.js","assets/gallery-C9g4a-1I.css","assets/main-DRgZiBQW.js","assets/main-JdJTaHTZ.css","assets/model-B5GTD4Ci.js","assets/model-GspIlqLl.css","assets/preload-helper-DFBfmdy2.js","assets/scene-CK5RJ8Hi.js","assets/x-BCZ1D4uj.js","design-gallery.html","index.html","whale-assets/BUILD-RECEIPT.json","whale-assets/CREDITS.md","whale-assets/LICENSE.txt","whale-assets/THREE-LICENSE.txt","whale-assets/humpback-whale-light.glb","whale-assets/manifest.json","whale-assets/whale-dive-poster.jpg","whale-dive.html"]);
const MIME={html:"text/html; charset=utf-8",js:"application/javascript; charset=utf-8",css:"text/css; charset=utf-8",json:"application/json; charset=utf-8",txt:"text/plain; charset=utf-8",md:"text/plain; charset=utf-8",glb:"model/gltf-binary",jpg:"image/jpeg",png:"image/png"};
export default {
 async fetch(request){
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response("Read-only preview",{status:405,headers:{Allow:"GET, HEAD"}});
  const url=new URL(request.url);let file;
  try{file=decodeURIComponent(url.pathname).replace(/^\/+/, "")||"index.html";}catch{return new Response("Bad path",{status:400});}
  if(!FILES.has(file))return new Response("Not found",{status:404});
  try{
   const upstream=await fetch(ORIGIN+file,{method:request.method,cf:{cacheEverything:true,cacheTtl:86400}});
   if(!upstream.ok)return new Response("Preview source temporarily unavailable",{status:502});
   const type=MIME[file.split(".").pop()]||"application/octet-stream";
   const headers=new Headers({"Content-Type":type,"Cache-Control":file.startsWith("assets/")?"public,max-age=31536000,immutable":file.endsWith(".html")?"no-cache":"public,max-age=300","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'","X-Whale-Preview":"visual-prototype-no-execution-backend","X-Whale-Source":SOURCE});
   return new Response(request.method==="HEAD"?null:upstream.body,{headers});
  }catch{return new Response("Preview source temporarily unavailable",{status:502});}
 }
};
