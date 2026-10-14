/** The capability is a reviewed program, not a model transcript. No eval or selectors. */
const MAX_BYTES = 262_144;
const MAX_STEPS = 64;
const ACTIONS = new Set(['fill', 'click', 'select', 'wait']);
const ROLES = new Set(['alert', 'button', 'cell', 'checkbox', 'combobox', 'dialog', 'grid', 'heading', 'link', 'list', 'listbox', 'listitem', 'main', 'option', 'radio', 'region', 'row', 'searchbox', 'spinbutton', 'status', 'tab', 'table', 'textbox']);
const ID = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export class ContractError extends Error {
  constructor(message, path = '$', code = 'INVALID_CONTRACT') {
    super(`${path}: ${message}`);
    this.name = 'ContractError';
    this.code = code;
    this.path = path;
  }
}

function fail(message, path, code) { throw new ContractError(message, path, code); }
function object(value, path, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('expected a plain object', path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('unknown field', `${path}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail('required field is missing', `${path}.${key}`);
}
function string(value, path, max = 180, pattern) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`expected a nonempty string of at most ${max} characters`, path);
  if (pattern && !pattern.test(value)) fail('invalid format', path);
}
function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`expected an integer from ${min} to ${max}`, path);
}
function list(value, path, min, max, validate) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`expected an array with ${min} to ${max} items`, path);
  value.forEach((item, index) => validate(item, `${path}[${index}]`));
}
function oneOf(value, path, choices) {
  if (!choices.includes(value)) fail(`expected one of ${choices.join(', ')}`, path);
}
function boundedJson(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('expected serializable JSON', '$'); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) fail(`serialized object exceeds ${MAX_BYTES} bytes`, '$');
}

export function validateTarget(value, path = '$.target') {
  object(value, path, ['strategies'], ['frame']);
  if (value.frame !== undefined) string(value.frame, `${path}.frame`, 100);
  list(value.strategies, `${path}.strategies`, 1, 4, (strategy, itemPath) => {
    if (!strategy || typeof strategy !== 'object') fail('expected a locator strategy', itemPath);
    switch (strategy.kind) {
      case 'role':
        object(strategy, itemPath, ['kind', 'role', 'name']);
        if (!ROLES.has(strategy.role)) fail('unsupported accessibility role', `${itemPath}.role`);
        string(strategy.name, `${itemPath}.name`, 180);
        break;
      case 'row':
        object(strategy, itemPath, ['kind', 'label', 'control']);
        string(strategy.label, `${itemPath}.label`, 180);
        oneOf(strategy.control, `${itemPath}.control`, ['input', 'text']);
        break;
      case 'text':
        object(strategy, itemPath, ['kind', 'text']);
        string(strategy.text, `${itemPath}.text`, 180);
        break;
      case 'label':
        object(strategy, itemPath, ['kind', 'name']);
        string(strategy.name, `${itemPath}.name`, 180);
        break;
      default: fail('unsupported locator strategy', `${itemPath}.kind`);
    }
  });
  return value;
}
const target = validateTarget;

export function validateCondition(value, path = '$.condition') {
  object(value, path, ['target', 'op'], ['value']);
  target(value.target, `${path}.target`);
  oneOf(value.op, `${path}.op`, ['visible', 'text_equals', 'text_contains']);
  if (value.op === 'visible') {
    if (Object.hasOwn(value, 'value')) fail('visible conditions do not accept a value', `${path}.value`);
  } else if (value.value && typeof value.value === 'object') {
    object(value.value, `${path}.value`, ['param']);
    if (value.value.param !== 'member_id') fail('checkpoint references an undeclared input parameter', `${path}.value.param`);
  } else string(value.value, `${path}.value`, 180);
  return value;
}
const condition = validateCondition;

function action(value, path, parameters) {
  object(value, path, ['type'], ['target', 'value', 'ms']);
  if (!ACTIONS.has(value.type)) fail('unsupported action; navigation is controlled by the entry point', `${path}.type`);
  if (value.type !== 'wait' && !value.target) fail('action requires a target', `${path}.target`);
  if (value.target) target(value.target, `${path}.target`);
  if (value.type === 'fill' || value.type === 'select') {
    if (!Object.hasOwn(value, 'value')) fail('action requires a value', `${path}.value`);
    if (typeof value.value === 'object' && value.value !== null) {
      object(value.value, `${path}.value`, ['param']);
      string(value.value.param, `${path}.value.param`, 64, /^[A-Za-z][A-Za-z0-9_]*$/);
      if (parameters && !Object.hasOwn(parameters, value.value.param)) fail('unknown input parameter', `${path}.value.param`);
    } else if (typeof value.value === 'string') {
      string(value.value, `${path}.value`, 256);
    } else if (typeof value.value !== 'boolean' && !(typeof value.value === 'number' && Number.isSafeInteger(value.value))) {
      fail('expected a primitive literal or {param}', `${path}.value`);
    }
    if (typeof value.value !== 'object' && /\b\d{5}\b/.test(String(value.value))) fail('sensitive member inputs must use {param}', `${path}.value`, 'SENSITIVE_LITERAL');
    const labels = (value.target?.strategies || []).map((strategy) => strategy.name ?? strategy.label ?? strategy.text ?? '').join(' ');
    if (/\bmember\s*(?:id|number)\b/i.test(labels) && value.value?.param !== 'member_id') fail('member fields must bind member_id', `${path}.value`, 'SENSITIVE_LITERAL');
  } else if (Object.hasOwn(value, 'value')) fail('this action does not accept a value', `${path}.value`);
  if (value.type === 'wait') {
    if (Object.hasOwn(value, 'ms')) integer(value.ms, `${path}.ms`, 1, 1000);
  } else if (Object.hasOwn(value, 'ms')) fail('only wait actions accept ms', `${path}.ms`);
}

function outputs(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('expected output definitions', path);
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > 8) fail('expected one to eight outputs', path);
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) fail('output names must be safe snake_case', `${path}.${key}`);
    const output = value[key];
    object(output, `${path}.${key}`, ['type', 'sensitive', 'target']);
    oneOf(output.type, `${path}.${key}.type`, ['money', 'string']);
    if (typeof output.sensitive !== 'boolean') fail('sensitive must be boolean', `${path}.${key}.sensitive`);
    if (output.type === 'money' && !output.sensitive) fail('money outputs must be marked sensitive', `${path}.${key}.sensitive`);
    target(output.target, `${path}.${key}.target`);
  }
}

function assertSafeArtifactLiterals(cap) {
  // Sensitive invocation values belong only in memory. Even synthetic sample values
  // must not accidentally become the literal values of a reusable capability.
  const prohibited = /(?:\b\d{5}\b|\b\d{8,17}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b|(?:\$\s*-?|\bUSD\s*-?)\d[\d,]*\.\d{2}\b|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
  function visit(value, path) {
    if (typeof value === 'string' && prohibited.test(value)) fail('sensitive literal must be parameterized or removed', path, 'SENSITIVE_LITERAL');
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  }
  visit(cap, '$');
}

/** Strict runtime counterpart of schemas/capability.schema.json. Returns the input. */
export function validateCapability(cap) {
  boundedJson(cap);
  object(cap, '$', ['schemaVersion', 'id', 'name', 'description', 'vendor', 'entry', 'inputs', 'outputs', 'steps', 'success', 'outcomes', 'recoveries', 'review', 'provenance']);
  if (cap.schemaVersion !== '1.0.0') fail('unsupported schema version', '$.schemaVersion');
  string(cap.id, '$.id', 80, ID);
  string(cap.name, '$.name', 100);
  string(cap.description, '$.description', 1000);
  object(cap.vendor, '$.vendor', ['product', 'version']);
  string(cap.vendor.product, '$.vendor.product', 100);
  string(cap.vendor.version, '$.vendor.version', 64);
  object(cap.entry, '$.entry', ['path', 'frame']);
  if (cap.entry.path !== '/bank') fail('v1 entry must be /bank', '$.entry.path');
  string(cap.entry.frame, '$.entry.frame', 100);
  object(cap.inputs, '$.inputs', ['member_id']);
  object(cap.inputs.member_id, '$.inputs.member_id', ['type', 'pattern', 'sensitive']);
  if (cap.inputs.member_id.type !== 'string' || cap.inputs.member_id.pattern !== '^[0-9]{5}$' || cap.inputs.member_id.sensitive !== true) fail('member_id must be a sensitive five-digit string', '$.inputs.member_id');
  outputs(cap.outputs, '$.outputs');
  const ids = new Set();
  list(cap.steps, '$.steps', 1, MAX_STEPS, (step, path) => {
    object(step, path, ['id', 'action', 'before', 'after', 'effect', 'retry']);
    string(step.id, `${path}.id`, 80, ID);
    if (ids.has(step.id)) fail('duplicate step id', `${path}.id`);
    ids.add(step.id);
    action(step.action, `${path}.action`, cap.inputs);
    list(step.before, `${path}.before`, 1, 8, condition);
    list(step.after, `${path}.after`, 0, 8, condition);
    oneOf(step.effect, `${path}.effect`, ['read', 'reversible', 'irreversible']);
    object(step.retry, `${path}.retry`, ['maxAttempts']);
    // The executor is deliberately at-most-once. Waiting may repeat; an action may
    // not. A future retry contract needs an explicit idempotency proof first.
    integer(step.retry.maxAttempts, `${path}.retry.maxAttempts`, 1, 1);
  });
  list(cap.success, '$.success', 1, 8, condition);
  const identity = cap.success.some((checkpoint) => checkpoint.op === 'text_equals'
    && checkpoint.value?.param === 'member_id'
    && checkpoint.target.frame === cap.entry.frame
    && checkpoint.target.strategies.some((strategy) => strategy.kind === 'row' && strategy.label === 'Member ID' && strategy.control === 'text'));
  if (!identity) fail('success must verify the caller member_id in the entry frame Member ID row', '$.success', 'MISSING_IDENTITY_CHECKPOINT');
  const codes = new Set();
  list(cap.outcomes, '$.outcomes', 0, 16, (outcome, path) => {
    object(outcome, path, ['code', 'when']);
    string(outcome.code, `${path}.code`, 64, CODE);
    if (codes.has(outcome.code)) fail('duplicate outcome/recovery code', `${path}.code`);
    codes.add(outcome.code);
    condition(outcome.when, `${path}.when`);
  });
  list(cap.recoveries, '$.recoveries', 0, 8, (recovery, path) => {
    object(recovery, path, ['code', 'when', 'action', 'maxAttempts']);
    string(recovery.code, `${path}.code`, 64, CODE);
    if (codes.has(recovery.code)) fail('duplicate outcome/recovery code', `${path}.code`);
    codes.add(recovery.code);
    condition(recovery.when, `${path}.when`);
    action(recovery.action, `${path}.action`, cap.inputs);
    if (!['click', 'wait'].includes(recovery.action.type)) fail('recovery is limited to a known click or wait', `${path}.action.type`);
    integer(recovery.maxAttempts, `${path}.maxAttempts`, 1, 3);
  });
  object(cap.review, '$.review', ['state']);
  if (cap.review.state !== 'draft') fail('v1 review state must be draft', '$.review.state');
  object(cap.provenance, '$.provenance', ['mode', 'model']);
  oneOf(cap.provenance.mode, '$.provenance.mode', ['openai', 'codex-bridge']);
  string(cap.provenance.model, '$.provenance.model', 100);
  assertSafeArtifactLiterals(cap);
  return cap;
}

/** Validate caller arguments without writing their raw values into an error. */
export function validateInputs(cap, inputs) {
  object(inputs, '$.inputs', ['member_id']);
  if (typeof inputs.member_id !== 'string' || !/^[0-9]{5}$/.test(inputs.member_id)) fail('member_id must be a five-digit string', '$.inputs.member_id', 'INVALID_INPUT');
  if (!cap?.inputs?.member_id || cap.inputs.member_id.type !== 'string') fail('capability has no compatible input contract', '$.inputs');
  return inputs;
}

/** Validate untrusted model output before any UI action is allowed. */
export function validateDecision(decision) {
  boundedJson(decision);
  object(decision, '$', ['kind'], ['action', 'before', 'after', 'reason', 'success', 'outputs']);
  oneOf(decision.kind, '$.kind', ['action', 'finish', 'escalate']);
  if (decision.reason !== undefined) string(decision.reason, '$.reason', 1000);
  if (decision.kind === 'action') {
    action(decision.action, '$.action');
    if (decision.before !== undefined) list(decision.before, '$.before', 0, 8, condition);
    if (decision.after !== undefined) list(decision.after, '$.after', 0, 8, condition);
    if (decision.success !== undefined) list(decision.success, '$.success', 0, 0, condition);
    if (Object.hasOwn(decision, 'outputs')) fail('action decisions cannot declare final outputs', '$.outputs');
  } else {
    if (Object.hasOwn(decision, 'action')) fail('finish/escalate cannot carry an executable action', '$.action');
    for (const field of ['before', 'after']) if (decision[field] !== undefined) list(decision[field], `$.${field}`, 0, 0, condition);
    if (decision.kind === 'finish') {
      list(decision.success, '$.success', 1, 8, condition);
      outputs(decision.outputs, '$.outputs');
    } else {
      if (decision.success !== undefined) list(decision.success, '$.success', 0, 0, condition);
      if (Object.hasOwn(decision, 'outputs')) fail('escalation cannot declare final outputs', '$.outputs');
    }
  }
  return decision;
}

/** Parse decimal USD without binary floating point or silent rounding. */
export function extractMoney(text) {
  if (typeof text !== 'string' || text.length > 80) fail('expected a bounded USD amount', '$.output', 'INVALID_OUTPUT');
  const match = text.trim().match(/^(-)?(?:\$|USD\s*)(-)?((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))\.(\d{2})$/);
  if (!match || (match[1] && match[2])) fail('invalid USD amount', '$.output', 'INVALID_OUTPUT');
  const sign = match[1] || match[2] ? -1n : 1n;
  const cents = sign * (BigInt(match[3].replaceAll(',', '')) * 100n + BigInt(match[4]));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) fail('USD amount exceeds safe integer range', '$.output', 'INVALID_OUTPUT');
  return { currency: 'USD', minorUnits: Number(cents) };
}
