const ORIGIN="https://raw.githubusercontent.com/muyi123567/dsh-fusion-public/1e2d9d93a525499e17c1d6aef2dd4c9305414de4/";
const FILES=new Set(["index.html","design-gallery.html","assets/TerminalWindow-CFDy4A6_.js","assets/TerminalWindow-DFuMZ0ql.css","assets/gallery-C9g4a-1I.css","assets/gallery-BZk3RUHO.js","assets/main-BOIg_7FH.css","assets/main-C0Li2UDu.js","assets/TerminalWindow-VVIX7iVa.js","assets/gallery-BCILrnqF.css","assets/gallery-DcJcihO5.js","assets/main-Bfs-kj8r.js","assets/main-CPRbr8H2.css","assets/model-BlMoKxxS.js","assets/model-GspIlqLl.css"]);
export default {
 async fetch(request){
  if(request.method!=="GET"&&request.method!=="HEAD")return new Response("Read-only preview",{status:405,headers:{Allow:"GET, HEAD"}});
  const url=new URL(request.url);
  let file;
  try{file=decodeURIComponent(url.pathname).replace(/^\/+/, "")||"index.html";}catch{return new Response("Bad path",{status:400});}
  if(!FILES.has(file))return new Response("Not found",{status:404});
  try{
   const upstream=await fetch(ORIGIN+file,{method:request.method,cf:{cacheEverything:true,cacheTtl:86400}});
   if(!upstream.ok)return new Response("Preview source temporarily unavailable",{status:502});
   const type=file.endsWith(".html")?"text/html; charset=utf-8":file.endsWith(".js")?"application/javascript; charset=utf-8":"text/css; charset=utf-8";
   const headers=new Headers({"Content-Type":type,"Cache-Control":file.startsWith("assets/")?"public,max-age=31536000,immutable":"public,max-age=300","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'","X-Whale-Preview":"synthetic-data-only","X-Whale-Source":"1e2d9d93a525499e17c1d6aef2dd4c9305414de4"});
   return new Response(request.method==="HEAD"?null:upstream.body,{headers});
  }catch{return new Response("Preview source temporarily unavailable",{status:502});}
 }
};