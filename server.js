#!/usr/bin/env node
/* Serveur autonome des questionnaires (Node >= 18 ou Bun, aucune dépendance).
   Lancer :  ADMIN_PW="votre-mot-de-passe" PORT=3000 node server.js
   Les données sont dans ./data/db.json (sauvegardez ce dossier). */
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=+process.env.PORT||3000,PW=process.env.ADMIN_PW||"admin2026",DIR=process.env.DATA_DIR||path.join(__dirname,"data"),FILE=path.join(DIR,"db.json"),BACKUP_DIR=path.join(DIR,"backups"),TP=process.env.TRUST_PROXY==="1";
fs.mkdirSync(DIR,{recursive:true});
fs.mkdirSync(BACKUP_DIR,{recursive:true});

// 1. Mise en cache de index.html au démarrage
let indexHtml="";
try{indexHtml=fs.readFileSync(path.join(__dirname,"index.html"),"utf8")}catch(e){console.error("Erreur chargement index.html:",e.message)}

const COLS=["entree","sortie","satisfaction","config"],DEF={entree:"ABCDABCDABCDABCDABCD",sortie:"DCBADCBADCBADCBADCBA"};
let db={},ver={};try{db=JSON.parse(fs.readFileSync(FILE,"utf8"))}catch(e){}
COLS.forEach(c=>{db[c]=db[c]||{};ver[c]=Date.now()});
let SECRET;const SF=path.join(DIR,"secret");try{SECRET=fs.readFileSync(SF,"utf8")}catch(e){SECRET=crypto.randomBytes(32).toString("hex");fs.writeFileSync(SF,SECRET,{mode:0o600})}
const HM=e=>crypto.createHmac("sha256",SECRET).update(String(e)).digest("hex"),mk=()=>{const e=Date.now()+12*36e5;return e+"."+HM(e)},
 isAdm=req=>{const [e,s]=(String(req.headers.authorization||"").replace(/^Bearer /,"")).split(".");if(!e||!s||+e<Date.now())return false;const x=HM(e);return s.length===x.length&&crypto.timingSafeEqual(Buffer.from(s),Buffer.from(x))};

// 2. Nettoyage périodique du rate limiter (IP inactives depuis plus de 5 minutes)
const fails={};
setInterval(()=>{
 const now=Date.now();
 for(const ip in fails){if(now-fails[ip].t>3e5)delete fails[ip]}
},6e4).unref?.();

// 3. Rotation des sauvegardes datées de db.json
let lastBackupHour="";
async function backupDb(){
 try{
  if(!fs.existsSync(FILE))return;
  const d=new Date().toISOString().replace(/[:.]/g,"-").slice(0,13); // format YYYY-MM-DDTHH
  if(d===lastBackupHour)return;
  lastBackupHour=d;
  await fs.promises.copyFile(FILE,path.join(BACKUP_DIR,`db-${d}.json`));
  const list=(await fs.promises.readdir(BACKUP_DIR)).filter(f=>f.startsWith("db-")&&f.endsWith(".json")).sort();
  while(list.length>48){
   const old=list.shift();
   await fs.promises.unlink(path.join(BACKUP_DIR,old)).catch(()=>{});
  }
 }catch(e){console.error("backup error",e)}
}

/* écriture disque atomique, groupée : plusieurs envois simultanés partagent une même écriture ;
   la réponse HTTP n'est envoyée qu'une fois les données sur le disque */
let waiters=[],busy=false;
const persist=()=>new Promise((ok,ko)=>{waiters.push({ok,ko});if(!busy)flush()});
async function flush(){
 busy=true;
 while(waiters.length){
  const w=waiters;waiters=[];
  try{
   await backupDb();
   const t=FILE+".tmp";
   await fs.promises.writeFile(t,JSON.stringify(db));
   await fs.promises.rename(t,FILE);
   w.forEach(x=>x.ok())
  }catch(e){console.error("persist",e);w.forEach(x=>x.ko(e))}
 }
 busy=false
}

