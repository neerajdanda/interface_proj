import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { safeAct } from './engine.mjs';
import { scrub } from './policy.mjs';
import { buildTimeline } from './timeline.mjs';
import { timelineCss, timelineMarkup, timelineScript } from './timeline-ui.mjs';

export class OperatorConsole {
  constructor({port=4180,actor,serverFactory=createServer,logger=message=>process.stderr.write(message)}={}) {
    if(actor!==undefined&&!['human_operator','automated_test_actor'].includes(actor))throw new Error('Unknown operator actor');
    if(typeof serverFactory!=='function')throw new Error('A server factory is required');
    if(typeof logger!=='function')throw new Error('A logger is required');
    this.port=port;this.actor=actor;this.serverFactory=serverFactory;this.logger=logger;this.token=randomBytes(24).toString('hex');this.runner=null;
  }
  async start() {
    if(this.server)return;
    this.server=this.serverFactory(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
      const expectedHost=`127.0.0.1:${this.port}`;
      if(req.headers.host!==expectedHost){res.writeHead(403).end();return;}
      if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(consoleHtml(this.token));return;}
      if(req.headers['x-relay-token']!==this.token||req.headers.origin&&req.headers.origin!==`http://${expectedHost}`){res.writeHead(403).end();return;}
      const r=this.runner;
      if(!r){res.writeHead(503).end();return;}
      try {
        if(req.method==='GET'&&req.url==='/state') {
          const observation=await r.surface.observe();
          const timeline=buildTimeline(await r.evidence.snapshotState());
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify(scrub({owner:r.ownership.owner,epoch:r.ownership.epoch,sessionId:r.ownership.sessionId,request:r.ownership.pending,operatorActor:this.actor||null,observation,timeline},r.evidence.secrets)));return;
        }
        if(req.method==='GET'&&req.url==='/preview') {res.setHeader('Content-Type','image/png');res.end(await r.surface.screenshot());return;}
        if(req.method==='POST') {
          let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw new Error('Request too large');}
          const payload=raw?JSON.parse(raw):{};
          if(req.url==='/claim')await r.ownership.claim();
          else if(req.url==='/resume'){r.ownership.assert(payload.ticket,'human');await r.ownership.resume();}
          else if(req.url==='/action') {
            // Client must hold the current fenced lease; stale tabs cannot drive UI.
            r.ownership.assert(payload.ticket,'human');
            if(!['click','fill','select'].includes(payload.action?.type))throw new Error('Unsupported operator action');
            await safeAct(r.surface,r.policy,r.ownership,payload.action,{},'reversible','human');
            await r.evidence.event('human.action',{...(this.actor?{actor:this.actor}:{}),action:{type:payload.action.type,target:payload.action.target},sessionId:r.ownership.sessionId,epoch:r.ownership.epoch});
          }else{res.writeHead(404).end();return;}
          res.setHeader('Content-Type','application/json');res.end(JSON.stringify({okay:true}));return;
        }
        res.writeHead(404).end();
      }catch(error){res.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.code||'OPERATOR_ACTION_REJECTED'}));}
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',resolve);});
    this.port=this.server.address().port;
    this.logger(`Operator console: http://127.0.0.1:${this.port}\n`);
  }
  async close(){if(this.server)await new Promise(resolve=>this.server.close(resolve));}
}

