import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, validateCapability, validateInputs, validateDecision, extractMoney } from '../src/contract.mjs';
import { Policy, PolicyError, scrub } from '../src/policy.mjs';
import { Ownership } from '../src/ownership.mjs';

const frame = 'Member workspace';
const heading = name => ({ frame, strategies: [{ kind: 'role', role: 'heading', name }] });
const button = name => ({ frame, strategies: [{ kind: 'role', role: 'button', name }] });
const row = (label, control) => ({ frame, strategies: [{ kind: 'row', label, control }] });
const visible = target => ({ target, op: 'visible' });

function capability() {
  return {
    schemaVersion: '1.0.0',
    id: 'northstar.savings-inquiry',
    name: 'Read a savings balance',
    description: 'Find one member and read the savings account ledger.',
    vendor: { product: 'relay-sandbox', version: '1' },
    entry: { path: '/bank', frame },
    inputs: { member_id: { type: 'string', pattern: '^[0-9]{5}$', sensitive: true } },
    outputs: { savings_balance: { type: 'money', sensitive: true, target: row('Savings balance', 'text') } },
    steps: [
      { id: 'fill-member', action: { type: 'fill', target: row('Member ID', 'input'), value: { param: 'member_id' } }, before: [visible(heading('Find a member'))], after: [], effect: 'reversible', retry: { maxAttempts: 1 } },
      { id: 'search', action: { type: 'click', target: button('Search') }, before: [visible(heading('Find a member'))], after: [visible(heading('Search results'))], effect: 'read', retry: { maxAttempts: 1 } },
      { id: 'open-member', action: { type: 'click', target: button('Open member') }, before: [visible(heading('Search results'))], after: [visible(heading('Member overview'))], effect: 'read', retry: { maxAttempts: 1 } },
      { id: 'open-summary', action: { type: 'click', target: button('Account summary') }, before: [visible(heading('Member overview'))], after: [visible(heading('Account summary'))], effect: 'read', retry: { maxAttempts: 1 } },
    ],
    success: [visible(heading('Account summary')), { target: row('Member ID', 'text'), op: 'text_equals', value: { param: 'member_id' } }],
    outcomes: [{ code: 'MEMBER_NOT_FOUND', when: visible(heading('Member not found')) }],
    recoveries: [{ code: 'SERVICE_NOTICE', when: visible({ frame, strategies: [{ kind: 'role', role: 'dialog', name: 'Service notice' }] }), action: { type: 'click', target: button('Continue') }, maxAttempts: 1 }],
    review: { state: 'draft' },
    provenance: { mode: 'codex-bridge', model: 'Codex live session' },
  };
}

test('one capability accepts distinct invocation values without embedding either value', () => {
  const cap = capability();
  assert.equal(validateCapability(cap), cap);
  for (const member_id of ['12345', '67890']) {
    const args = { member_id };
    assert.equal(validateInputs(cap, args), args);
    assert.equal(JSON.stringify(cap).includes(member_id), false);
  }
});

test('capability execution channels, unbound inputs, and unsupported contracts are rejected', () => {
  const cases = [
    cap => { cap.schemaVersion = '2.0.0'; },
    cap => { cap.steps[0].action.value = { param: 'account_number' }; },
    cap => { cap.steps[1].action.selector = 'button'; },
    cap => { cap.steps[1].action.target.strategies = [{ kind: 'css', selector: 'body' }]; },
    cap => { cap.steps[1].action.target.strategies[0].evaluate = 'alert(1)'; },
    cap => { cap.steps[1].action = { type: 'navigate', url: 'https://example.com' }; },
    cap => { cap.steps[1].id = cap.steps[0].id; },
    cap => { cap.success = []; },
    cap => { cap.success[1].value = { param: 'account_number' }; },
    cap => { cap.outputs.savings_balance.sensitive = false; },
    cap => { cap.steps[1].effect = 'irreversible'; cap.steps[1].retry.maxAttempts = 2; },
  ];
  for (const mutate of cases) {
    const cap = capability();
    mutate(cap);
    assert.throws(() => validateCapability(cap), ContractError);
  }
});

test('raw invocation data and sensitive metadata cannot become an artifact literal', () => {
  for (const literal of ['12345', '$12,480.50', '123-45-6789', '123456789012', 'password=merchant-secret', 'member@example.test', 'Bearer token-value', 'sk-abcdefghijklmnop']) {
    const cap = capability();
    cap.description = `Recorded context ${literal}`;
    assert.throws(() => validateCapability(cap), error => error instanceof ContractError && error.code === 'SENSITIVE_LITERAL');
  }
  const cap = capability();
  cap.steps[0].action.value = '12345';
  assert.throws(() => validateCapability(cap), error => error.code === 'SENSITIVE_LITERAL');
});

