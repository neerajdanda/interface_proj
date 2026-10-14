import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner, DiscoverySession } from '../src/engine.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Policy } from '../src/policy.mjs';
import { readSavedReview } from '../src/review.mjs';

// Use the actual capability compiled from the genuine hosted discovery. The
// controlled UI below is only a unit-test dependency; it is never demo evidence.
const learned = JSON.parse(await readFile(new URL('../evidence/capability.json', import.meta.url), 'utf8'));
const inputs = { member_id: '12345' };
const baseUrl = 'http://127.0.0.1:4173';

function strategyKey(strategy) {
  if (strategy.kind === 'role') return `role:${strategy.role}:${strategy.name}`;
  if (strategy.kind === 'row') return `row:${strategy.label}:${strategy.control}`;
  if (strategy.kind === 'label') return `label:${strategy.name}`;
  return `text:${strategy.text}`;
}

/** A controlled business surface with independently chosen runtime outcomes. */
class ControlledSurface {
  constructor({ searchOutcome = 'found', serviceNotice = false, persistentNotice = false, delayedSearch = false, identity = null, money = '$12,480.50' } = {}) {
    Object.assign(this, { searchOutcome, serviceNotice, persistentNotice, delayedSearch, identity, money });
    this.state = 'blank'; this.url = 'about:blank'; this.entered = ''; this.actions = []; this.reads = []; this.navigations = 0; this.resultChecks = 0;
    this.page = { url: () => this.url };
    this.searchStarted = new Promise((resolve) => { this._searchStarted = resolve; });
  }
  view() {
    const entries = [];
    const heading = (name) => entries.push([`role:heading:${name}`, name]);
    const button = (name) => entries.push([`role:button:${name}`, name]);
    if (this.state === 'search') { heading('Find a member'); entries.push(['row:Member ID:input', this.entered]); button('Search'); }
    if (this.state === 'results') { heading('Search results'); button('Open member'); }
    if (this.state === 'overview') { heading('Member overview'); button('Account summary'); }
    if (this.state === 'summary') { heading('Account summary'); entries.push(['row:Member ID:text', this.identity ?? this.entered], ['row:Savings balance:text', this.money]); }
    if (this.state === 'not_found') entries.push(['text:Member not found', 'Member not found']);
    if (this.state === 'notice') { entries.push(['text:Service notice', 'Service notice']); button('Continue'); }
    if (this.state === 'unexpected_dialog') entries.push(['text:Supervisor approval required', 'Supervisor approval required']);
    if (this.state === 'unknown_dialog') entries.push(['role:dialog:Unrecognized compliance hold', 'Unrecognized compliance hold']);
    return new Map(entries);
  }
  lookup(target) {
    if (target.frame && target.frame !== 'Member workspace') return undefined;
    const view = this.view();
    for (const strategy of target.strategies) {
      const key = strategyKey(strategy);
      if (view.has(key)) return view.get(key);
      if (strategy.kind === 'text') for (const value of view.values()) if (value === strategy.text) return value;
    }
    return undefined;
  }
  async navigate(url) { this.url = url; this.navigations++; this.state = 'search'; }
  async describeAction(action) { return action; }
  async act(action, invocation) {
    const strategy = action.target?.strategies[0];
    const name = strategy?.name ?? strategy?.label ?? strategy?.text ?? action.type;
    this.actions.push({ type: action.type, name });
    if (action.type === 'fill' && name === 'Member ID' && this.state === 'search') {
      this.entered = action.value.param ? invocation[action.value.param] : action.value;
      return;
    }
    if (action.type === 'click' && name === 'Search' && this.state === 'search') {
      if (this.searchOutcome === 'not_found') this.state = 'not_found';
      else if (this.searchOutcome === 'unexpected_dialog') this.state = 'unexpected_dialog';
      else if (this.searchOutcome === 'unknown_dialog') this.state = 'unknown_dialog';
      else this.state = this.serviceNotice ? 'notice' : this.delayedSearch ? 'loading' : 'results';
      this._searchStarted();
      return;
    }
    if (action.type === 'click' && name === 'Continue' && this.state === 'notice') { if (!this.persistentNotice) this.state = 'results'; return; }
    if (action.type === 'click' && name === 'Open member' && this.state === 'results') { this.state = 'overview'; return; }
    if (action.type === 'click' && name === 'Account summary' && this.state === 'overview') { this.state = 'summary'; return; }
    throw Object.assign(new Error('Control is not available in this test state'), { code: 'TARGET_NOT_FOUND' });
  }
  async check(condition, invocation) {
    if (condition.target.strategies.some((strategy) => strategy.name === 'Search results')) this.resultChecks++;
    const observed = this.lookup(condition.target);
    if (observed === undefined) return false;
    if (condition.op === 'visible') return true;
    const expected = typeof condition.value === 'object' ? invocation[condition.value.param] : condition.value;
    return condition.op === 'text_equals' ? observed === expected : observed.includes(expected);
  }
  async read(target) { this.reads.push(target); return this.lookup(target); }
  async observe() { return { url: this.url, state: this.state, visibleControls: [...this.view().keys()] }; }
  async evidence(path) { await writeFile(`${path}.json`, JSON.stringify(await this.observe()), { mode: 0o600 }); return { snapshot: `${path}.json` }; }
}

