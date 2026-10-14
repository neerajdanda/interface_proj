import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildTimeline } from '../src/timeline.mjs';
import { renderTimelineHtml, timelineScript } from '../src/timeline-ui.mjs';

const target = name => ({ strategies: [{ kind: 'role', role: 'button', name }] });
const event = (type, data = {}) => ({ type, ...data });

test('model proposals never become dispatched or verified actions', () => {
  const projection = buildTimeline({ events: [
    event('run.started', { mode: 'discovery', goal: 'Read account summary' }),
    event('model.observed', { step: 'step-1', observation: { text: 'Private page content' } }),
    event('model.decided', { step: 'step-1', decision: { kind: 'action', action: { type: 'click', target: target('Submit transfer') }, reason: 'Private reasoning' } }),
    event('model.observed', { step: 'step-2' }),
    event('model.decided', { step: 'step-2', decision: { kind: 'finish' } }),
  ] });
  assert.equal(projection.modelCalls, 2);
  assert.equal(projection.steps.length, 1);
  assert.equal(projection.steps[0].state, 'proposed');
  assert.equal(projection.checkpointTelemetryAvailable, false);
  assert.equal(projection.items.filter(item => item.kind === 'action').length, 0);
  assert.equal(projection.items.filter(item => item.state === 'passed').length, 0);
  assert.ok(projection.items.some(item => item.title === 'Observation prepared for model'));
  assert.doesNotMatch(JSON.stringify(projection), /Private page|Private reasoning|Submit transfer/);
});

test('replay uses safe plan metadata and keeps model count at zero', () => {
  const projection = buildTimeline({ events: [
    event('run.started', { mode: 'replay', capability: 'member.lookup', plan: [{ id: 'fill', title: 'Enter member ID', actionType: 'fill', value: '12345', target: { private: 'do not copy' } }, { id: 'search', title: 'Search', actionType: 'click' }] }),
    event('action.started', { step: 'fill', action: { type: 'fill', target: { strategies: [{ kind: 'row', label: 'Member ID' }] }, value: '12345' } }),
    event('action.completed', { step: 'fill', action: { type: 'fill', target: { strategies: [{ kind: 'row', label: 'Member ID' }] }, value: '12345' } }),
  ], result: { status: 'success', modelCalls: 0, outputs: { savings_balance: { currency: 'USD', minorUnits: 812500 } } } });
  assert.equal(projection.goal, 'member.lookup');
  assert.equal(projection.mode, 'replay');
  assert.equal(projection.modelCalls, 0);
  assert.equal(projection.steps.length, 2);
  assert.equal(projection.steps[0].state, 'completed');
  assert.equal(projection.steps[1].state, 'planned');
  assert.equal(projection.steps[0].checkpoints.before, 'not_recorded');
  assert.doesNotMatch(JSON.stringify(projection), /12345|812500|do not copy|minorUnits/);
});

test('actual checkpoint and ownership records explain a resumed run', () => {
  const projection = buildTimeline({ events: [
    event('run.started', { mode: 'replay', goal: 'Read balance' }),
    event('checkpoint.started', { step: 'search', phase: 'before', expected: [{ value: '12345' }] }),
    event('checkpoint.passed', { step: 'search', phase: 'before', expected: [{}] }),
    event('action.started', { step: 'search', action: { type: 'click', target: target('Search') } }),
    event('action.completed', { step: 'search', action: { type: 'click', target: target('Search') } }),
    event('checkpoint.started', { step: 'search', phase: 'after', expected: [{}] }),
    event('intervention.requested', { step: 'search', phase: 'after', code: 'SESSION_EXPIRED', observed: { text: '12345 $8,125.00' } }),
    event('control.transferred', { owner: 'human', epoch: 2 }),
    event('human.action', { actor: 'simulated operator test actor', action: { type: 'click', target: target('Restore session') } }),
    event('control.transferred', { owner: 'automation', epoch: 3 }),
    event('checkpoint.revalidate', { step: 'search', phase: 'after' }),
    event('checkpoint.passed', { step: 'search', phase: 'after', expected: [{}] }),
    event('checkpoint.passed', { step: 'success', phase: 'success', expected: [{}] }),
    event('run.completed', { status: 'success', modelCalls: 0 }),
  ] });
  assert.equal(projection.status, 'success');
  assert.equal(projection.owner, 'automation');
  assert.equal(projection.pauseReason, '');
  assert.equal(projection.operatorTestActor, true);
  assert.equal(projection.steps.length, 1);
  assert.equal(projection.steps[0].state, 'verified');
  assert.equal(projection.steps[0].checkpoints.after, 'passed');
  assert.equal(projection.items.find(item => item.title === 'Checkpoint recheck requested').state, 'requested');
  assert.ok(projection.items.some(item => item.title.includes('Simulated operator test actor')));
  assert.equal(projection.items.filter(item => item.kind === 'action' && item.state === 'started').length, 1);
  assert.doesNotMatch(JSON.stringify(projection), /12345|8,125/);
});

