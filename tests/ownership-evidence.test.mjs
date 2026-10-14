import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ownership } from '../src/ownership.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { safeAct } from '../src/engine.mjs';

function recorder() {
  const events = [];
  return { events, async event(type, data) { events.push({ type, data }); } };
}

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function temporaryEvidence(t, secrets = []) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-evidence-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = new Evidence(directory, secrets);
  await evidence.init();
  return { evidence, directory, log: join(directory, 'events.jsonl') };
}

test('ownership fences every stale ticket across pause, claim, and resume on one session', async () => {
  const evidence = recorder();
  const ownership = new Ownership(evidence);
  const original = ownership.ticket();
  const sessionId = original.sessionId;
  assert.equal(await ownership.execute(original, 'automation', async () => 'first'), 'first');
  await ownership.pause({ code: 'SESSION_EXPIRED', step: 'search', expected: [] });
  assert.equal(ownership.owner, 'paused');
  assert.equal(ownership.pending.sessionId, sessionId);
  await assert.rejects(ownership.execute(original, 'automation', async () => 'forbidden'), { code: 'CONTROL_FENCED' });
  const paused = ownership.ticket();
  const human = await ownership.claim();
  assert.equal(ownership.owner, 'human');
  assert.equal(human.sessionId, sessionId);
  assert.equal(await ownership.execute(human, 'human', async () => 'manual'), 'manual');
  assert.throws(() => ownership.assert(paused, 'human'), { code: 'CONTROL_FENCED' });
  await ownership.resume();
  assert.equal(ownership.owner, 'automation');
  assert.equal(ownership.pending, null);
  assert.throws(() => ownership.assert(original), { code: 'CONTROL_FENCED' });
  assert.throws(() => ownership.assert(human, 'human'), { code: 'CONTROL_FENCED' });
  assert.equal(await ownership.execute(ownership.ticket(), 'automation', async () => 'resumed'), 'resumed');
  assert.equal(ownership.ticket().sessionId, sessionId);
  assert.deepEqual(evidence.events.map((event) => event.type), ['intervention.requested', 'control.transferred', 'control.transferred']);
  assert.deepEqual(evidence.events.map((event) => event.data.epoch), [2, 3, 4]);
});

test('concurrent actions are blocked and action failures release the lease', async () => {
  const ownership = new Ownership(recorder());
  const held = gate();
  const active = ownership.execute(ownership.ticket(), 'automation', () => held.promise);
  assert.equal(ownership.inFlight, true);
  await assert.rejects(ownership.execute(ownership.ticket(), 'automation', async () => 'overlap'), { code: 'CONTROL_BUSY' });
  await assert.rejects(ownership.pause({ code: 'MANUAL_REQUEST' }));
  held.resolve('completed');
  assert.equal(await active, 'completed');
  assert.equal(ownership.inFlight, false);
  await assert.rejects(ownership.execute(ownership.ticket(), 'automation', async () => { throw new Error('Synthetic action failure'); }), /Synthetic action failure/);
  assert.equal(ownership.inFlight, false);
  assert.equal(await ownership.execute(ownership.ticket(), 'automation', async () => 'next'), 'next');
});

test('a paused session cannot execute actions and an in-flight human cannot transfer ownership', async () => {
  const ownership = new Ownership(recorder());
  await ownership.pause({ code: 'MANUAL_REQUEST' });
  await assert.rejects(ownership.execute(ownership.ticket(), 'paused', async () => 'forbidden'), { code: 'CONTROL_FENCED' });
  // Defend the transfer boundary even if an adapter incorrectly marks a paused
  // session active: claim must not transfer a session with unfinished work.
  ownership.inFlight = true;
  await assert.rejects(ownership.claim());
  ownership.inFlight = false;
  const ticket = await ownership.claim();
  const held = gate();
  const active = ownership.execute(ticket, 'human', () => held.promise);
  await assert.rejects(ownership.resume());
  assert.equal(ownership.owner, 'human');
  held.resolve();
  await active;
  const waiting = ownership.waitForResume(1000);
  await ownership.resume();
  await waiting;
  assert.equal(ownership.owner, 'automation');
});