async function setup(t, scenario = {}, allowedActions, checkpointTimeoutMs = 25) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-engine-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = new Evidence(directory, Object.values(inputs));
  await evidence.init();
  const surface = new ControlledSurface(scenario);
  const policy = new Policy({ baseUrl, ...(allowedActions ? { allowedActions } : {}) });
  const runner = new Runner({ surface, policy, evidence, checkpointTimeoutMs });
  return { directory, evidence, surface, runner, capability: structuredClone(learned) };
}

async function events(directory) { return (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); }
function assertFailureContext(result) {
  assert.ok(Object.hasOwn(result, 'expected'), 'failure contract must declare its expected state');
  assert.ok(result.observed && typeof result.observed === 'object', 'failure must include observed state');
  assert.ok(Object.hasOwn(result, 'step'));
  assert.ok(Object.hasOwn(result, 'phase'));
}

test('a post-search not-found result is a business outcome and never extracts a balance', async (t) => {
  const { runner, capability, surface, directory } = await setup(t, { searchOutcome: 'not_found' });
  const result = await runner.replay(capability, inputs);
  assert.equal(result.status, 'business_outcome');
  assert.equal(result.code, 'MEMBER_NOT_FOUND');
  assert.equal(result.step, capability.steps[1].id);
  assert.equal(result.phase, 'after');
  assert.equal(surface.actions.filter((action) => action.type === 'click').length, 1);
  assert.equal(surface.reads.length, 0);
  assert.equal(result.modelCalls, 0);
  assertFailureContext(result);
  assert.ok((await events(directory)).some((event) => event.type === 'evidence.captured'));
});

test('an unexpected dialog without an operator creates a live-session intervention and pauses', async (t) => {
  const { runner, capability, surface, directory } = await setup(t, { searchOutcome: 'unexpected_dialog' });
  const result = await runner.replay(capability, inputs);
  assert.equal(result.status, 'intervention_required');
  assert.equal(result.code, 'UNEXPECTED_DIALOG');
  assert.equal(runner.ownership.owner, 'paused');
  assert.equal(result.intervention.sessionId, runner.ownership.sessionId);
  assert.deepEqual(result.intervention.expected, capability.steps[1].after);
  assert.equal(surface.reads.length, 0);
  assertFailureContext(result);
  const log = await events(directory);
  assert.equal(log.filter((event) => event.type === 'intervention.requested').length, 1);
  assert.equal((await verifyLog(join(directory, 'events.jsonl'))).events, log.length);
});

