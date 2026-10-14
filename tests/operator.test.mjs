import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script, createContext } from 'node:vm';
import { OperatorConsole } from '../src/operator.mjs';
import { Ownership } from '../src/ownership.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Policy } from '../src/policy.mjs';

test('HTTP operator routes fence stale clients, drive the same session, and omit entered values', {skip:process.env.RELAY_HTTP_TESTS!=='1'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-operator-'));
  const evidence=new Evidence(directory);await evidence.init();
  const ownership=new Ownership(evidence),actions=[];
  const policy=new Policy({baseUrl:'http://127.0.0.1:4173'});
  const target={frame:'Member workspace',strategies:[{kind:'role',role:'button',name:'Restore session'}]};
  const surface={
    page:{url:()=>policy.baseUrl+'bank'},
    async observe(){return {controls:[{role:'button',name:'Restore session',target}],text:'Session expired'};},
    async describeAction(action){return action;},
    async act(action){assert.equal(ownership.owner,'human');actions.push(action);},
    async screenshot(){return Buffer.from('89504e470d0a1a0a','hex');}
  };
  const console=new OperatorConsole({port:0});console.runner={surface,policy,evidence,ownership};
  try {
    await console.start();const base=`http://127.0.0.1:${console.port}`;
    const html=await fetch(base).then(r=>r.text());
    assert.match(html,/One session\. Clear ownership\./);
    new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    assert.match(html,/send\('\/resume',\{ticket:/);
    const headers={'X-Relay-Token':console.token,'Content-Type':'application/json',Origin:base};
    const request=(path,body,custom=headers)=>fetch(base+path,{method:body?'POST':'GET',headers:custom,body:body?JSON.stringify(body):undefined});
    assert.equal((await request('/state',null,{})).status,403);
    assert.equal((await request('/claim',{}, {...headers,Origin:'https://other.example'})).status,403);
    assert.equal((await request('/claim',{})).status,409);
    await ownership.pause({code:'SESSION_EXPIRED',step:'step-2'});
    const paused=await request('/state').then(response=>response.json());
    assert.equal(paused.timeline.status,'paused');
    assert.equal(paused.timeline.modelCalls,0);
    assert.equal(paused.timeline.pauseReason,'The application session expired.');
    assert.ok(!Object.hasOwn(paused.timeline,'observation'));
    assert.equal((await request('/claim',{})).status,200);
    assert.equal((await request('/state').then(response=>response.json())).timeline.owner,'human');
    const ticket=ownership.ticket(),session=ownership.sessionId;
    assert.equal((await request('/action',{ticket,action:{type:'click',target}})).status,200);
    assert.equal(actions.length,1);assert.equal(ownership.sessionId,session);
    const risky={type:'click',target:{strategies:[{kind:'role',role:'button',name:'Submit transfer'}]}};
    assert.equal((await request('/action',{ticket,action:risky})).status,409);assert.equal(actions.length,1);
    const fill={type:'fill',target:{strategies:[{kind:'role',role:'textbox',name:'Operator note'}]},value:'PRIVATE-ENTERED-VALUE'};
    assert.equal((await request('/action',{ticket,action:fill})).status,200);
    assert.equal((await request('/resume',{ticket:{...ticket,epoch:ticket.epoch-1}})).status,409);
    assert.equal((await request('/resume',{ticket})).status,200);
    assert.equal((await request('/state').then(response=>response.json())).timeline.owner,'automation');
    assert.equal(ownership.owner,'automation');assert.equal(ownership.sessionId,session);
    assert.equal((await request('/action',{ticket,action:{type:'click',target}})).status,409);
    assert.equal((await request('/resume',{ticket})).status,409);
    const log=await readFile(join(directory,'events.jsonl'),'utf8');
    assert.doesNotMatch(log,/PRIVATE-ENTERED-VALUE/);assert.match(log,/human.action/);
    assert.ok((await verifyLog(join(directory,'events.jsonl'))).events>=5);
  }finally{await console.close();await rm(directory,{recursive:true,force:true});}
});

async function consoleClient({ actor, preview = 'unsupported' } = {}) {
  let handler, html;
  const operator = new OperatorConsole({ port: 4180, actor, logger: () => {}, serverFactory: callback => {
    handler = callback;
    return { once() { return this; }, listen(port, host, ready) { ready(); }, address() { return { port: 4180 }; }, close(done) { done(); } };
  } });
  await operator.start();
  await handler({ method: 'GET', url: '/', headers: { host: '127.0.0.1:4180' } }, { setHeader() {}, end(value) { html = value; } });
  await operator.close();
  const elements = new Map();
  const node = () => ({ textContent: '', hidden: false, disabled: false, src: '', children: [], replaceChildren() { this.children = []; }, append(value) { this.children.push(value); }, removeAttribute(name) { if (name === 'src') this.src = ''; } });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }, createElement: node };
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) document.getElementById(match[1]);
  const revoked = [], requests = [];
  let previewMode = preview;
  const state = {
    owner: 'human', epoch: 3, sessionId: 'cf3c25f1-4dfd-4869-8067-abc9d5b35c82', operatorActor: actor || null,
    request: { code: 'SESSION_EXPIRED', step: 'step-2', phase: 'after' },
    timeline: { operatorTestActor: actor === 'automated_test_actor' },
    observation: { controls: [{ role: 'button', name: 'Restore session', target: { strategies: [{ kind: 'role', role: 'button', name: 'Restore session' }] } }] },
  };
  const context = createContext({
    document, setInterval() {}, renderRelayTimeline() {}, prompt() { throw new Error('Unexpected prompt'); },
    URL: { createObjectURL() { return 'blob:live-preview'; }, revokeObjectURL(value) { revoked.push(value); } },
    async fetch(path, options) {
      requests.push({ path, options });
      if (path === '/state') return { ok: true, async json() { return state; } };
      if (path === '/preview') return previewMode === 'success' ? { ok: true, async blob() { return {}; } } : { ok: false, async json() { return { error: previewMode === 'unsupported' ? 'preview_unavailable' : 'EXECUTION_ERROR' }; } };
      return { ok: true, async json() { return { okay: true }; } };
    },
  });
  const fullScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Script(fullScript);
  new Script(fullScript.slice(fullScript.indexOf('const token='))).runInContext(context);
  await new Script('update()').runInContext(context);
  return { elements, context, requests, revoked, state, setPreview(value) { previewMode = value; }, update: () => new Script('update()').runInContext(context) };
}