test('an automation command retains its original ticket across asynchronous target resolution', async () => {
  const ownership = new Ownership(recorder());
  const held = gate();
  let performed = false;
  const action = { type: 'click', target: { strategies: [{ kind: 'role', role: 'button', name: 'Continue' }] } };
  const surface = {
    page: { url: () => 'http://127.0.0.1:4173/bank' },
    describeAction: () => held.promise,
    async act() { performed = true; },
  };
  const policy = { assertUrl() {}, assertAction() {} };
  const pendingAction = safeAct(surface, policy, ownership, action, {});
  await ownership.pause({ code: 'OPERATOR_TAKEOVER' });
  await ownership.claim();
  await ownership.resume();
  held.resolve(action);
  await assert.rejects(pendingAction, { code: 'CONTROL_FENCED' });
  assert.equal(performed, false);
});

test('concurrent evidence events are serialized into a verifiable ordered hash chain', async (t) => {
  const { evidence, log } = await temporaryEvidence(t, ['synthetic-private-token']);
  await Promise.all(Array.from({ length: 40 }, (_, index) => evidence.event('test.event', { index, member_id: '12345', note: 'synthetic-private-token' })));
  const verified = await verifyLog(log);
  assert.equal(verified.events, 40);
  const raw = await readFile(log, 'utf8');
  assert.ok(!raw.includes('12345'));
  assert.ok(!raw.includes('synthetic-private-token'));
  const events = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.index), Array.from({ length: 40 }, (_, index) => index));
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal(verified.finalHash, events.at(-1).hash);
  assert.equal(events[0].previousHash, '0'.repeat(64));
});

test('returned typed outputs stay in caller memory and persisted results redact them', async (t) => {
  const { evidence, directory } = await temporaryEvidence(t, ['synthetic-secret']);
  const result = { status: 'success', outputs: { savings_balance: { currency: 'USD', minorUnits: 1248050 }, message: 'confidential output' }, context: { member_id: '12345', token: 'synthetic-secret' } };
  assert.equal(await evidence.result(result), result);
  assert.equal(result.outputs.savings_balance.minorUnits, 1248050);
  const persisted = await readFile(join(directory, 'result.json'), 'utf8');
  for (const value of ['1248050', '12345', 'synthetic-secret', 'confidential output']) assert.ok(!persisted.includes(value));
  const safe = JSON.parse(persisted);
  assert.equal(safe.outputs.savings_balance, '[REDACTED]');
  assert.equal(safe.outputs.message, '[REDACTED]');
});

test('evidence verification rejects modified events and broken ordering', async (t) => {
  const { evidence, log } = await temporaryEvidence(t);
  await evidence.event('first', { note: 'original' });
  await evidence.event('second');
  const original = await readFile(log, 'utf8');
  await writeFile(log, original.replace('original', 'modified'));
  await assert.rejects(verifyLog(log), /integrity/i);
  await writeFile(log, original.trim().split('\n').reverse().join('\n') + '\n');
  await assert.rejects(verifyLog(log), /integrity/i);
});

test('reinitializing a run directory cannot leave a stale sequence or previous hash', async (t) => {
  const { evidence, log } = await temporaryEvidence(t);
  await evidence.event('before.init');
  await evidence.init();
  await evidence.event('after.init');
  const verified = await verifyLog(log);
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(verified.events, lines.length);
  assert.equal(lines[0].sequence, 1);
  assert.equal(lines[0].previousHash, '0'.repeat(64));
  const replacement = new Evidence(evidence.directory);
  await replacement.init();
  await replacement.event('new.instance');
  assert.equal((await verifyLog(log)).events, 1);
});

test('live evidence snapshots stay redacted, retain the run start, and reset for a new run', async (t) => {
  const { evidence } = await temporaryEvidence(t, ['PRIVATE-INPUT']);
  await evidence.event('run.started', { mode: 'discovery', goal: 'Read a balance' });
  await evidence.event('model.observed', { observation: { text: 'PRIVATE-INPUT' } });
  for (let index = 0; index < 515; index++) await evidence.event('human.action', { index });
  await evidence.result({ status: 'success', modelCalls: 1, outputs: { savings_balance: { currency: 'USD', minorUnits: 812500 } } });
  const state = await evidence.snapshotState();
  assert.equal(state.events[0].type, 'run.started');
  assert.equal(state.modelCalls, 1, 'count survives the bounded recent-event history');
  assert.ok(state.events.length <= 513);
  assert.equal(state.result.outputs.savings_balance, '[REDACTED]');
  assert.ok(!JSON.stringify(state).includes('PRIVATE-INPUT'));
  assert.ok(!JSON.stringify(state).includes('812500'));
  state.result.status = 'changed';
  assert.equal((await evidence.snapshotState()).result.status, 'success', 'callers cannot mutate recording state');
  await evidence.init();
  assert.deepEqual(await evidence.snapshotState(), { events: [], result: null, modelCalls: 0 });
});