function consoleHtml(token) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay | Session control</title>
<style>*{box-sizing:border-box}body{margin:0;background:#edf0f2;color:#192939;font:15px system-ui}header{background:#122b40;color:white;padding:24px 5vw;display:flex;justify-content:space-between;align-items:center}.logo{font-size:24px;font-weight:750;letter-spacing:-1px}.logo b{color:#72e0bd}small{letter-spacing:2px;text-transform:uppercase;font-size:10px}main{max-width:1360px;margin:32px auto;padding:0 24px}.intro{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.intro h1{font-size:32px;letter-spacing:-1px;margin:4px 0}.pill{padding:9px 16px;background:white;border-radius:30px;font-size:12px;font-weight:700}.grid{display:grid;grid-template-columns:1fr 350px;gap:24px}.card{background:white;border:1px solid #d9e1e7;border-radius:14px;overflow:hidden;box-shadow:0 8px 26px #152d4008}.bar{padding:14px 20px;border-bottom:1px solid #e5e9ed;display:flex;justify-content:space-between;font-size:12px}.preview{display:block;width:100%;background:#e5e9ed}[hidden]{display:none!important}.preview-message{min-height:260px;padding:52px 40px;display:grid;place-items:center;text-align:center;background:#f2f5f6;color:#526a7b;font-size:16px;line-height:1.7}.side{padding:24px}.side h2{font-size:18px;margin:0 0 16px}.muted{color:#667b8d;line-height:1.6}.reason{padding:16px;background:#fff6e5;border-left:3px solid #dd9b24;border-radius:6px;font:12px ui-monospace;margin:16px 0}button{border:0;border-radius:7px;padding:12px 16px;font:600 13px system-ui;cursor:pointer;background:#e9eff2;color:#1f3c50}button.primary{background:#0a795e;color:white}button:disabled{opacity:.35;cursor:default}.controls{display:grid;gap:8px;margin:16px 0}.controls button{text-align:left}.actions{display:flex;gap:10px}.meta{font:11px ui-monospace;color:#7b8994;word-break:break-all}.error{color:#b64429;font-size:12px}.footer{padding:18px 22px;border-top:1px solid #e5e9ed;font-size:12px;color:#65788b}@media(max-width:900px){.grid{grid-template-columns:1fr}}${timelineCss}</style>
<header><div class="logo">↗ relay<b>.</b></div><small id="actor-status">Computer-use control room / local sandbox</small></header><main><div class="intro"><div><small id="actor-label">Human intervention</small><h1>One session. Clear ownership.</h1><div class="muted">Take control, resolve the interruption, then return the session to Relay.</div></div><span class="pill" id="owner">Connecting</span></div><div class="grid"><section class="card"><div class="bar"><b>Application preview</b><span id="preview-status">Private fields masked</span></div><img id="preview" class="preview" alt="Redacted live application view" hidden><div id="preview-message" class="preview-message" role="status">Connecting to the live preview…</div><div id="preview-footer" class="footer">This view comes from the exact browser session used by automation.</div></section><aside class="card side"><h2>Session handoff</h2><p class="muted" id="description">Waiting for an intervention request.</p><div class="reason" id="reason">No active intervention</div><div class="actions"><button class="primary" id="claim">Take control</button><button id="resume">Return control</button></div><div class="controls" id="controls"></div><p class="error" id="error"></p><details><summary>Session details</summary><p class="meta" id="session"></p></details><p class="muted">Actions are recorded without entered values. Automation rechecks its checkpoint after control returns.</p></aside></div><section id="timeline" style="margin-top:24px">${timelineMarkup}</section></main>
<script>${timelineScript}
const token=${JSON.stringify(token)};let state;
const headers={'X-Relay-Token':token,'Content-Type':'application/json'};
async function request(path,body){let r=await fetch(path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error((await r.json()).error||'Connection unavailable');return r;}
function showPreviewMessage(message){
 const img=document.getElementById('preview'),previous=img.src;
 img.hidden=true;img.removeAttribute('src');
 if(previous.startsWith('blob:'))URL.revokeObjectURL(previous);
 const placeholder=document.getElementById('preview-message');placeholder.textContent=message;placeholder.hidden=false;
 document.getElementById('preview-status').textContent='Image unavailable';
 document.getElementById('preview-footer').textContent='Controls and timeline come from the active browser session.';
}
async function updatePreview(){
 try{
  const blob=await(await request('/preview')).blob(),img=document.getElementById('preview'),previous=img.src;
  img.src=URL.createObjectURL(blob);img.hidden=false;document.getElementById('preview-message').hidden=true;
  document.getElementById('preview-status').textContent='Private fields masked';
  document.getElementById('preview-footer').textContent='This view comes from the exact browser session used by automation.';
  if(previous.startsWith('blob:'))URL.revokeObjectURL(previous);
 }catch(error){
  showPreviewMessage(error.message==='preview_unavailable'?'A live image is unavailable in this verification browser. Session controls and the timeline below still follow the same browser session.':'The live image is temporarily unavailable. Session controls and the timeline remain available.');
 }
}
async function update(){
 try{
  state=await(await request('/state')).json();renderRelayTimeline(document.getElementById('timeline'),state.timeline);
  const automated=state.operatorActor==='automated_test_actor'||state.timeline.operatorTestActor===true;
  document.getElementById('actor-status').textContent=automated?'Automated verification / local sandbox':'Computer-use control room / local sandbox';
  document.getElementById('actor-label').textContent=automated?'Automated operator check':'Human intervention';
  document.getElementById('owner').textContent=({human:automated?'Test actor has control':'You have control',paused:'Waiting for operator',automation:'Automation has control'})[state.owner]||state.owner;
  document.getElementById('reason').textContent=state.request?state.request.code+' / '+state.request.step+' / '+state.request.phase:'No active intervention';
  document.getElementById('description').textContent=state.request?'Relay paused at a verified boundary. You can resolve the interruption in this live session.':'The session is available when Relay raises an intervention.';
  document.getElementById('session').textContent='SESSION '+state.sessionId;
  document.getElementById('claim').disabled=state.owner!=='paused';document.getElementById('resume').disabled=state.owner!=='human';
  let controls=document.getElementById('controls');controls.replaceChildren();
  for(const c of state.observation.controls||[]){
   if(!['button','textbox','combobox'].includes(c.role))continue;
   let b=document.createElement('button');b.textContent=c.name||c.role;b.disabled=state.owner!=='human';
   b.onclick=async()=>{let action={type:c.role==='textbox'?'fill':c.role==='combobox'?'select':'click',target:c.target};if(action.type!=='click'){const value=prompt('Enter value (kept only in the live session)');if(value===null)return;action.value=value;}await send('/action',{ticket:{sessionId:state.sessionId,epoch:state.epoch},action});};controls.append(b);
  }
  await updatePreview();
 }catch(e){document.getElementById('error').textContent=e.message;}
}
async function send(path,body){try{await request(path,body);document.getElementById('error').textContent='';await update();}catch(e){document.getElementById('error').textContent=e.message;}}
document.getElementById('claim').onclick=()=>send('/claim',{});document.getElementById('resume').onclick=()=>send('/resume',{ticket:{sessionId:state.sessionId,epoch:state.epoch}});update();setInterval(update,1200);</script></html>`;
}