test('a known service notice recovers once, then continues the recorded flow', async (t) => {
  const { runner, capability, surface, directory } = await setup(t, { serviceNotice: true });
  const result = await runner.replay(capability, inputs);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.savings_balance, { currency: 'USD', minorUnits: 1248050 });
  assert.equal(surface.actions.filter((action) => action.name === 'Continue').length, 1);
  assert.equal(surface.actions.filter((action) => action.name === 'Search').length, 1);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.handoffs, 0);
  assert.equal((await events(directory)).filter((event) => event.type === 'recovery.applied').length, 1);
});

test('a persistent notice cannot consume unbounded recovery clicks or extract outputs', async (t) => {
  const { runner, capability, surface } = await setup(t, { serviceNotice: true, persistentNotice: true });
  const result = await runner.replay(capability, inputs);
  assert.equal(result.status, 'failure');
  assert.equal(result.code, 'RECOVERY_EXHAUSTED');
  assert.equal(result.condition, 'SERVICE_NOTICE');
  assert.equal(surface.actions.filter((action) => action.name === 'Continue').length, 1);
  assert.equal(surface.reads.length, 0);
  assertFailureContext(result);
});

test('a different member on the final screen fails the identity checkpoint before extraction', async (t) => {
  const { runner, capability, surface } = await setup(t, { identity: '54321' });
  const result = await runner.replay(capability, inputs);
  assert.equal(result.status, 'failure');
  assert.equal(result.code, 'CHECKPOINT_TIMEOUT');
  assert.equal(result.step, 'success');
  assert.equal(result.phase, 'success');
  assert.deepEqual(result.expected, capability.success);
  assert.equal(surface.reads.length, 0);
  assertFailureContext(result);
});

test('an edited capability cannot remove identity verification or move it to a different frame', async (t) => {
  for (const tamper of [
    (capability) => { capability.success = capability.success.filter((checkpoint) => checkpoint.value?.param !== 'member_id'); },
    (capability) => { capability.success.find((checkpoint) => checkpoint.value?.param === 'member_id').target.frame = 'Unrelated workspace'; },
  ]) {
    const { runner, capability, surface } = await setup(t);
    tamper(capability);
    const result = await runner.replay(capability, inputs);
    assert.equal(result.status, 'failure');
    assert.equal(result.code, 'MISSING_IDENTITY_CHECKPOINT');
    assert.equal(surface.navigations, 0);
    assert.equal(surface.actions.length, 0);
    assert.equal(surface.reads.length, 0);
  }
});

test('a delayed result waits for the checkpoint and never repeats the search action', async (t) => {
  const { runner, capability, surface } = await setup(t, { delayedSearch: true }, undefined, 500);
  const pending = runner.replay(capability, inputs);
  await surface.searchStarted;
  await new Promise((resolve) => setTimeout(resolve, 100));
  surface.state = 'results';
  const result = await pending;
  assert.equal(result.status, 'success');
  assert.ok(surface.resultChecks >= 2);
  assert.equal(surface.actions.filter((action) => action.name === 'Search').length, 1);
  assert.equal(surface.reads.length, 1);
});

test('the action allowlist applies to entry navigation and output reads', async (t) => {
  const noNavigate = await setup(t, {}, ['fill', 'click', 'select', 'wait', 'read']);
  const navigation = await noNavigate.runner.replay(noNavigate.capability, inputs);
  assert.equal(navigation.status, 'failure');
  assert.equal(navigation.code, 'ACTION_DENIED');
  assert.equal(noNavigate.surface.navigations, 0);
  assertFailureContext(navigation);
  const noRead = await setup(t, {}, ['navigate', 'fill', 'click', 'select', 'wait']);
  const extraction = await noRead.runner.replay(noRead.capability, inputs);
  assert.equal(extraction.status, 'failure');
  assert.equal(extraction.code, 'ACTION_DENIED');
  assert.equal(extraction.step, 'success');
  assert.equal(noRead.surface.reads.length, 0);
  assertFailureContext(extraction);
});

