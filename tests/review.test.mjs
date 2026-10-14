import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Evidence } from '../src/evidence.mjs';
import { ReviewServer, readSavedReview } from '../src/review.mjs';

async function inDirectory(task) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-review-'));
  try { return await task(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function recordRun(directory, { complete = true, mode = 'replay', modelCalls = 0 } = {}) {
  const evidence = new Evidence(directory);
  await evidence.init();
  await evidence.event('run.started', { mode, goal: 'Read savings for {{member_id}}', modelCalls: 0 });
  await evidence.event('action.started', { step: 'find-member', action: { type: 'fill', target: { strategies: [{ kind: 'row', label: 'Member ID', control: 'input' }] }, value: { param: 'member_id' } }, observation: { text: 'OBSERVATION_PRIVATE_MARKER' }, inputs: { private: 'INPUT_PRIVATE_MARKER' }, outputs: { private: 'OUTPUT_PRIVATE_MARKER' } });
  await evidence.event('action.completed', { step: 'find-member', action: { type: 'fill', target: { strategies: [{ kind: 'row', label: 'Member ID', control: 'input' }] } } });
  await evidence.event('checkpoint.passed', { step: 'find-member', phase: 'after', conditionCount: 1 });
  if (complete) {
    await evidence.event('run.completed', { status: 'success', modelCalls, handoffs: 0, outputNames: ['savings_balance'] });
    await evidence.result({ status: 'success', code: 'GOAL_VERIFIED', modelCalls, handoffs: 0, sessionId: randomUUID(), outputs: { savings_balance: '$8,125.00' }, observed: { text: 'RESULT_PRIVATE_MARKER' } });
  }
  return evidence;
}

test('saved review exposes only verified allowlisted presentation fields', async () => inDirectory(async directory => {
  const evidence = await recordRun(directory);
  const state = await readSavedReview(directory);
  assert.equal(state.readOnly, true);
  assert.equal(state.label, 'Saved run / read-only');
  assert.equal(state.integrity.state, 'verified');
  assert.equal(state.integrity.runState, 'completed');
  assert.equal(state.source.runId, evidence.runId);
  assert.equal(state.result.state, 'matched');
  assert.equal(state.timeline.status, 'success');
  const serialized = JSON.stringify(state);
  for (const marker of ['OBSERVATION_PRIVATE_MARKER', 'INPUT_PRIVATE_MARKER', 'OUTPUT_PRIVATE_MARKER', 'RESULT_PRIVATE_MARKER', '$8,125.00']) assert.equal(serialized.includes(marker), false);
  for (const field of ['observation', 'observed', 'outputs', 'inputs', 'decision', 'previousHash']) assert.equal(serialized.includes(`"${field}"`), false);
  assert.equal(state.timeline.steps[0].state, 'verified');
  assert.equal(state.timeline.steps[0].checkpoints.after, 'passed');
}));

test('saved review distinguishes missing, empty, and incomplete runs', async () => inDirectory(async directory => {
  assert.equal((await readSavedReview(directory)).integrity.state, 'missing');
  await writeFile(join(directory, 'events.jsonl'), '');
  assert.equal((await readSavedReview(directory)).integrity.state, 'empty');
  await recordRun(directory, { complete: false });
  const incomplete = await readSavedReview(directory);
  assert.equal(incomplete.integrity.state, 'verified');
  assert.equal(incomplete.integrity.runState, 'incomplete');
  assert.notEqual(incomplete.timeline.status, 'success');
  assert.equal(incomplete.result.state, 'missing');
}));

test('corruption and complete malformed records never produce a saved timeline', async () => inDirectory(async directory => {
  await recordRun(directory);
  const path = join(directory, 'events.jsonl');
  const valid = await readFile(path, 'utf8');
  await writeFile(path, valid.replace('Read savings', 'Tampered savings'));
  const corrupted = await readSavedReview(directory);
  assert.equal(corrupted.integrity.state, 'invalid');
  assert.equal(corrupted.timeline.items.length, 0);
  assert.notEqual(corrupted.timeline.status, 'success');
  await writeFile(path, '{"hash":"invalid"}');
  assert.equal((await readSavedReview(directory)).integrity.state, 'invalid');
  await writeFile(path, '{"hash":');
  assert.equal((await readSavedReview(directory)).integrity.state, 'updating');
}));

test('mismatched result identity or telemetry cannot make the run successful', async () => inDirectory(async directory => {
  const evidence = await recordRun(directory);
  const path = join(directory, 'result.json');
  const result = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...result, runId: randomUUID() }));
  let state = await readSavedReview(directory);
  assert.equal(state.result.state, 'mismatch');
  assert.equal(state.timeline.status, 'evidence_conflict');
  await writeFile(path, JSON.stringify({ ...result, runId: evidence.runId, modelCalls: 17 }));
  state = await readSavedReview(directory);
  assert.equal(state.result.state, 'mismatch');
  assert.equal(state.timeline.modelCalls, 0);
}));

