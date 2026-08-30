// Wendy's visage: a live dashboard rendering her real internal state.
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
  :root { --teal:#2dd4bf; --cyan:#22d3ee; --violet:#a78bfa; --rose:#fb7185; --amber:#fbbf24; --dim:#334155; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#05070c; color:#cbd5e1; font:13px/1.5 'SF Mono',ui-monospace,Menlo,monospace; overflow:hidden; height:100vh; }
  #c3d { position:fixed; inset:0; }
  .hud { position:fixed; z-index:2; }
  #state { top:26px; left:50%; transform:translateX(-50%); text-align:center; }
  #mode { font-size:26px; letter-spacing:14px; font-weight:700; color:var(--teal); text-shadow:0 0 24px currentColor; transition:color .4s; }
  #sub { margin-top:6px; font-size:11px; letter-spacing:3px; color:#64748b; text-transform:uppercase; min-height:16px; }
  #stats { top:24px; right:26px; width:230px; }
  .stat { display:flex; justify-content:space-between; margin-bottom:7px; font-size:11.5px; }
  .stat b { color:#e2e8f0; font-weight:600; }
  .bar { height:4px; background:#101827; border-radius:2px; margin:3px 0 10px; overflow:hidden; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,var(--teal),var(--cyan)); border-radius:2px; width:0%; transition:width .8s; }
  #dotbrain { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--dim); margin-right:6px; }
  #log { bottom:118px; left:26px; width:min(430px,44vw); display:flex; flex-direction:column-reverse; gap:5px; max-height:46vh; overflow:hidden;
         -webkit-mask-image:linear-gradient(to top,black 62%,transparent); mask-image:linear-gradient(to top,black 62%,transparent); }
  .ln { font-size:11px; color:#475569; animation:in .3s ease; }
  .ln b { color:#94a3b8; font-weight:600; }
  .ln.tool b { color:var(--amber); } .ln.err b { color:var(--rose); }
  @keyframes in { from { opacity:0; transform:translateY(6px); } }
  #ticker { bottom:26px; left:26px; right:26px; }
  .trow { display:flex; gap:12px; margin-top:8px; align-items:baseline; }
  .twho { font-size:10px; letter-spacing:2px; color:#64748b; min-width:52px; text-align:right; }
  .ttxt { font-size:13px; color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
  #heard .ttxt { color:#7dd3fc; } #said .ttxt { color:#f0abfc; }
  #tools { top:96px; left:50%; transform:translateX(-50%); display:flex; gap:8px; }
  .chip { font-size:10px; letter-spacing:1.5px; padding:3px 12px; border:1px solid var(--amber); border-radius:20px; color:var(--amber);
          animation:in .25s ease; text-transform:uppercase; box-shadow:0 0 14px #fbbf2433; }
</style></head><body>
<canvas id="c3d"></canvas>
<div class="hud" id="state"><div id="mode">WENDY</div><div id="sub">connecting…</div></div>
<div class="hud" id="tools"></div>
<div class="hud" id="stats">
  <div class="stat"><span><span id="dotbrain"></span>brain</span><b id="tps">—</b></div>
  <div class="stat"><span>context</span><b id="ctx">—</b></div><div class="bar"><i id="ctxbar"></i></div>
  <div class="stat"><span>memory</span><b id="mem">—</b></div>
  <div class="stat"><span>held items</span><b id="held">—</b></div>
  <div class="stat"><span>self-tasks</span><b id="tasks">—</b></div>
  <div class="stat"><span>turn</span><b id="turn">idle</b></div>
</div>
<div class="hud" id="log"></div>
<div class="hud" id="ticker">
  <div class="trow" id="heard"><span class="twho">HEARD</span><span class="ttxt">—</span></div>
  <div class="trow" id="said"><span class="twho">SAID</span><span class="ttxt">—</span></div>
</div>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script>
const $=(id)=>document.getElementById(id)
// ── three scene ──────────────────────────────────────────────
const canvas=$('c3d'), renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true})
const scene=new THREE.Scene(), cam=new THREE.PerspectiveCamera(50,1,0.1,100); cam.position.z=7
const COL={idle:0x2dd4bf,listen:0x22d3ee,think:0xa78bfa,speak:0xf0abfc,asleep:0x1e3a5f,down:0x7f1d1d}
const core=new THREE.Mesh(new THREE.IcosahedronGeometry(1.6,1),new THREE.MeshBasicMaterial({color:COL.idle,wireframe:true,transparent:true,opacity:.85}))
const inner=new THREE.Mesh(new THREE.IcosahedronGeometry(1.05,2),new THREE.MeshBasicMaterial({color:COL.idle,wireframe:true,transparent:true,opacity:.22}))
scene.add(core,inner)
const N=900, pos=new Float32Array(N*3), seed=[]
for(let i=0;i<N;i++){const r=2.6+Math.random()*2.2,t=Math.random()*Math.PI*2,p=Math.acos(2*Math.random()-1)
  seed.push({r,t,p,s:.0004+Math.random()*.0018}); pos.set([0,0,0],i*3)}
const pg=new THREE.BufferGeometry(); pg.setAttribute('position',new THREE.BufferAttribute(pos,3))
const pts=new THREE.Points(pg,new THREE.PointsMaterial({color:COL.idle,size:.035,transparent:true,opacity:.7}))
scene.add(pts)
function fit(){const w=innerWidth,h=innerHeight;renderer.setSize(w,h);renderer.setPixelRatio(Math.min(devicePixelRatio,2));cam.aspect=w/h;cam.updateProjectionMatrix()}
addEventListener('resize',fit); fit()
// ── state ────────────────────────────────────────────────────
let state='idle', speakUntil=0, energy=0, target=0, hue=new THREE.Color(COL.idle)
function setState(s){state=s
  const c={idle:COL.idle,listen:COL.listen,think:COL.think,speak:COL.speak,asleep:COL.asleep,down:COL.down}[s]||COL.idle
  hue=new THREE.Color(c)
  $('mode').style.color='#'+hue.getHexString()
  $('mode').textContent={idle:'WENDY',listen:'LISTENING',think:'THINKING',speak:'SPEAKING',asleep:'ASLEEP',down:'BRAIN DOWN'}[s]||'WENDY'
  target={idle:.25,listen:.75,think:1,speak:.9,asleep:.06,down:.1}[s]??.25
}
setState('idle')
let t0=performance.now()
function loop(now){const dt=(now-t0)/1000;t0=now
  energy+=(target-energy)*Math.min(dt*3,1)
  const spin={think:2.2,speak:1.1,listen:.7}[state]||.25
  core.rotation.y+=dt*spin*.6; core.rotation.x+=dt*spin*.22; inner.rotation.y-=dt*spin*.8
  const breathe=1+Math.sin(now/900)*.03+energy*.12*Math.sin(now/140)*(state==='speak'?1:.3)
  core.scale.setScalar(breathe); inner.scale.setScalar(breathe*.96)
  ;[core.material,inner.material,pts.material].forEach(m=>m.color.lerp(hue,Math.min(dt*4,1)))
  const arr=pg.attributes.position.array
  for(let i=0;i<N;i++){const s=seed[i]; s.t+=s.s*(1+energy*(state==='think'?26:7))
    const r=s.r-energy*1.1
    arr[i*3]=r*Math.sin(s.p)*Math.cos(s.t); arr[i*3+1]=r*Math.cos(s.p)+Math.sin(now/1200+i)*.05; arr[i*3+2]=r*Math.sin(s.p)*Math.sin(s.t)}
  pg.attributes.position.needsUpdate=true
  pts.material.opacity=.25+energy*.6
  if(state==='speak'&&now>speakUntil)setState('idle')
  renderer.render(scene,cam); requestAnimationFrame(loop)}
requestAnimationFrame(loop)
// ── feed ─────────────────────────────────────────────────────
function line(cls,html){const d=document.createElement('div');d.className='ln '+cls;d.innerHTML=html
  const l=$('log');l.prepend(d);while(l.children.length>26)l.lastChild.remove()}
const esc=(s)=>String(s??'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))
let toolTimer=null
function connect(){
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host)
  ws.onclose=()=>{$('sub').textContent='reconnecting…';setTimeout(connect,2000)}
  ws.onopen=()=>{$('sub').textContent='online'}
  ws.onmessage=(m)=>{const {ev,data}=JSON.parse(m.data)
    if(ev==='snapshot'){
      $('dotbrain').style.background=data.brainUp?'#34d399':'#fb7185'
      $('tps').textContent=data.tps?data.tps+' tok/s':(data.brainUp?'ready':'down')
      $('ctx').textContent=(data.ctxPct??0)+'%'; $('ctxbar').style.width=Math.min(data.ctxPct??0,100)+'%'
      $('mem').textContent=data.history+' msgs'
      $('held').textContent=data.held??'0'
      if(data.selfTasks)$('tasks').textContent=data.selfTasks.active+' active · '+data.selfTasks.done+' done'
      if(data.mode==='ASLEEP')setState('asleep')
      else if(!data.brainUp)setState('down')
      else if(state==='asleep'||state==='down')setState('idle')
      $('sub').textContent=(data.mode==='IN VOICE'?'in voice with owner':data.mode.toLowerCase())
      return}
    if(ev==='listening'){if(state!=='think')setState('listen')}
    if(ev==='listening_end'){if(state==='listen')setState('idle')}
    if(ev==='owner_said'&&data.text&&!String(data.text).startsWith('[')){
      $('heard').querySelector('.ttxt').textContent=data.text; setState('think'); $('turn').textContent='working…'}
    if(ev==='brain'){setState('think');$('turn').textContent='hop '+(data.hop+1)+(data.tools?.length?' · '+data.tools.join(', '):'')
      if(data.tools?.length){const t=$('tools');t.innerHTML='';for(const n of data.tools){const c=document.createElement('span');c.className='chip';c.textContent=n;t.appendChild(c)}
        clearTimeout(toolTimer);toolTimer=setTimeout(()=>$('tools').innerHTML='',6000)}}
    if(ev==='tool')line('tool','<b>'+esc(data.name)+'</b> '+esc(JSON.stringify(data.args||{}).slice(0,90)))
    if(ev==='tool_error')line('err','<b>'+esc(data.name)+' failed</b> '+esc(String(data.err||'').slice(0,80)))
    if(ev==='speak'&&data.text){setState('speak');speakUntil=performance.now()+Math.min(2000+String(data.text).length*55,20000)
      $('said').querySelector('.ttxt').textContent=data.text}
    if(ev==='turn_done'){$('turn').textContent='idle';$('tools').innerHTML='';if(state==='think')setState('idle')}
    if(ev==='announce')line('','<b>queued</b> '+esc(String(data.text||'').slice(0,90)))
    if(ev==='duplicate_send_blocked')line('err','<b>duplicate send blocked</b>')
    if(ev==='send_claim_unbacked')line('err','<b>unbacked send claim caught</b>')
  }}
connect()
</script></body></html>`