test('unsupported preview shows a readable placeholder while automated actor and session controls remain usable', async () => {
  const client = await consoleClient({ actor: 'automated_test_actor' });
  assert.equal(client.elements.get('preview').hidden, true);
  assert.equal(client.elements.get('preview-message').hidden, false);
  assert.match(client.elements.get('preview-message').textContent, /A live image is unavailable/);
  assert.doesNotMatch(client.elements.get('preview-message').textContent, /preview_unavailable/);
  assert.equal(client.elements.get('error').textContent, '');
  assert.equal(client.elements.get('actor-status').textContent, 'Automated verification / local sandbox');
  assert.equal(client.elements.get('actor-label').textContent, 'Automated operator check');
  assert.equal(client.elements.get('owner').textContent, 'Test actor has control');
  assert.equal(client.elements.get('resume').disabled, false);
  const repair = client.elements.get('controls').children.find(control => control.textContent === 'Restore session');
  assert.equal(repair.disabled, false);
  await repair.onclick();
  const dispatched = client.requests.find(request => request.path === '/action');
  assert.equal(JSON.parse(dispatched.options.body).ticket.sessionId, client.state.sessionId);
  assert.equal(JSON.parse(dispatched.options.body).action.type, 'click');
});

test('native preview remains visible and default human wording remains unchanged; failed images are removed', async () => {
  const client = await consoleClient({ preview: 'success' });
  assert.equal(client.elements.get('preview').hidden, false);
  assert.equal(client.elements.get('preview-message').hidden, true);
  assert.equal(client.elements.get('owner').textContent, 'You have control');
  assert.equal(client.elements.get('actor-label').textContent, 'Human intervention');
  assert.equal(client.elements.get('actor-status').textContent, 'Computer-use control room / local sandbox');
  client.setPreview('error'); await client.update();
  assert.equal(client.elements.get('preview').hidden, true);
  assert.equal(client.elements.get('preview').src, '');
  assert.ok(client.revoked.includes('blob:live-preview'));
  assert.match(client.elements.get('preview-message').textContent, /temporarily unavailable/);
  assert.equal(client.elements.get('error').textContent, '');
});
