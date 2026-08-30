// Wendy's visage: a live holographic face rendering her real internal state.
// One HTTP endpoint serves a self-contained page; a WebSocket feeds it every
// diagnostic event plus a periodic snapshot. LAN-only by design.
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { log } from './config.js'

let wss: WebSocketServer | null = null

export function visageBroadcast(ev: string, data: Record<string, unknown>): void {
  if (!wss) return
  const payload = JSON.stringify({ ev, data, ts: Date.now() })
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(payload)
}

export function startVisage(port: number, snapshot: () => Record<string, unknown>): void {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    } else { res.writeHead(404); res.end() }
  })
  wss = new WebSocketServer({ server })
  wss.on('connection', (c) => c.send(JSON.stringify({ ev: 'snapshot', data: snapshot(), ts: Date.now() })))
  setInterval(() => visageBroadcast('snapshot', snapshot()), 2000)
  server.listen(port, '0.0.0.0', () => log(`wendy: visage live at http://0.0.0.0:${port}`))
  server.on('error', (e) => log(`wendy: visage server error: ${String(e)}`))
}

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WENDY</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#04060b;--panel:rgba(10,16,28,.72);--edge:rgba(120,150,190,.10);--txt:#c7d2e0;--mut:#5b6b80;
        --teal:#2dd4bf;--cyan:#38bdf8;--violet:#a78bfa;--pink:#f472b6;--red:#f87171;--amber:#fbbf24;--green:#34d399;}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--txt);font:12.5px/1.55 'SF Mono',ui-monospace,Menlo,monospace;overflow:hidden;height:100vh}
  #c3d{position:fixed;inset:0}
  .hud{position:fixed;z-index:2}
  .card{background:var(--panel);border:1px solid var(--edge);border-radius:14px;padding:14px 16px;backdrop-filter:blur(10px);margin-bottom:12px}
  .card h3{font-size:9.5px;letter-spacing:3px;color:var(--mut);font-weight:600;margin-bottom:10px;text-transform:uppercase}
  .kv{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12px}
  .kv span{color:var(--mut)} .kv b{color:#e8eef6;font-weight:600}
  .kv b.on{color:var(--green)} .kv b.off{color:var(--red)} .kv b.warn{color:var(--amber)}
  #left{top:22px;left:22px;width:250px}
  #right{top:22px;right:22px;width:264px}
  #title{text-align:left;margin-bottom:14px}
  #title h1{font-size:21px;letter-spacing:10px;color:#e8eef6;font-weight:700;text-shadow:0 0 30px #2dd4bf66}
  #modepill{display:inline-block;margin-top:7px;font-size:9.5px;letter-spacing:2.5px;padding:3px 12px;border-radius:20px;
            border:1px solid var(--teal);color:var(--teal);transition:all .4s;text-transform:uppercase}
  #badges{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
  .badge{font-size:9px;letter-spacing:1.5px;padding:2px 9px;border-radius:12px;border:1px solid var(--edge);color:var(--mut);display:none}
  .badge.show{display:inline-block}
  #b-mic{border-color:var(--cyan);color:var(--cyan)} #b-dnd{border-color:var(--amber);color:var(--amber)}
  #b-sil{border-color:var(--violet);color:var(--violet)} #b-vc{border-color:var(--green);color:var(--green)}
  .gauge{position:relative;width:74px;height:74px} .gauge svg{transform:rotate(-90deg)}
  .gauge .val{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .gauge .val b{font-size:14px;color:#e8eef6} .gauge .val span{font-size:8px;letter-spacing:1px;color:var(--mut)}
  #cogrow{display:flex;gap:14px;align-items:center;margin-bottom:4px}
  #spark{width:120px;height:30px}
  #tpsval{font-size:17px;font-weight:700;color:#e8eef6} #tpsval small{font-size:9px;color:var(--mut);font-weight:400}
  #turnline{margin-top:8px;padding-top:9px;border-top:1px solid var(--edge)}
  #turnstate{font-size:12px;color:var(--violet);min-height:18px}
  #toolchips{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
  .chip{font-size:9px;letter-spacing:1px;padding:2px 9px;border:1px solid var(--amber);border-radius:12px;color:var(--amber);animation:pop .25s ease}
  @keyframes pop{from{opacity:0;transform:scale(.8)}}
  #feed{max-height:38vh;overflow:hidden;display:flex;flex-direction:column;gap:6px;
        -webkit-mask-image:linear-gradient(to bottom,black 68%,transparent);mask-image:linear-gradient(to bottom,black 68%,transparent)}
  .fl{font-size:10.5px;color:#8494aa;border-left:2px solid var(--edge);padding-left:8px;animation:pop .3s ease}
  .fl b{color:#aebacc;font-weight:600} .fl time{color:#42506a;margin-right:5px;font-size:9px}
  .fl.tool{border-left-color:var(--amber)} .fl.err{border-left-color:var(--red)} .fl.err b{color:var(--red)}
  .fl.send{border-left-color:var(--cyan)}
  #convo{bottom:22px;left:50%;transform:translateX(-50%);width:min(760px,86vw)}
  .cv{display:flex;gap:12px;align-items:baseline;margin-top:6px;opacity:.45;transition:opacity .3s}
  .cv:last-child{opacity:1}
  .cv .who{font-size:9px;letter-spacing:2px;min-width:46px;text-align:right}
  .cv .txt{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .cv.heard .who{color:var(--cyan)} .cv.heard .txt{color:#bfe4f7}
  .cv.said .who{color:var(--pink)} .cv.said .txt{color:#f9d8ea}
  #offline{position:fixed;inset:0;background:#04060bd9;z-index:9;display:none;align-items:center;justify-content:center;
           font-size:13px;letter-spacing:4px;color:var(--red)}
  @media(max-width:900px){#left{display:none}#right{width:220px}}
</style></head><body>
<canvas id="c3d"></canvas>
<div id="offline">RECONNECTING…</div>
<div class="hud" id="left">
  <div id="title"><h1>WENDY</h1><div id="modepill">connecting</div>
    <div id="badges">
      <span class="badge" id="b-vc">IN VOICE</span><span class="badge" id="b-mic">MIC OPEN</span>
      <span class="badge" id="b-dnd">DND</span><span class="badge" id="b-sil">SILENCED</span>
    </div></div>
  <div class="card"><h3>Activity</h3><div id="feed"></div></div>
</div>
<div class="hud" id="right">
  <div class="card"><h3>Cognition</h3>
    <div id="cogrow">
      <div class="gauge"><svg width="74" height="74"><circle cx="37" cy="37" r="31" fill="none" stroke="#101827" stroke-width="6"/>
        <circle id="ctxarc" cx="37" cy="37" r="31" fill="none" stroke="url(#g1)" stroke-width="6" stroke-linecap="round" stroke-dasharray="194.8" stroke-dashoffset="194.8" style="transition:stroke-dashoffset .8s"/>
        <defs><linearGradient id="g1"><stop offset="0%" stop-color="#2dd4bf"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient></defs></svg>
        <div class="val"><b id="ctxpct">0%</b><span>CTX</span></div></div>
      <div><div id="tpsval">— <small>tok/s</small></div><canvas id="spark" width="240" height="60"></canvas></div>
    </div>
    <div class="kv"><span>brain</span><b id="brain" class="off">probing…</b></div>
    <div class="kv"><span>last turn</span><b id="lastturn">—</b></div>
    <div id="turnline"><div id="turnstate">idle</div><div id="toolchips"></div></div>
  </div>
  <div class="card"><h3>Memory & Work</h3>
    <div class="kv"><span>conversation</span><b id="mem">—</b></div>
    <div class="kv"><span>held for delivery</span><b id="held">—</b></div>
    <div class="kv"><span>high priority</span><b id="high">—</b></div>
    <div class="kv"><span>self-tasks</span><b id="tasks">—</b></div>
  </div>
  <div class="card"><h3>Presence</h3>
    <div class="kv"><span>state</span><b id="pmode">—</b></div>
    <div class="kv"><span>voice</span><b id="pvc">—</b></div>
    <div class="kv"><span>uptime</span><b id="pup">—</b></div>
    <div class="kv"><span>local time</span><b id="pclock">—</b></div>
  </div>
</div>
<div class="hud" id="convo"></div>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script>
const $=(id)=>document.getElementById(id)
// ═══ scene ═══════════════════════════════════════════════════
const renderer=new THREE.WebGLRenderer({canvas:$('c3d'),antialias:true,alpha:true})
const scene=new THREE.Scene(), cam=new THREE.PerspectiveCamera(42,1,.1,100); cam.position.set(0,0,9)
function fit(){renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix()}
addEventListener('resize',fit);fit()
const PAL={idle:0x2dd4bf,listen:0x38bdf8,think:0xa78bfa,speak:0xf472b6,asleep:0x27478f,down:0xf87171}
const head=new THREE.Group(); scene.add(head)
// glow texture
function glowTex(){const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d')
  const r=g.createRadialGradient(64,64,4,64,64,62);r.addColorStop(0,'rgba(255,255,255,.95)');r.addColorStop(.35,'rgba(255,255,255,.28)');r.addColorStop(1,'transparent')
  g.fillStyle=r;g.fillRect(0,0,128,128);return new THREE.CanvasTexture(c)}
const GT=glowTex()
// head shell: hologram point cloud (denser toward the face)
const HN=2600,hp=new Float32Array(HN*3),hseed=[]
for(let i=0;i<HN;i++){let t=Math.random()*Math.PI*2,p=Math.acos(2*Math.random()-1)
  if(Math.sin(p)*Math.sin(t)<0&&Math.random()<.55){t=-t} // bias points to front
  hseed.push({t,p,r:2.15+Math.random()*.06,j:Math.random()*6.28})
  hp.set([0,0,0],i*3)}
const hgeo=new THREE.BufferGeometry();hgeo.setAttribute('position',new THREE.BufferAttribute(hp,3))
const hmat=new THREE.PointsMaterial({color:PAL.idle,size:.022,transparent:true,opacity:.52,map:GT,alphaTest:.02,blending:THREE.AdditiveBlending,depthWrite:false})
head.add(new THREE.Points(hgeo,hmat))
// aura ring
const AN=500,ap=new Float32Array(AN*3),aseed=[]
for(let i=0;i<AN;i++){aseed.push({r:3.1+Math.random()*1.6,t:Math.random()*6.28,y:(Math.random()-.5)*3.4,s:.001+Math.random()*.004});ap.set([0,0,0],i*3)}
const ageo=new THREE.BufferGeometry();ageo.setAttribute('position',new THREE.BufferAttribute(ap,3))
const amat=new THREE.PointsMaterial({color:PAL.idle,size:.03,transparent:true,opacity:.35,map:GT,alphaTest:.02,blending:THREE.AdditiveBlending,depthWrite:false})
scene.add(new THREE.Points(ageo,amat))
// eyes
function makeEye(x){const g=new THREE.Group()
  const iris=new THREE.Mesh(new THREE.CircleGeometry(.17,32),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.95}))
  const ring=new THREE.Mesh(new THREE.RingGeometry(.2,.25,32),new THREE.MeshBasicMaterial({color:PAL.idle,transparent:true,opacity:.9,side:THREE.DoubleSide}))
  const pupil=new THREE.Mesh(new THREE.CircleGeometry(.075,24),new THREE.MeshBasicMaterial({color:0x04060b}))
  pupil.position.z=.01
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:GT,color:PAL.idle,transparent:true,opacity:.5,blending:THREE.AdditiveBlending,depthWrite:false}))
  glow.scale.setScalar(1.15)
  g.add(glow,iris,ring,pupil); g.position.set(x,.42,1.95); head.add(g)
  return {g,pupil,ring,glow,iris}}
const eyeL=makeEye(-.72),eyeR=makeEye(.72)
// brows
function makeBrow(x){const m=new THREE.Mesh(new THREE.BoxGeometry(.52,.05,.03),new THREE.MeshBasicMaterial({color:PAL.idle,transparent:true,opacity:.85}))
  m.position.set(x,.86,1.95);head.add(m);return m}
const browL=makeBrow(-.72),browR=makeBrow(.72)
// mouth: two dotted lip curves
const MK=30
const lipMat=new THREE.MeshBasicMaterial({color:PAL.idle,transparent:true,opacity:.9,blending:THREE.AdditiveBlending,depthWrite:false})
const lipGeom=new THREE.SphereGeometry(.032,8,8)
const lips=[]
for(let r=0;r<2;r++)for(let i=0;i<MK;i++){const m=new THREE.Mesh(lipGeom,lipMat);head.add(m);lips.push(m)}
const mouthGlow=new THREE.Sprite(new THREE.SpriteMaterial({map:GT,color:PAL.idle,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false}))
mouthGlow.position.set(0,-.62,1.9);mouthGlow.scale.set(2.2,1.1,1);head.add(mouthGlow)
// ═══ expression state machine ════════════════════════════════
const EXPR={
  idle:  {smile:.16,open:0,  browY:0,  browTilt:0,  lookX:0,  lookY:0,  lean:0,   energy:.22},
  listen:{smile:.10,open:.12,browY:.06,browTilt:0,  lookX:0,  lookY:.04,lean:.10, energy:.6},
  think: {smile:.02,open:.03,browY:.10,browTilt:.22,lookX:.6, lookY:.5, lean:-.04,energy:1},
  speak: {smile:.12,open:1,  browY:.03,browTilt:0,  lookX:0,  lookY:0,  lean:.04, energy:.85},
  asleep:{smile:.05,open:.05,browY:-.04,browTilt:0, lookX:0,  lookY:-.3,lean:.12, energy:.05},
  down:  {smile:-.22,open:.02,browY:-.09,browTilt:-.3,lookX:0,lookY:-.2,lean:.16, energy:.1}}
let state='idle',cur=Object.assign({},EXPR.idle),hue=new THREE.Color(PAL.idle),speakUntil=0,blink=1,nextBlink=2,lookJit={x:0,y:0},nextJit=0
function setState(s){if(state===s)return;state=s
  hue=new THREE.Color(PAL[s]||PAL.idle)
  const pill=$('modepill'),c='#'+hue.getHexString()
  pill.style.borderColor=c;pill.style.color=c
  pill.textContent={idle:'awake',listen:'listening',think:'thinking',speak:'speaking',asleep:'asleep',down:'brain down'}[s]||s}
// ═══ render loop ═════════════════════════════════════════════
let t0=performance.now()
function loop(now){const dt=Math.min((now-t0)/1000,.1);t0=now;const T=now/1000
  const tgt=EXPR[state]||EXPR.idle
  for(const k in cur)cur[k]+=(tgt[k]-cur[k])*Math.min(dt*5,1)
  // blink
  nextBlink-=dt
  if(nextBlink<=0){nextBlink=(state==='asleep')?9:1.8+Math.random()*4;blink=0}
  blink+=(1-blink)*Math.min(dt*11,1)
  const lid=state==='asleep'?.12:.12+blink*.88
  // eye look: darting when thinking
  nextJit-=dt
  if(nextJit<=0){nextJit=state==='think'?.5+Math.random()*.8:2+Math.random()*3
    lookJit.x=(Math.random()-.5)*(state==='think'?1.6:.5);lookJit.y=(Math.random()-.4)*(state==='think'?1:.35)}
  const lx=cur.lookX*lookJit.x*.14+cur.lookX*.02, ly=cur.lookY*lookJit.y*.12
  for(const e of [eyeL,eyeR]){e.g.scale.y=lid;e.pupil.position.x+=(lx-e.pupil.position.x)*dt*8;e.pupil.position.y+=(ly-e.pupil.position.y)*dt*8}
  // brows
  browL.position.y=.86+cur.browY;browR.position.y=.86+cur.browY
  browL.rotation.z=cur.browTilt*.5+ .06;browR.rotation.z=-cur.browTilt-.06
  // mouth: syllable noise while speaking
  let open=cur.open
  if(state==='speak'){const syl=Math.max(0,Math.sin(T*11.5)+.55*Math.sin(T*7.3)+.3*Math.sin(T*17.1))
    open=cur.open*(0.12+.55*syl)}
  const y0=-.62,zf=1.92
  for(let i=0;i<MK;i++){const t=i/(MK-1)*2-1,q=t*t
    const cornerY=y0+cur.smile*.22
    const yU=(y0+.025+open*.06)*(1-q)+cornerY*q
    const yL=(y0-.035-open*.42)*(1-q)+cornerY*q
    const x=t*.62,z=zf+(1-q)*.12
    lips[i].position.set(x,yU,z);lips[MK+i].position.set(x,yL,z)
    const sc=.7+(1-q)*.5;lips[i].scale.setScalar(sc);lips[MK+i].scale.setScalar(sc)}
  mouthGlow.material.opacity=.15+open*.3
  // head shell shimmer
  const harr=hgeo.attributes.position.array
  for(let i=0;i<HN;i++){const s=hseed[i],w=Math.sin(T*1.4+s.j)*.02
    const r=s.r+w+cur.energy*.03*Math.sin(T*6+s.j*3)
    harr[i*3]=r*Math.sin(s.p)*Math.cos(s.t)
    harr[i*3+1]=r*Math.cos(s.p)*1.18
    harr[i*3+2]=r*Math.sin(s.p)*Math.sin(s.t)*.92}
  hgeo.attributes.position.needsUpdate=true
  // aura swirl
  const aarr=ageo.attributes.position.array
  for(let i=0;i<AN;i++){const s=aseed[i];s.t+=s.s*(1+cur.energy*(state==='think'?14:4))
    aarr[i*3]=s.r*Math.cos(s.t);aarr[i*3+1]=s.y+Math.sin(T*.7+i)*.08;aarr[i*3+2]=s.r*Math.sin(s.t)*.5-1}
  ageo.attributes.position.needsUpdate=true
  // head motion
  head.rotation.y=Math.sin(T*.4)*.07+(state==='think'?Math.sin(T*.9)*.05:0)
  head.rotation.x=cur.lean*.4+Math.sin(T*.55)*.02+(state==='speak'?Math.sin(T*5.2)*.012:0)
  head.rotation.z=state==='think'?.05:0
  head.position.y=Math.sin(T*.8)*.05
  // colors
  ;[hmat,amat,lipMat].forEach(m=>m.color.lerp(hue,Math.min(dt*4,1)))
  for(const e of [eyeL,eyeR]){e.ring.material.color.lerp(hue,dt*4);e.glow.material.color.lerp(hue,dt*4)}
  browL.material.color.lerp(hue,dt*4);mouthGlow.material.color.lerp(hue,dt*4)
  hmat.opacity=.35+cur.energy*.3;amat.opacity=.18+cur.energy*.3
  if(state==='speak'&&now>speakUntil)setState('idle')
  renderer.render(scene,cam);requestAnimationFrame(loop)}
requestAnimationFrame(loop)
// ═══ metrics & feed ══════════════════════════════════════════
const esc=(s)=>String(s??'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))
const tpsHist=[]
function drawSpark(){const c=$('spark'),g=c.getContext('2d');g.clearRect(0,0,c.width,c.height)
  if(tpsHist.length<2)return;const mx=Math.max(...tpsHist)*1.15||1
  g.beginPath();g.strokeStyle='#2dd4bf';g.lineWidth=2.5
  tpsHist.forEach((v,i)=>{const x=i/(tpsHist.length-1)*c.width,y=c.height-4-(v/mx)*(c.height-8)
    i?g.lineTo(x,y):g.moveTo(x,y)});g.stroke()
  g.lineTo(c.width,c.height);g.lineTo(0,c.height);g.closePath()
  const gr=g.createLinearGradient(0,0,0,c.height);gr.addColorStop(0,'#2dd4bf33');gr.addColorStop(1,'transparent')
  g.fillStyle=gr;g.fill()}
function feed(cls,html){const d=document.createElement('div');d.className='fl '+cls
  const t=new Date();d.innerHTML='<time>'+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+'</time>'+html
  const f=$('feed');f.prepend(d);while(f.children.length>18)f.lastChild.remove()}
const convo=[]
function pushConvo(who,txt){convo.push({who,txt});while(convo.length>4)convo.shift()
  $('convo').innerHTML=convo.map(c=>'<div class="cv '+c.who+'"><span class="who">'+c.who.toUpperCase()+'</span><span class="txt">'+esc(c.txt)+'</span></div>').join('')}
function fmtUp(s){const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m+'m'}
setInterval(()=>{$('pclock').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})},1000)
let thinkT0=0,turnTimer=null
function startTurnClock(){if(turnTimer)return;thinkT0=Date.now()
  turnTimer=setInterval(()=>{$('turnstate').textContent=$('turnstate').dataset.base+' · '+((Date.now()-thinkT0)/1000).toFixed(0)+'s'},250)}
