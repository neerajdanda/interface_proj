import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSandbox } from '../src/sandbox.mjs';
import { BrowserSurface } from '../src/surface.mjs';
import { Policy } from '../src/policy.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Runner } from '../src/engine.mjs';
import { OperatorConsole } from '../src/operator.mjs';

// No discovery or provider is mocked or invoked here. This replays the existing
// genuine-discovery artifact. HTTP console control is an explicitly automated
// test actor operating the real Playwright page, not a human-participant claim.
test('real Playwright replay resumes the same session after HTTP console repair (automated test actor)', { skip: process.env.RELAY_LIVE_TESTS !== '1', timeout: 60000 }, async (t) => {
  const capability = JSON.parse(await readFile(new URL('../evidence/capability.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'relay-replay-live-'));
  let sandbox, surface, operator;
  try {
    sandbox = await startSandbox({ port: 0 });
    surface = await BrowserSurface.launch({ baseUrl: sandbox.baseUrl, scenario: 'session_expired' });
    const originalPage = surface.page;
    const originalContext = surface.context;
    const policy = new Policy({ baseUrl: sandbox.baseUrl });
    await policy.protect(surface.context);
    const evidence = new Evidence(directory, ['67890']);
    await evidence.init();
    await evidence.event('test.actor', { actor: 'automated HTTP console test actor', purpose: 'same-session replay verification; no human or API-provider run' });
    operator = new OperatorConsole({ port: 0 });
    const runner = new Runner({ surface, policy, evidence, operator, handoffTimeoutMs: 15000 });
    const originalSessionId = runner.ownership.sessionId;
    let consoleRepairs = 0;

    const request = async (path, payload, expectedStatus = 200) => {
      const base = `http://127.0.0.1:${operator.port}`;
      const response = await fetch(base + path, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { 'X-Relay-Token': operator.token, 'Content-Type': 'application/json', Origin: base },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, expectedStatus, `${path} must enforce the expected control state`);
      return response.json();
    };

    // This hook only determines when the automated actor should contact the
    // console. Claim/action/resume all use its actual HTTP routes and published
    // ticket, exactly as the console client does; no direct ownership mutations.
    operator.onIntervention = async (activeRunner) => {
      assert.equal(activeRunner, runner);
      consoleRepairs++;
      assert.equal(consoleRepairs, 1);
      assert.equal(surface.page, originalPage);
      assert.equal(surface.context, originalContext);
      const paused = await request('/state');
      assert.equal(paused.owner, 'paused');
      assert.equal(paused.request.code, 'SESSION_EXPIRED');
      assert.equal(paused.sessionId, originalSessionId);
      assert.ok(!JSON.stringify(paused.observation).includes('67890'));
      assert.ok(!JSON.stringify(paused.observation).includes('Jordan Reed'));
      const pageUrlAtPause = surface.page.url();
      // An unrelated session marker proves handoff did not replace the page or
      // browser storage. This is test setup, not a repair performed by script.
      await surface.page.evaluate(() => sessionStorage.setItem('relay.live-test.session-marker', 'preserved'));
      await request('/claim', {});
      const claimed = await request('/state');
      assert.equal(claimed.owner, 'human');
      assert.equal(claimed.sessionId, originalSessionId);
      assert.ok(claimed.epoch > paused.epoch);
      const ticket = { sessionId: claimed.sessionId, epoch: claimed.epoch };
      const repairControl = claimed.observation.controls.find((control) => control.role === 'button' && control.name === 'Restore session');
      assert.ok(repairControl, 'the live console must expose the session repair control');
      const repairAction = { type: 'click', target: repairControl.target };
      await request('/action', { ticket, action: repairAction });
      const repaired = await request('/state');
      assert.equal(repaired.owner, 'human');
      assert.equal(repaired.sessionId, originalSessionId);
      assert.equal(await surface.check({ target: { frame: 'Member workspace', strategies: [{ kind: 'role', role: 'dialog', name: 'Session expired' }] }, op: 'visible' }), false);
      assert.equal(await surface.check({ target: { frame: 'Member workspace', strategies: [{ kind: 'role', role: 'heading', name: 'Search results' }] }, op: 'visible' }), true);
      assert.equal(surface.page.url(), pageUrlAtPause);
      await request('/resume', { ticket });
      const resumed = await request('/state');
      assert.equal(resumed.owner, 'automation');
      assert.equal(resumed.request, null);
      assert.equal(resumed.sessionId, originalSessionId);
      assert.ok(resumed.epoch > claimed.epoch);
      const rejected = await request('/action', { ticket, action: repairAction }, 409);
      assert.equal(rejected.error, 'CONTROL_FENCED');
      assert.equal(await surface.page.evaluate(() => sessionStorage.getItem('relay.live-test.session-marker')), 'preserved');
    };

    // Discovery used a different member; this invocation must return the new
    // member's balance while retaining all saved targeting/checkpoint rules.
    const result = await runner.replay(capability, { member_id: '67890' });
    assert.equal(result.status, 'success');
    assert.equal(result.code, 'GOAL_VERIFIED');
    assert.equal(result.modelCalls, 0);
    assert.equal(result.handoffs, 1);
    assert.equal(consoleRepairs, 1);
    assert.equal(result.sessionId, originalSessionId);
    assert.deepEqual(result.outputs.savings_balance, { currency: 'USD', minorUnits: 812500 });
    assert.equal(surface.page, originalPage);
    assert.equal(surface.context, originalContext);
    assert.equal(await surface.check({ target: { frame: 'Member workspace', strategies: [{ kind: 'row', label: 'Member ID', control: 'text' }] }, op: 'text_equals', value: { param: 'member_id' } }, { member_id: '67890' }), true);
    const persisted = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    assert.deepEqual(persisted.outputs, { savings_balance: '[REDACTED]' });
    assert.equal(Object.hasOwn(persisted, 'member_id'), false);
    const logPath = join(directory, 'events.jsonl');
    const log = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const actionEvents = log.filter((event) => event.type === 'action.started');
    assert.deepEqual(actionEvents.map((event) => event.step), capability.steps.map((step) => step.id), 'handoff must not repeat completed recorded steps');
    assert.equal(log.filter((event) => event.type === 'intervention.requested').length, 1);
    assert.deepEqual(log.filter((event) => event.type === 'control.transferred').map((event) => event.owner), ['human', 'automation']);
    assert.equal(log.filter((event) => event.type === 'human.action').length, 1);
    assert.ok(log.some((event) => event.type === 'checkpoint.revalidate'));
    assert.equal((await verifyLog(logPath)).events, log.length);
    const snapshot = await readFile(join(directory, 'success.json'), 'utf8');
    for (const value of ['67890', 'Jordan Reed', '$8,125.00']) assert.ok(!snapshot.includes(value));
    t.diagnostic('Verified actual Playwright replay with an automated HTTP console actor; zero model calls and no human/API-provider run claimed.');
  } finally {
    if (operator) await operator.close();
    if (surface) await surface.close();
    if (sandbox) await sandbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});