test('lowercase interruption reasons and automated test provenance are recognized', () => {
  const projection = buildTimeline({ events: [
    event('run.started', { mode: 'replay', goal: 'Find member' }),
    event('test.actor', { actor: 'automated HTTP console test actor' }),
    event('intervention.requested', { step: 'unproposed-model-step', phase: 'action', code: 'ambiguous_target' }),
  ] });
  assert.equal(projection.pauseReason, 'More than one control matched the action.');
  assert.equal(projection.steps.length, 0);
  assert.equal(projection.operatorTestActor, true);
  assert.match(projection.items.find(item => item.kind === 'test').detail, /no human participant/i);
});

test('empty checkpoints are boundaries rather than successful condition checks', () => {
  const projection = buildTimeline({ events: [
    event('checkpoint.started', { step: 'fill', phase: 'after', expected: [] }),
    event('checkpoint.passed', { step: 'fill', phase: 'after', expected: [] }),
  ] });
  assert.equal(projection.checkpointTelemetryAvailable, true);
  assert.equal(projection.steps[0].checkpoints.after, 'empty');
  assert.equal(projection.items[1].state, 'empty');
  assert.match(projection.items[1].title, /boundary reached/);
  assert.doesNotMatch(projection.items[1].title, /passed/);
});

test('console automation is labeled as a test actor throughout the displayed handoff', () => {
  const projection = buildTimeline({ events: [
    event('test.actor', { actor: 'automated_test_actor', humanParticipant: false }),
    event('run.started', { mode: 'replay', goal: 'Read balance' }),
    event('human.action', { actor: 'automated_test_actor', action: { type: 'click', target: target('Restore session') } }),
  ] });
  assert.equal(projection.operatorTestActor, true);
  assert.match(projection.items.find(item => item.kind === 'test').detail, /no human participant/i);
  assert.ok(projection.items.some(item => item.title === 'Automated console test actor · Click · Restore session'));
});

test('bounded live history accepts an authoritative total count without copying raw payloads', () => {
  const projection = buildTimeline({ events: [
    event('run.started', { mode: 'discovery', goal: 'Look up member 12345', inputs: { member_id: '12345' } }),
    event('model.observed', { observation: { full_name: 'Private Person', text: 'password=hunter2 account 123456789' } }),
    event('run.stopped', { status: 'failure', code: 'EXECUTION_ERROR', detail: 'Private error contents' }),
  ], modelCalls: 9, result: { status: 'failure', modelCalls: 8, token: 'secret-token', observed: { full_name: 'Private Person' }, outputs: { balance: '$99.00' } } });
  assert.equal(projection.modelCalls, 9);
  assert.doesNotMatch(JSON.stringify(projection), /12345|Private Person|hunter2|123456789|secret-token|99\.00|Private error contents/);
  assert.equal(buildTimeline({ events: [event('model.observed')], modelCalls: -1, result: { modelCalls: NaN } }).modelCalls, 1);
});

test('sequence gaps identify omitted older history while future steps remain planned', () => {
  const projection = buildTimeline({ events: [
    event('run.started', { sequence: 1, mode: 'replay', plan: [{ id: 'old', title: 'Older step' }, { id: 'current', title: 'Current step' }, { id: 'future', title: 'Future step' }] }),
    event('action.started', { sequence: 100, step: 'current', action: { type: 'click', target: target('Search') } }),
  ] });
  assert.equal(projection.historyTruncated, true);
  assert.equal(projection.steps[0].state, 'history_omitted');
  assert.equal(projection.steps[1].state, 'started');
  assert.equal(projection.steps[2].state, 'planned');
  assert.equal(buildTimeline({ events: [event('run.started', { sequence: 1 }), event('action.started', { sequence: 2, step: 'step-1' })] }).historyTruncated, false);
});

test('checked discovery evidence has five decisions and only four application steps', async () => {
  const text = await readFile(new URL('../evidence/discovery/events.jsonl', import.meta.url), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  const projection = buildTimeline({ events });
  assert.equal(projection.modelCalls, 5);
  assert.equal(projection.steps.length, 4);
  assert.equal(projection.items.filter(item => item.kind === 'proposal').length, 5);
  assert.equal(projection.items.filter(item => item.kind === 'action' && item.state === 'completed').length, 4);
  assert.equal(projection.checkpointTelemetryAvailable, false);
  assert.ok(projection.steps.every(step => step.checkpoints.before === 'not_recorded'));
});

// A deliberately small DOM records text insertion and rejects every HTML sink.
// Running the actual shipped renderer here verifies that malicious text remains
// text, rather than relying only on source-string matching.
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.className = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
  set innerHTML(_value) { throw new Error('Unsafe HTML sink'); }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this._text = ''; this.children = values; }
  matches(selector) { return selector.startsWith('.') && this.className.split(' ').includes(selector.slice(1)); }
  querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
}
function documentFixture() {
  const doc = { createElement: tag => new Element(tag, doc), ids: {} };
  const mount = doc.createElement('div'); mount.className = 'relay-timeline-mount';
  doc.querySelector = selector => mount.matches(selector) ? mount : mount.querySelector(selector);
  doc.getElementById = id => doc.ids[id];
  for (const id of ['integrity', 'reported-result', 'timeline-error']) doc.ids[id] = doc.createElement('p');
  return { doc, mount };
}
function scriptOf(html) { return html.match(/<script>([\s\S]*)<\/script>/)[1]; }

