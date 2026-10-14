import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIModel, compact, decisionSchema, DISCOVERY_INSTRUCTIONS } from '../src/model.mjs';
import { ContractError } from '../src/contract.mjs';

const frame = 'Member workspace';
const role = (name) => ({ frame, strategies: [{ kind: 'role', role: 'heading', name, label: null, control: null, text: null }] });
const row = (label, control) => ({ frame, strategies: [{ kind: 'row', role: null, name: null, label, control, text: null }] });
const visible = (target) => ({ target, op: 'visible', value: null });
const request = { goal: 'Read savings for {{member_id}}', inputContract: { member_id: { type: 'string', sensitive: true } }, observation: { text: 'Find a member; private values [REDACTED]' }, history: [] };

function actionDecision() {
  return { kind: 'action', action: { type: 'fill', target: row('Member ID', 'input'), value: { param: 'member_id' }, ms: null }, before: [visible(role('Find a member'))], after: [], success: [], outputs: null, reason: 'Populate the parameterized member input' };
}
function finishDecision() {
  return { kind: 'finish', action: null, before: [], after: [], success: [visible(role('Account summary')), { target: row('Member ID', 'text'), op: 'text_equals', value: { param: 'member_id' } }], outputs: { savings_balance: { type: 'money', sensitive: true, target: row('Savings balance', 'text') } }, reason: 'The identity and account summary are verified' };
}
function response(decision) {
  return { ok: true, async json() { return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] }; } };
}
function strictObjects(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  }
  for (const value of Object.values(schema)) if (Array.isArray(value)) value.forEach(strictObjects); else if (value && typeof value === 'object') strictObjects(value);
}

test('provider request shape uses strict structured output and disables response storage (mocked fetch)', async (t) => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => { captured = { url, options }; return response(actionDecision()); });
  const model = new OpenAIModel({ apiKey: 'unit-test-key', model: 'unit-test-model' });
  const decision = await model.decide(request);
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer unit-test-key');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.ok(captured.options.signal instanceof AbortSignal);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, 'unit-test-model');
  assert.equal(body.store, false);
  assert.equal(body.instructions, DISCOVERY_INSTRUCTIONS);
  assert.deepEqual(JSON.parse(body.input), request);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema, decisionSchema);
  strictObjects(body.text.format.schema);
  assert.equal(model.calls, 1);
  assert.equal(model.mode, 'openai');
  assert.equal(decision.action.value.param, 'member_id');
  assert.equal(Object.hasOwn(decision, 'outputs'), false);
  assert.equal(Object.hasOwn(decision.action, 'ms'), false);
  assert.deepEqual(decision.action.target.strategies, [{ kind: 'row', label: 'Member ID', control: 'input' }]);
});

test('nullable finish response compacts into the executable success/output contract (mocked fetch)', async (t) => {
  const raw = finishDecision();
  t.mock.method(globalThis, 'fetch', async () => response(raw));
  const model = new OpenAIModel({ apiKey: 'unit-test-key', model: 'unit-test-model' });
  const decision = await model.decide(request);
  assert.equal(decision.kind, 'finish');
  assert.equal(Object.hasOwn(decision, 'action'), false);
  assert.equal(Object.hasOwn(decision.success[0], 'value'), false);
  assert.deepEqual(decision.success[1].value, { param: 'member_id' });
  assert.deepEqual(decision.outputs.savings_balance.target.strategies, [{ kind: 'row', label: 'Savings balance', control: 'text' }]);
  assert.equal(raw.action, null, 'decoding must not mutate the original provider response');
  assert.equal(raw.success[0].value, null);
  assert.deepEqual(compact({ nullable: null, zero: 0, no: false, empty: '', list: [0, false, null] }), { zero: 0, no: false, empty: '', list: [0, false, null] });
});

test('provider HTTP errors do not read or expose response bodies (mocked fetch)', async (t) => {
  let readBody = false;
  const privateEcho = 'synthetic-sensitive-provider-echo';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403, async json() { readBody = true; return { error: privateEcho }; }, async text() { readBody = true; return privateEcho; } }));
  const model = new OpenAIModel({ apiKey: 'unit-test-key' });
  await assert.rejects(model.decide(request), (error) => {
    assert.equal(error.code, 'MODEL_REQUEST_FAILED');
    assert.match(error.message, /HTTP 403/);
    assert.ok(!error.message.includes(privateEcho));
    return true;
  });
  assert.equal(readBody, false);
  assert.equal(model.calls, 1);
});

test('unstructured refusal content is not echoed as an error (mocked fetch)', async (t) => {
  const privateEcho = 'synthetic-sensitive-refusal-echo';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, async json() { return { output: [{ type: 'message', content: [{ type: 'refusal', refusal: privateEcho }] }] }; } }));
  const model = new OpenAIModel({ apiKey: 'unit-test-key' });
  await assert.rejects(model.decide(request), (error) => {
    assert.match(error.message, /no structured decision/i);
    assert.ok(!error.message.includes(privateEcho));
    return true;
  });
});

test('provider output still passes the runtime executable-vocabulary validator (mocked fetch)', async (t) => {
  const malicious = actionDecision();
  malicious.action.selector = 'body';
  t.mock.method(globalThis, 'fetch', async () => response(malicious));
  const model = new OpenAIModel({ apiKey: 'unit-test-key' });
  await assert.rejects(model.decide(request), ContractError);
});

test('API-backed provider requires explicit access configuration', () => {
  assert.throws(() => new OpenAIModel({ apiKey: '' }), /OPENAI_API_KEY is required/);
});