test('input rejection does not echo the rejected value', () => {
  const cap = capability();
  const invalid = ['1234', '123456', 'abcde', '12345\n', 12345, null, { toString: () => '12345' }];
  for (const member_id of invalid) {
    assert.throws(() => validateInputs(cap, { member_id }), error => {
      assert.ok(error instanceof ContractError);
      if (typeof member_id === 'string' && member_id.trim()) assert.equal(error.message.includes(member_id), false);
      return true;
    });
  }
  assert.throws(() => validateInputs(cap, { member_id: '12345', unapproved: 'extra' }), ContractError);
  assert.throws(() => validateInputs(cap, Object.create({ member_id: '12345' })), ContractError);
});

test('untrusted model decisions have a strict, non-executable vocabulary', () => {
  const decision = { kind: 'action', action: { type: 'fill', target: row('Member ID', 'input'), value: { param: 'member_id' } }, before: [visible(heading('Find a member'))], after: [], reason: 'Provide the declared lookup input.' };
  assert.equal(validateDecision(decision), decision);
  for (const key of ['url', 'script', 'css', 'selector', 'evaluate', 'key']) {
    const malicious = structuredClone(decision);
    malicious.action[key] = 'untrusted';
    assert.throws(() => validateDecision(malicious), ContractError);
  }
  assert.throws(() => validateDecision({ kind: 'finish', action: decision.action }), ContractError);
  assert.throws(() => validateDecision({ kind: 'action', action: { type: 'click', target: { strategies: [] } } }), ContractError);
});

test('model finish declares a checked output contract and wait cannot become unbounded', () => {
  const cap = capability();
  const finish = { kind: 'finish', success: cap.success, outputs: cap.outputs, before: [], after: [], reason: 'The account summary exposes the requested ledger row.' };
  assert.equal(validateDecision(finish), finish);
  assert.throws(() => validateDecision({ kind: 'finish', success: [], outputs: cap.outputs }), ContractError);
  for (const ms of [-1, 0, 1001, Infinity, '100']) assert.throws(() => validateDecision({ kind: 'action', action: { type: 'wait', ms } }), ContractError);
  assert.doesNotThrow(() => validateDecision({ kind: 'action', action: { type: 'wait', ms: 100 }, before: cap.success, after: [] }));
});

test('money outputs retain exact cents and reject ambiguous or rounded amounts', () => {
  assert.deepEqual(extractMoney('$12,480.50'), { currency: 'USD', minorUnits: 1248050 });
  assert.deepEqual(extractMoney('USD 0.01'), { currency: 'USD', minorUnits: 1 });
  assert.deepEqual(extractMoney('-$8,125.00'), { currency: 'USD', minorUnits: -812500 });
  for (const text of ['$1.005', '$1,23.00', '$01.00', '$1.00 USD', '$1e3.00', 'Balance $1.00', '$90071992547409.92', '$-0.0']) {
    assert.throws(() => extractMoney(text), error => error instanceof ContractError && error.code === 'INVALID_OUTPUT');
  }
});

test('policy requires an exact origin and a bounded route prefix', () => {
  const policy = new Policy({ baseUrl: 'http://127.0.0.1:4173' });
  assert.equal(policy.assertUrl('/bank?scenario=normal'), 'http://127.0.0.1:4173/bank?scenario=normal');
  assert.equal(policy.assertUrl('/workspace'), 'http://127.0.0.1:4173/workspace');
  for (const url of [
    'http://127.0.0.1:4174/bank', 'http://localhost:4173/bank', 'https://127.0.0.1:4173/bank',
    'http://127.0.0.1.evil.test:4173/bank', '//example.test/bank',
    'http://user:password@127.0.0.1:4173/bank', '/bankruptcy', '/bank/../transfer',
    '/workspace%2f..%2ftransfer', 'javascript:alert(1)', 'file:///bank',
  ]) assert.throws(() => policy.assertUrl(url), error => error instanceof PolicyError && error.code === 'URL_DENIED');
});

test('invalid policy configuration fails before a browser starts', () => {
  for (const config of [
    { baseUrl: 'file:///bank' }, { baseUrl: 'http://user:pass@127.0.0.1:4173' },
    { baseUrl: 'http://127.0.0.1:4173', allowedPaths: ['/'] },
    { baseUrl: 'http://127.0.0.1:4173', allowedPaths: ['/bank*'] },
    { baseUrl: 'http://127.0.0.1:4173', allowedActions: ['evaluate'] },
  ]) assert.throws(() => new Policy(config), PolicyError);
});