test('the renderer uses text for malicious labels and keeps private bodies outside HTML', () => {
  const { doc, mount } = documentFixture();
  const context = vm.createContext({ document: doc });
  vm.runInContext(timelineScript, context);
  const payload = '</script><img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true';
  const projection = buildTimeline({ events: [event('run.started', { mode: 'replay', goal: payload }), event('action.started', { step: payload, action: { type: 'click', target: target(payload), value: 'private-entered-value' } })] });
  context.renderRelayTimeline(mount, projection);
  assert.equal(context.pwned, undefined);
  assert.match(mount.textContent, /<img src=x/);
  const html = renderTimelineHtml(projection, { title: payload, subtitle: payload });
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.doesNotMatch(html, /<img src=x|private-entered-value/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test('displayed goals and final positions are readable without changing event metadata', () => {
  const { doc, mount } = documentFixture();
  const context = vm.createContext({ document: doc }); vm.runInContext(timelineScript, context);
  const goal = 'Look up member {{member_id}} and read their savings balance';
  const projection = buildTimeline({ events: [event('run.started', { mode: 'discovery', goal }), event('capability.recorded', { capability: 'member.lookup', steps: 4 })] });
  context.renderRelayTimeline(mount, { ...projection, currentPhase: 'action' });
  assert.match(mount.querySelector('.relay-metrics').textContent, /Capability saved/);
  assert.doesNotMatch(mount.querySelector('.relay-metrics').textContent, /Recorded boundary|Application action/);
  assert.match(mount.querySelector('h2')?.textContent || mount.textContent, /Look up a member and read their savings balance/);
  assert.equal(projection.goal, goal);
  context.renderRelayTimeline(mount, { ...projection, items: [], currentStep: 'step-5', currentPhase: 'success', status: 'evidence_conflict', historyTruncated: true, steps: [{ id: 'old', title: 'Older step', state: 'history_omitted' }] });
  assert.match(mount.querySelector('.relay-metrics').textContent, /Goal verification/);
  assert.doesNotMatch(mount.querySelector('.relay-metrics').textContent, /Recorded boundary/);
  assert.match(mount.textContent, /Evidence conflict|Earlier events omitted/);
  assert.match(mount.textContent, /Earlier events are omitted from this view/);
});

test('saved viewer clears invalid evidence, distinguishes legacy success, and marks disconnection stale', async () => {
  const { doc, mount } = documentFixture();
  const initial = buildTimeline({ events: [event('run.started', { mode: 'discovery', goal: 'Original goal' })] });
  let response = { ok: true, json: async () => ({ timeline: initial, integrity: { state: 'verified', message: 'Saved event chain verified.' }, result: { state: 'legacy', message: 'Separate result has no bound run identity.', reported: { status: 'success' } } }) };
  const context = vm.createContext({ document: doc, fetch: async () => { if (response instanceof Error) throw response; return response; }, setInterval: () => 1 });
  vm.runInContext(scriptOf(renderTimelineHtml(initial, { stateUrl: '/state', saved: true })), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(mount.textContent, /Earlier recording · reported success/);
  assert.equal(doc.ids.integrity.textContent, 'Verified saved event log · Read-only');
  assert.equal(doc.ids['reported-result'].textContent, 'Earlier recording: saved result reports Success; the final status event was not recorded.');
  assert.match(mount.textContent, /Checkpoint telemetry was not recorded/);
  response = { ok: false, json: async () => ({ timeline: buildTimeline({ events: [] }), integrity: { state: 'invalid', message: 'Evidence integrity check failed.' }, result: { state: 'missing' } }) };
  await vm.runInContext('updateTimeline()', context);
  assert.doesNotMatch(mount.textContent, /Original goal|reported success/);
  assert.match(doc.ids.integrity.textContent, /integrity check failed/);
  assert.match(doc.ids['timeline-error'].textContent, /were cleared/);
  response = new Error('offline');
  await vm.runInContext('updateTimeline()', context);
  assert.match(mount.textContent, /Connection lost · stale events/);
  assert.match(doc.ids['timeline-error'].textContent, /events are stale/);
});

test('viewer refreshes only a configured local path', () => {
  for (const stateUrl of ['https://example.test/state', '//example.test/state', '/state?token=secret', 'javascript:alert(1)']) assert.throws(() => renderTimelineHtml({}, { stateUrl }), /local absolute path/);
  assert.throws(() => renderTimelineHtml({}, { stateUrl: '/state', pollInterval: 10 }), /between 500/);
  const html = renderTimelineHtml({}, { stateUrl: '/state', saved: true });
  assert.doesNotMatch(html, /method:['"]POST|\/claim|\/resume|\/action/);
});