const send=(res,code,o)=>{const s=typeof o==="string";res.writeHead(code,{"Content-Type":s?"text/html; charset=utf-8":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(s?o:JSON.stringify(o))};
const body=req=>new Promise((ok,ko)=>{let n=0;const a=[];req.on("data",d=>{n+=d.length;if(n>2e5){ko(new Error("big"));req.destroy()}else a.push(d)});req.on("end",()=>{try{ok(JSON.parse(Buffer.concat(a).toString()||"{}"))}catch(e){ko(e)}});req.on("error",ko)});
const r2=x=>Math.round(x*100)/100,str=(v,n)=>typeof v==="string"?v.slice(0,n):"",int=v=>Number.isInteger(v)?v:null,
 arr=(a,n,lo,hi)=>Array.isArray(a)&&a.length===n&&a.every(x=>x===null||(Number.isInteger(x)&&x>=lo&&x<=hi)),
 list=(a,n,f)=>(Array.isArray(a)?a:[]).slice(0,n).map(f);

function clean(c,b){
 if(!b||typeof b!=="object"||b.type!==c||typeof b.date!=="string"||isNaN(Date.parse(b.date)))return null;
 if(c==="satisfaction"){const ben=b.prof!==2;
  if(!arr(b.g,4,0,5)||!arr(b.d,21,0,5)||!arr(b.t,4,1,3)||!Number.isInteger(b.s)||b.s<0||b.s>10||(ben&&(!arr(b.l,4,1,3)||!arr(b.r,8,1,4))))return null;
  return{type:c,date:b.date,structure:str(b.structure,120),fonction:int(b.fonction),exp:int(b.exp),sexe:int(b.sexe),prof:ben?1:2,g:b.g,d:b.d,t:b.t,l:ben?b.l:[],r:ben?b.r:[],a:ben?list(b.a,2,x=>str(x,200)):[],b:ben?list(b.b,2,x=>int(x)).filter(x=>x!==null):[],bo:ben?str(b.bo,120):"",o:list(b.o,4,x=>str(x,600)),s:b.s}}
 const nom=str(b.nom,120).trim();if(!nom||typeof b.reponses!=="string"||!/^[ABCD?]{20}$/.test(b.reponses))return null;
 const cf=db.config.points||{},K=cf.key&&typeof cf.key[c]==="string"&&cf.key[c].length===20?cf.key[c]:DEF[c],P=Array.isArray(cf[c])&&cf[c].length===20?cf[c].map(Number):Array(20).fill(1);
 return{type:c,nom,entreprise:str(b.entreprise,120),reponses:b.reponses,score:r2(P.reduce((s,p,i)=>s+(b.reponses[i]===K[i]?p:0),0)),max:r2(P.reduce((s,p)=>s+p,0)),date:b.date,duree:Number.isFinite(b.duree)?Math.max(0,Math.round(b.duree)):0}}

const srv=http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,"http://x"),p=u.pathname;
 // 4. Extraction sécurisée de l'IP : X-Forwarded-For uniquement si TRUST_PROXY=1
 const rawFwd=TP?req.headers["x-forwarded-for"]:null;
 const ip=(typeof rawFwd==="string"?rawFwd.split(",")[0].trim():"")||req.socket.remoteAddress;

 if(req.method==="GET"&&(p==="/"||p==="/index.html")){
  if(!indexHtml)return send(res,500,{error:"index.html missing"});
  return send(res,200,indexHtml);
 }
 if(p==="/api/ping")return send(res,200,{ok:true});
 if(p==="/api/login"&&req.method==="POST"){const f=fails[ip]=(fails[ip]&&Date.now()-fails[ip].t<3e5)?fails[ip]:{n:0,t:Date.now()};
  if(f.n>=8)return send(res,429,{error:"throttled"});const b=await body(req);
  const a=crypto.createHash("sha256").update(String(b.pw||"")).digest(),w=crypto.createHash("sha256").update(PW).digest();
  if(!crypto.timingSafeEqual(a,w)){f.n++;return send(res,401,{error:"bad password"})}f.n=0;return send(res,200,{token:mk()})}
 let m=p.match(/^\/api\/c\/(\w+)(?:\/([\w-]{1,64}))?$/);
 if(!m||!COLS.includes(m[1]))return send(res,404,{error:"not found"});const c=m[1],id=m[2];
 if(req.method==="GET"&&!id){if(!isAdm(req))return send(res,401,{error:"auth"});const v=+u.searchParams.get("v")||0;return send(res,200,v===ver[c]?{v}:{v:ver[c],docs:db[c]})}
 if(req.method==="GET"){if(c!=="config"&&!isAdm(req))return send(res,401,{error:"auth"});const d=db[c][id];return send(res,200,{exists:d!==undefined,data:d})}
 if(req.method==="PUT"&&id){const b=await body(req);let rec;
  if(c==="config"){if(!isAdm(req))return send(res,401,{error:"auth"});if(!["points","etat"].includes(id)||!b||typeof b!=="object")return send(res,400,{error:"invalid"});rec=b}
  else{const e=db.config.etat;if(e&&e[c]===false)return send(res,403,{error:"closed"});rec=clean(c,b);if(!rec)return send(res,400,{error:"invalid"});
   const old=db[c][id];if(old)return old.date===rec.date?send(res,200,{ok:true,dup:true}):send(res,409,{error:"exists"})}
  db[c][id]=rec;ver[c]++;await persist();return send(res,200,{ok:true})}
 send(res,405,{error:"method"})}catch(e){send(res,e.message==="big"?413:e instanceof SyntaxError?400:500,{error:"bad request"})}});
srv.listen(PORT,()=>console.log("Questionnaires : http://localhost:"+PORT+(PW==="admin2026"?"  (ATTENTION : changez ADMIN_PW)":"")));
process.on("SIGTERM",()=>{const w=()=>busy?setTimeout(w,50):process.exit(0);w()});