test('a model cannot relabel an observed risky control or self-authorize its effect', () => {
  const policy = new Policy({ baseUrl: 'http://127.0.0.1:4173' });
  const harmlessClaim = { type: 'click', target: button('Continue') };
  assert.equal(policy.assertAction(harmlessClaim, { effect: 'read', observedTarget: { role: 'button', name: 'Continue' } }), harmlessClaim);
  assert.throws(() => policy.assertAction(harmlessClaim, { effect: 'read', observedTarget: { role: 'button', name: 'Submit transfer' } }), error => error.code === 'IRREVERSIBLE_ACTION');
  assert.throws(() => policy.assertAction({ type: 'click', target: button('Submit transfer') }, { effect: 'read' }), error => error.code === 'IRREVERSIBLE_ACTION');
  assert.throws(() => policy.assertAction(harmlessClaim, { effect: 'irreversible' }), error => error.code === 'IRREVERSIBLE_ACTION');
  assert.equal(policy.assertAction(harmlessClaim, { owner: 'human' }), harmlessClaim);
  assert.throws(() => policy.assertAction(harmlessClaim, { owner: 'paused' }), error => error.code === 'CONTROL_NOT_OWNED');
  assert.throws(() => new Policy({ baseUrl: 'http://127.0.0.1:4173', allowedActions: ['read'] }).assertAction(harmlessClaim), error => error.code === 'ACTION_DENIED');
});

test('request interception blocks redirects and cross-origin resources', async () => {
  const policy = new Policy({ baseUrl: 'http://127.0.0.1:4173' });
  let handler;
  await policy.protect({ route: async (pattern, callback) => { assert.equal(pattern, '**/*'); handler = callback; } });
  const requests = [
    { url: 'http://127.0.0.1:4173/bank', type: 'document', method: 'GET', expected: 'continue' },
    { url: 'http://127.0.0.1:4173/assets/app.js', type: 'script', method: 'GET', expected: 'continue' },
    { url: 'https://evil.test/assets/app.js', type: 'script', method: 'GET', expected: 'abort' },
    { url: 'http://127.0.0.1:4173/transfer', type: 'document', method: 'POST', expected: 'abort' },
    { url: 'http://127.0.0.1:4173/assets/app.js', type: 'script', method: 'POST', expected: 'abort' },
  ];
  for (const request of requests) {
    let observed;
    await handler({ request: () => ({ url: () => request.url, resourceType: () => request.type, method: () => request.method }), continue: () => { observed = 'continue'; }, abort: () => { observed = 'abort'; } });
    assert.equal(observed, request.expected);
  }
});

test('persisted evidence redaction covers nested secrets, identifiers, and typed financial outputs', () => {
  const source = {
    message: 'Member 12345 balance $12,480.50; user@example.test; 123-45-6789; Bearer abcdef; password=hunter2; Alex Morgan',
    token: 'opaque-secret',
    inputs: { member_id: '67890' },
    outputs: { savings_balance: { currency: 'USD', minorUnits: 1248050 } },
    nested: [{ full_name: 'Jordan Reed', observation: 'Account 123456789012' }],
  };
  const result = scrub(source, ['Alex Morgan']);
  const persisted = JSON.stringify(result);
  for (const raw of ['12345', '67890', '12,480.50', '1248050', 'user@example.test', '123-45-6789', 'abcdef', 'hunter2', 'Alex Morgan', 'Jordan Reed', 'opaque-secret', '123456789012']) assert.equal(persisted.includes(raw), false, raw);
  assert.equal(source.inputs.member_id, '67890', 'redaction must not mutate caller arguments');
  assert.equal(result.inputs.member_id, '[REDACTED]');
  assert.equal(result.outputs.savings_balance, '[REDACTED]');
});

test('redacted console state preserves generated lease UUIDs without exempting sensitive numbers', async () => {
  const ownership = new Ownership({ async event() {} });
  // Valid generated UUID shape with numeric segments that previously matched
  // member/account redaction, including a sensitive input substring.
  ownership.sessionId = '12345678-abcd-4abc-8abc-123456789012';
  await ownership.pause({ code: 'SESSION_EXPIRED' });
  await ownership.claim();
  const state = scrub({ ...ownership.ticket(), runId: '87654321-abcd-4abc-9abc-210987654321', observation: 'Account 123456789012; member 12345', account_number: '123456789012' }, ['12345']);
  ownership.assert({ sessionId: state.sessionId, epoch: state.epoch }, 'human');
  assert.equal(state.sessionId, ownership.sessionId);
  assert.equal(state.runId, '87654321-abcd-4abc-9abc-210987654321');
  assert.equal(state.account_number, '[REDACTED]');
  assert.ok(!state.observation.includes('123456789012'));
  assert.ok(!state.observation.includes('12345'));
  assert.notEqual(scrub({ sessionId: '123456789012' }).sessionId, '123456789012', 'invalid metadata still follows number filtering');
  assert.notEqual(scrub({ note: ownership.sessionId }).note, ownership.sessionId, 'UUID text in app data receives no metadata exemption');
});