test('legacy result is explicitly separate; a result without a terminal event stays unconfirmed', async () => inDirectory(async directory => {
  await recordRun(directory);
  const path = join(directory, 'result.json');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  delete legacy.runId;
  await writeFile(path, JSON.stringify(legacy));
  const state = await readSavedReview(directory);
  assert.equal(state.result.state, 'legacy');
  assert.match(state.result.message, /Earlier log format: result stored separately/);
  assert.equal(state.result.reported.status, 'success');
  assert.equal(state.timeline.status, 'success', 'completion remains a fact of the verified log');
  const evidence = await recordRun(directory, { complete: false });
  await evidence.result({ status: 'success', code: 'GOAL_VERIFIED', modelCalls: 0 });
  const pending = await readSavedReview(directory);
  assert.equal(pending.result.state, 'pending');
  assert.equal(Object.hasOwn(pending.result.reported, 'status'), false);
  assert.notEqual(pending.timeline.status, 'success');
}));

test('mixed run identities fail even when a writer recomputes a valid hash chain', async () => inDirectory(async directory => {
  const evidence = await recordRun(directory, { complete: false });
  evidence.runId = randomUUID();
  await evidence.event('action.completed', { step: 'second-run', action: { type: 'click' } });
  const state = await readSavedReview(directory);
  assert.equal(state.integrity.state, 'invalid');
  assert.equal(state.timeline.items.length, 0);
}));

test('review constructor has a fixed directory and bounded loopback port', () => {
  assert.throws(() => new ReviewServer(), TypeError);
  for (const port of [-1, 65536, 1.5, '4181']) assert.throws(() => new ReviewServer({ directory: '.', port }), TypeError);
});

function httpGet(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('saved review HTTP is local, read-only, noncached, and follows saved file updates', { skip: process.env.RELAY_HTTP_TESTS !== '1' }, async () => inDirectory(async directory => {
  const evidence = await recordRun(directory, { complete: false });
  const server = new ReviewServer({ directory, port: 0 });
  try {
    await server.start();
    assert.equal(server.baseUrl, `http://127.0.0.1:${server.port}`);
    const page = await httpGet(server.baseUrl + '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /Saved run \/ read-only/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.headers['cache-control'], /no-store/);
    const first = JSON.parse((await httpGet(server.baseUrl + '/state')).body);
    await evidence.event('checkpoint.passed', { step: 'find-member', phase: 'before', conditionCount: 1 });
    const updated = JSON.parse((await httpGet(server.baseUrl + '/state')).body);
    assert.equal(updated.integrity.events, first.integrity.events + 1);
    for (const path of ['/claim', '/resume', '/action', '/state?directory=/private/tmp', '/events.jsonl']) assert.equal((await httpGet(server.baseUrl + path)).status, 404);
    assert.equal((await httpGet(server.baseUrl + '/state', {}, 'POST')).status, 405);
    assert.equal((await httpGet(server.baseUrl + '/state', { Host: `localhost:${server.port}` })).status, 403);
    assert.equal((await httpGet(server.baseUrl + '/state', { Origin: 'https://example.test' })).status, 403);
    await writeFile(join(directory, 'events.jsonl'), '{"invalid":true}\n');
    const invalid = await httpGet(server.baseUrl + '/state');
    assert.equal(invalid.status, 409);
    assert.equal(JSON.parse(invalid.body).integrity.state, 'invalid');
  } finally { await server.close(); }
}));
