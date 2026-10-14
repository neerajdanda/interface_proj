import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFileConsoleTransport } from '../tools/file-console-transport.mjs';
import { OperatorConsole } from '../src/operator.mjs';
import { Ownership } from '../src/ownership.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Policy } from '../src/policy.mjs';

test('explicit file pump runs original console handler with auth, leases, actor evidence, and binary response intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-file-console-'));
  const transport = await createFileConsoleTransport({ directory: join(directory, 'ipc'), port: 4184 });
  const evidence = new Evidence(join(directory, 'evidence')); await evidence.init();
  const ownership = new Ownership(evidence);
  const policy = new Policy({ baseUrl: 'http://127.0.0.1:4173' });
  const target = { frame: 'Member workspace', strategies: [{ kind: 'role', role: 'button', name: 'Restore session' }] };
  const actions = [];
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const surface = {
    page: { url: () => policy.baseUrl + 'bank' },
    async observe() { return { controls: [{ role: 'button', name: 'Restore session', target }], text: 'Session expired' }; },
    async describeAction(action) { return action; },
    async act(action) { assert.equal(ownership.owner, 'human'); actions.push(action); },
    async screenshot() { return png; },
  };
  const notices = [];
  const operator = new OperatorConsole({ port: 4184, actor: 'automated_test_actor', serverFactory: transport.serverFactory, logger: message => notices.push(message) });
  operator.runner = { surface, policy, evidence, ownership };
  await operator.start();
  assert.deepEqual(notices, ['Operator console: http://127.0.0.1:4184\n']);
  const request = async (url, body, extra = {}) => {
    const id = randomUUID();
    await writeFile(join(transport.directory, 'requests', id + '.request.json'), JSON.stringify({ method: body === undefined ? 'GET' : 'POST', url, headers: { host: '127.0.0.1:4184', 'x-relay-token': operator.token, origin: 'http://127.0.0.1:4184', ...extra }, body: body === undefined ? '' : JSON.stringify(body) }));
    assert.equal((await transport.pump()).processed, 1);
    const response = JSON.parse(await readFile(join(transport.directory, 'responses', id + '.response.json'), 'utf8'));
    return { ...response, body: Buffer.from(response.bodyBase64, 'base64') };
  };
  try {
    const page = await request('/'); assert.equal(page.status, 200); assert.match(page.body.toString('utf8'), /Return control/);
    assert.equal((await request('/state', undefined, { 'x-relay-token': 'incorrect' })).status, 403);
    assert.equal((await request('/claim', {}, { origin: 'https://other.example' })).status, 403);
    assert.equal((await request('/claim', {})).status, 409);
    await ownership.pause({ code: 'SESSION_EXPIRED', step: 'step-2', phase: 'after' });
    assert.equal((await request('/claim', {})).status, 200);
    const ticket = ownership.ticket();
    assert.equal((await request('/action', { ticket, action: { type: 'click', target } })).status, 200);
    assert.equal(actions.length, 1);
    assert.equal((await request('/resume', { ticket })).status, 200);
    assert.equal((await request('/action', { ticket, action: { type: 'click', target } })).status, 409);
    assert.deepEqual((await request('/preview')).body, png);
    const records = (await readFile(join(evidence.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.find(event => event.type === 'human.action').actor, 'automated_test_actor');
    assert.equal((await verifyLog(join(evidence.directory, 'events.jsonl'))).events, records.length);
    await operator.close();
    assert.deepEqual(await transport.pump(), { processed: 0, closed: true });
  } finally { await operator.close(); await rm(directory, { recursive: true, force: true }); }
});

test('oversized IPC input is rejected before dispatch without reflecting its sensitive body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-file-console-limit-'));
  try {
    const transport = await createFileConsoleTransport({ directory, port: 4184 });
    let invoked = false;
    transport.serverFactory(async () => { invoked = true; });
    const id = randomUUID();
    await writeFile(join(directory, 'requests', id + '.request.json'), JSON.stringify({ method: 'POST', url: '/action', headers: {}, body: 'PRIVATE'.repeat(3000) }));
    assert.equal((await transport.pump()).processed, 1);
    assert.equal(invoked, false);
    const response = JSON.parse(await readFile(join(directory, 'responses', id + '.response.json'), 'utf8'));
    assert.equal(response.status, 500);
    assert.doesNotMatch(Buffer.from(response.bodyBase64, 'base64').toString('utf8'), /PRIVATE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