function stopTurnClock(final){clearInterval(turnTimer);turnTimer=null
  if(final!=null)$('lastturn').textContent=(final/1000).toFixed(1)+'s'
  $('turnstate').dataset.base='idle';$('turnstate').textContent='idle';$('toolchips').innerHTML=''}
$('turnstate').dataset.base='idle'
// ═══ websocket ═══════════════════════════════════════════════
function connect(){
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host)
  ws.onclose=()=>{$('offline').style.display='flex';setTimeout(connect,2000)}
  ws.onopen=()=>{$('offline').style.display='none'}
  ws.onmessage=(m)=>{const {ev,data}=JSON.parse(m.data)
    if(ev==='snapshot'){
      const up=data.brainUp
      $('brain').textContent=up?'online':'offline';$('brain').className=up?'on':'off'
      if(data.tps){$('tpsval').innerHTML=data.tps+' <small>tok/s</small>';tpsHist.push(data.tps);while(tpsHist.length>48)tpsHist.shift();drawSpark()}
      const cp=data.ctxPct??0
      $('ctxpct').textContent=cp+'%';$('ctxarc').style.strokeDashoffset=String(194.8*(1-Math.min(cp,100)/100))
      $('mem').textContent=data.history+' msgs'
      $('held').textContent=String(data.held??0);$('held').className=(data.held>8)?'warn':''
      $('high').textContent=String(data.updates?.high??0);$('high').className=(data.updates?.high>0)?'warn':''
      if(data.selfTasks)$('tasks').textContent=data.selfTasks.active+' active · '+data.selfTasks.done+' done'
      $('pmode').textContent=String(data.mode||'—').toLowerCase()
      $('pvc').textContent=data.inVc?'in channel':'not connected';$('pvc').className=data.inVc?'on':''
      if(data.up!=null)$('pup').textContent=fmtUp(data.up)
      $('b-vc').classList.toggle('show',!!data.inVc)
      $('b-dnd').classList.toggle('show',!!data.dnd)
      $('b-sil').classList.toggle('show',data.silencedMin>0)
      if(data.silencedMin>0)$('b-sil').textContent='SILENCED '+data.silencedMin+'m'
      if(data.mode==='ASLEEP')setState('asleep')
      else if(!up)setState('down')
      else if(state==='asleep'||state==='down')setState('idle')
      return}
    if(ev==='listening'){$('b-mic').classList.add('show');if(state!=='think')setState('listen')}
    if(ev==='listening_end'){$('b-mic').classList.remove('show');if(state==='listen')setState('idle')}
    if(ev==='owner_said'&&data.text&&!String(data.text).startsWith('[')){pushConvo('heard',data.text);setState('think');startTurnClock();$('turnstate').dataset.base='working'}
    if(ev==='brain'){setState('think');startTurnClock()
      const base='hop '+((data.hop??0)+1)+(data.tools?.length?' · '+data.tools.join(' · '):'')
      $('turnstate').dataset.base=base
      if(data.tools?.length){$('toolchips').innerHTML=data.tools.map(n=>'<span class="chip">'+esc(n)+'</span>').join('')}}
    if(ev==='tool')feed('tool','<b>'+esc(data.name)+'</b> '+esc(JSON.stringify(data.args||{}).slice(0,70)))
    if(ev==='tool_error')feed('err','<b>'+esc(data.name)+' failed</b>')
    if(ev==='speak'&&data.text){setState('speak');speakUntil=performance.now()+Math.min(1800+String(data.text).length*52,22000);pushConvo('said',data.text)}
    if(ev==='turn_done'){stopTurnClock(data.ms);if(state==='think')setState('idle')}
    if(ev==='turn_skipped'){stopTurnClock(null);if(state==='think')setState('idle')}
    if(ev==='announce')feed('send','<b>queued</b> '+esc(String(data.text||'').slice(0,70)))
    if(ev==='duplicate_send_blocked')feed('err','<b>duplicate send blocked</b>')
    if(ev==='send_claim_unbacked')feed('err','<b>unbacked send claim caught</b>')
    if(ev==='bg_delivery')feed('send','<b>delivered update to owner</b>')
  }}
connect()
</script></body></html>`