test('malformed declared money cannot emit a successful discovery artifact', async (t) => {
  const { runner, capability, surface, directory } = await setup(t, { money: '$12,480.505' });
  const decisions = [
    ...capability.steps.map((step) => ({ kind: 'action', action: step.action, before: step.before, after: step.after, reason: 'Unit-test controller action' })),
    { kind: 'finish', success: capability.success, outputs: capability.outputs, reason: 'Unit-test controller completion' },
  ];
  const model = { mode: 'codex-bridge', model: 'Unit-test controller, not genuine discovery evidence', async decide() { return decisions.shift(); } };
  const artifactPath = join(directory, 'rejected-capability.json');
  const result = await runner.discover({ goal: 'Read savings balance for member {{member_id}}', inputs, entry: capability.entry, model, artifactPath });
  assert.equal(result.status, 'failure');
  assert.equal(result.code, 'INVALID_OUTPUT');
  assert.equal(surface.reads.length, 1);
  await assert.rejects(access(artifactPath), { code: 'ENOENT' });
  assert.ok(!(await events(directory)).some((event) => event.type === 'capability.recorded'));
  assertFailureContext(result);
});

test('successful discovery persists actual handoff counts that reconcile with terminal evidence in saved review', async (t) => {
  for (const handoffs of [0, 1]) {
    const { runner, capability, surface, directory } = await setup(t, handoffs ? { searchOutcome: 'unexpected_dialog' } : {});
    if (handoffs) runner.operator = {
      async start() {},
      async onIntervention(active) {
        assert.equal(active.ownership.pending.code, 'UNEXPECTED_DIALOG');
        await active.ownership.claim();
        // Controlled dependency only: make the interrupted fixture available
        // again. This unit test is never used as real discovery evidence.
        surface.state = 'results';
        await active.ownership.resume();
      },
    };
    const decisions = [
      ...capability.steps.map(step => ({ kind: 'action', action: step.action, before: step.before, after: step.after, reason: 'Unit-test controller action' })),
      { kind: 'finish', success: capability.success, outputs: capability.outputs, reason: 'Unit-test controller completion' },
    ];
    const model = { mode: 'codex-bridge', model: 'Unit-test controller, not genuine discovery evidence', async decide() { return decisions.shift(); } };
    const result = await runner.discover({ goal: 'Read savings balance for member {{member_id}}', inputs, entry: capability.entry, model, artifactPath: join(directory, 'capability.json') });
    assert.equal(result.status, 'success');
    assert.equal(result.handoffs, handoffs);
    const persisted = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    const terminal = (await events(directory)).find(event => event.type === 'run.completed');
    assert.equal(persisted.handoffs, handoffs);
    assert.equal(persisted.handoffs, terminal.handoffs);
    assert.equal(persisted.modelCalls, terminal.modelCalls);
    const review = await readSavedReview(directory);
    assert.equal(review.integrity.state, 'verified');
    assert.equal(review.result.state, 'matched');
    assert.equal(review.result.reported.handoffs, handoffs);
    assert.equal(review.timeline.status, 'success');
  }
});

test('a late discovery decision pauses the live session before performing its proposed action', async (t) => {
  const { runner, capability, surface, directory } = await setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const session = new DiscoverySession(runner, {
    goal: 'Read savings for {{member_id}}', inputs, entry: capability.entry,
    model: { mode: 'codex-bridge', model: 'Unit-test deadline controller' },
    artifactPath: join(directory, 'never-published.json'), timeoutMs: 10,
  });
  await session.initialize();
  await session.request();
  await new Promise((resolve) => setTimeout(resolve, 15));
  now += 15;
  const step = capability.steps[0];
  await assert.rejects(session.apply({ kind: 'action', action: step.action, before: step.before, after: step.after, reason: 'Unit-test delayed model response' }), (error) => {
    assert.equal(error.status, 'intervention_required');
    assert.equal(error.code, 'DISCOVERY_TIMEOUT');
    return true;
  });
  assert.equal(surface.actions.length, 0);
  assert.equal(runner.ownership.owner, 'paused');
  assert.equal(runner.ownership.pending.sessionId, runner.ownership.sessionId);
  const log = await events(directory);
  assert.equal(log.filter((event) => event.type === 'intervention.requested').length, 1);
  assert.equal(log.filter((event) => event.type === 'model.decided').length, 0);
});
