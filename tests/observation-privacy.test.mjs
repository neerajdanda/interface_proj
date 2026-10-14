import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSurface } from '../src/surface.mjs';
import { ConnectedSurface } from '../src/connected-surface.mjs';
import { extractFrameObservation, redactObservation, redactObservationValue, rememberPrivateValues } from '../src/observation-privacy.mjs';

// A small DOM fixture exposes the browser primitives used by the real extractor.
// Evaluate serializes the shipped function, so tests cannot rely on its imports.
class Element {
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.attributes = { ...attributes };
    this.childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, textContent: child } : child);
    for (const child of this.childNodes) child.parentElement = this;
    this.nodeType = 1;
  }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  get innerText() { return this.textContent; }
  get type() { return this.attributes.type || 'text'; }
  get value() { return this.attributes.value ?? (this.tagName === 'TEXTAREA' ? this.textContent : this.tagName === 'SELECT' ? this.selectedOptions[0]?.attributes.value || this.selectedOptions[0]?.textContent || '' : ''); }
  get selectedOptions() { return this.childNodes.filter(child => child.tagName === 'OPTION' && Object.hasOwn(child.attributes, 'selected')); }
  get labels() { return this.ownerDocument?.querySelectorAll('label').filter(label => label.attributes.for === this.attributes.id) || []; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getClientRects() { return this.attributes.hidden ? [] : [{}]; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
  querySelectorAll(selector) {
    const descendants = this.childNodes.filter(child => child.nodeType === 1).flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(child => matches(child, selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function matches(element, selector) {
  return selector.split(',').some(part => {
    part = part.trim(); if (part === '*' || part === 'body *') return true;
    const match = /^([\w-]+)?(?:\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\])?$/.exec(part);
    return !!match && (!match[1] || element.tagName === match[1].toUpperCase()) && (!match[2] || Object.hasOwn(element.attributes, match[2]) && (match[3] === undefined && match[4] === undefined || element.attributes[match[2]] === (match[3] ?? match[4])));
  });
}
const element = (tag, attrs, ...children) => new Element(tag, attrs, children);
const row = (label, value) => element('tr', {}, element('th', {}, label), element('td', {}, value));
function documentOf(title, children) {
  const body = element('body', {}, ...children);
  const doc = { title, body, querySelectorAll: selector => body.querySelectorAll(selector), getElementById: id => body.querySelectorAll('*').find(node => node.attributes.id === id), defaultView: { getComputedStyle: node => ({ visibility: node.attributes.style === 'visibility:hidden' ? 'hidden' : 'visible' }) } };
  for (const node of [body, ...body.querySelectorAll('*')]) node.ownerDocument = doc;
  return doc;
}
function evaluate(doc, fn, argument) {
  const source = typeof fn === 'string' ? fn : `(${fn.toString()})(__argument)`;
  return vm.runInNewContext(source, { document: doc, __argument: argument, window: {}, getComputedStyle: doc.defaultView.getComputedStyle });
}
function nativeFrame(doc, frameElement = null) {
  return { document: doc, evaluate: async (fn, arg) => evaluate(doc, fn, arg), frameElement: async () => ({ getAttribute: async name => frameElement.getAttribute(name) }), locator: selector => ({ selector, document: doc, filter() { return this; }, locator(child) { return { selector: `${selector} ${child}`, document: doc }; } }) };
}
function hostedAPI(doc, children = new Map()) {
  return { locator(selector) {
    const nodes = selector === 'body' ? [doc.body] : doc.querySelectorAll(selector);
    return { count: async () => nodes.length, evaluate: async fn => evaluate(doc, fn, nodes[0]) };
  }, frameLocator(selector) { const node = doc.querySelectorAll(selector)[0]; return children.get(node); }, domSnapshot: async () => JSON.stringify({ title: doc.title, text: doc.body.innerText, fields: doc.querySelectorAll('input, textarea, select').map(field => field.value) }) };
}
const baseUrl = 'http://127.0.0.1:4173';
function adapters() {
  const privateMain = 'Casey Quinn', privateChild = 'Taylor Vale', privateForm = 'a-private-form-payload "quoted"\nsecond line';
  const iframe = element('iframe', { title: `Workspace ${privateChild}`, name: `Frame ${privateMain}`, src: '/workspace' });
  const main = documentOf(`Relay ${privateChild}`, [
    element('table', {}, row('Member name', privateMain), row('Address', '17 Fictional Lane')),
    element('h2', {}, `Details for ${privateChild}`),
    element('h3', {}, element('span', {}, 'Taylor '), element('span', {}, 'Vale')),
    element('p', {}, privateForm.replace(/\s+/g, ' ')),
    element('button', { 'aria-label': `Open ${privateChild}` }, 'Open member'),
    element('button', {}, 'Search'), iframe,
  ]);
  const child = documentOf(`Ledger ${privateMain}`, [
    element('table', {}, row('Member name', privateChild), row('Member ID', '73129'), row('Savings balance', '$7,410.35'), row(`Notes for ${privateMain}`, element('input', { value: privateForm })), row('Member ID', element('input', { value: '73129' }))),
    element('h2', {}, `Overview ${privateMain}`),
    element('h3', {}, element('span', {}, 'Casey '), element('span', {}, 'Quinn')),
    element('label', { for: 'memo' }, `Memo ${privateMain}`), element('textarea', { id: 'memo' }, privateForm),
    element('button', { 'aria-label': `Open ${privateMain}` }, `Open ${privateMain}`),
    element('button', {}, 'Account summary'),
    element('span', {}, 'person@example.test 212-555-0149 sk-proj-fake1234567890'),
    element('input', { type: 'submit', value: 'Submit transfer' }), element('input', { type: 'checkbox', value: 'on', 'aria-label': 'Receive updates' }),
  ]);
  const mainFrame = nativeFrame(main), childFrame = nativeFrame(child, iframe);
  const url = `${baseUrl}/bank/${encodeURIComponent(privateChild)}?member_id=73129&view=${encodeURIComponent(privateMain)}#${encodeURIComponent(privateForm)}`;
  let screenshotOptions;
  const page = { frames: () => [mainFrame, childFrame], mainFrame: () => mainFrame, title: async () => main.title, url: () => url,
    screenshot: async options => { screenshotOptions = options; return Buffer.from('masked fixture image'); } };
  const native = new BrowserSurface({ page, baseUrl });
  const childAPI = hostedAPI(child), api = hostedAPI(main, new Map([[iframe, childAPI]]));
  const hosted = new ConnectedSurface({ tab: { playwright: api, url: async () => url, title: async () => main.title }, baseUrl, policy: { assertUrl() {} } });
  api.domSnapshot = async () => '- textbox "Memo": ' + privateForm.replace(/\s+/g, ' ');
  return { native, hosted, main, child, iframe, privateMain, privateChild, privateForm, getScreenshotOptions: () => screenshotOptions };
}
function safe(serialized, fixture) {
  for (const value of [fixture.privateMain, fixture.privateChild, fixture.privateForm, '17 Fictional Lane', '73129', '$7,410.35', 'person@example.test', '212-555-0149', 'sk-proj-fake1234567890']) assert.equal(serialized.includes(value), false, `Private fixture value survived filtering`);
  assert.equal(serialized.includes('a-private-form-payload'), false, 'Escaped snapshots must omit the private field payload');
}

test('both adapters execute identical transferable extraction and redact across frame boundaries', async () => {
  const fixture = adapters();
  const native = await fixture.native.observe(), hosted = await fixture.hosted.observe();
  assert.deepEqual(JSON.parse(JSON.stringify(native)), JSON.parse(JSON.stringify(hosted)));
  safe(JSON.stringify(native), fixture);
  for (const label of ['Search', 'Account summary', 'Member ID', 'Submit transfer', 'Receive updates']) assert.ok(native.controls.some(control => control.name === label));
  assert.ok(native.controls.some(control => control.target.strategies.some(strategy => strategy.kind === 'row' && strategy.label.includes('[REDACTED]'))));
  assert.ok(native.frames[1].name.includes('[REDACTED]'));
  assert.ok(!Object.hasOwn(native, 'privateValues'));
  const extracted = evaluate(fixture.child, extractFrameObservation);
  assert.ok(extracted.privateValues.includes(fixture.privateForm));
  assert.ok(!extracted.privateValues.includes('Submit transfer'));
  assert.ok(!extracted.privateValues.includes('on'));
});

test('structural evidence and dynamic screenshot masks cover repeated private text outside tables', async () => {
  const fixture = adapters(), directory = await mkdtemp(join(tmpdir(), 'relay-observation-'));
  try {
    const nativeFile = await fixture.native.evidence(join(directory, 'native'));
    const hostedFile = await fixture.hosted.evidence(join(directory, 'hosted'));
    safe(await readFile(nativeFile.snapshot, 'utf8'), fixture);
    safe(await readFile(hostedFile.snapshot, 'utf8'), fixture);
    const masks = fixture.getScreenshotOptions().mask.filter(mask => mask.selector === '[data-relay-private]');
    assert.equal(masks.length, 2);
    for (const mask of masks) {
      assert.ok(mask.document.querySelectorAll('[data-relay-private]').some(node => node.tagName === 'H2'));
      assert.ok(mask.document.querySelectorAll('[data-relay-private]').some(node => node.tagName === 'H3'), 'Inline fragments containing a private value must be masked together');
    }
    assert.ok(fixture.main.querySelectorAll('[data-relay-private]').some(node => node.tagName === 'P'), 'Whitespace-normalized repeated field payload must be masked');
    await fixture.native.screenshot();
    assert.equal(fixture.getScreenshotOptions().mask.length, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('redacted and known private locators fail before resolution or fallback', async () => {
  const fixture = adapters(); await fixture.native.observe(); await fixture.hosted.observe();
  for (const adapter of [fixture.native, fixture.hosted]) {
    adapter._frame = async () => { assert.fail('Sensitive locator reached DOM resolution'); };
    for (const name of ['Open [REDACTED]', `Open ${fixture.privateMain}`, 'Contact person@example.test']) {
      const target = { strategies: [{ kind: 'role', role: 'button', name }, { kind: 'role', role: 'button', name: 'Search' }] };
      await assert.rejects(adapter.act({ type: 'click', target }), error => error.code === 'sensitive_target');
      await assert.rejects(adapter.check({ target, op: 'visible' }), error => error.code === 'sensitive_target');
    }
  }
});

test('private value dictionaries survive navigation but fail closed at the memory bound', async () => {
  const fixture = adapters(); await fixture.native.observe();
  fixture.main.title = `Returning ${fixture.privateChild}`;
  fixture.child.body.childNodes = [];
  safe(JSON.stringify(await fixture.native.observe()), fixture);
  const known = new Set(Array.from({ length: 512 }, (_, index) => `private-${index}`));
  assert.throws(() => rememberPrivateValues(known, [{ privateValues: ['one-more-private-value'] }]), error => error.code === 'privacy_limit');
  assert.equal(known.size, 512);
});

test('privacy redaction happens before truncation and encoded URL values are filtered', () => {
  const frame = { privateValues: ['A long fictional name'], title: 'x'.repeat(170) + 'A long fictional name', text: 'x'.repeat(11990) + 'A long fictional name', controls: [], name: 'Workspace A long fictional name' };
  const observation = redactObservation([frame], { url: `${baseUrl}/A%20long%20fictional%20name?member_id=73129&title=A+long+fictional+name`, title: frame.title });
  assert.ok(!JSON.stringify(observation).includes('A long fictional name'));
  assert.ok(!observation.title.endsWith('A long fic'));
  assert.ok(!observation.url.includes('A%20long') && !observation.url.includes('A+long'));
});

test('provider whitespace normalization and escaping cannot expose a private field payload', () => {
  const privateValue = 'a-private-form-payload "quoted"\n\tsecond line';
  const normalized = privateValue.replace(/\s+/g, ' ');
  for (const literal of [normalized, JSON.stringify(normalized).slice(1,-1), normalized.replace(/'/g, "''")]) {
    const snapshot = `- textbox "Memo": ${literal}`;
    const filtered = redactObservationValue(snapshot, [privateValue]);
    assert.equal(filtered.includes('a-private-form-payload'), false);
    assert.ok(filtered.includes('[REDACTED]'));
  }
});

test('canonical control risk text is preserved or rejected when it collides with a private value', async () => {
  const control = element('button', { 'aria-label': 'Continue' }, 'Submit transfer');
  const doc = documentOf('Risk fixture', [control]);
  const surface = new BrowserSurface({ page: {}, baseUrl });
  surface.observe = async () => ({});
  surface._resolve = async () => ({ evaluate: async fn => evaluate(doc, fn, control) });
  const action = { type: 'click', target: { strategies: [{ kind: 'role', role: 'button', name: 'Continue' }] } };
  const canonical = await surface.describeAction(action);
  assert.equal(canonical.target.strategies[0].name, 'Continue / Submit transfer');
  surface._privacyValues.add('Submit transfer');
  await assert.rejects(surface.describeAction(action), error => error.code === 'sensitive_target');
});

test('trusted recorder sanitizes frame/control labels and never forwards its private dictionary', async () => {
  const fixture = adapters(), events = [];
  let binding, installContent;
  fixture.native.page.exposeBinding = async (name, fn) => { assert.equal(name, '__relayHumanEvent'); binding = fn; };
  fixture.native.page.addInitScript = async script => { installContent = script.content; };
  for (const frame of fixture.native.page.frames()) {
    const originalEvaluate = frame.evaluate;
    frame.evaluate = async (fn, arg) => typeof fn === 'string' ? undefined : originalEvaluate(fn, arg);
  }
  await fixture.native.attachHumanRecorder(event => events.push(event));
  assert.ok(installContent.includes('privateValues'));
  await binding({ frame: fixture.native.page.frames()[1] }, { type: 'click', trusted: true,
    strategies: [{ kind: 'role', role: 'button', name: `Open ${fixture.privateMain}` }], privateValues: ['just-entered-private-note'] });
  assert.equal(events.length, 1);
  safe(JSON.stringify(events), fixture);
  assert.ok(!JSON.stringify(events).includes('just-entered-private-note'));
  assert.ok(events[0].target.strategies[0].name.includes('[REDACTED]'));
  assert.ok(events[0].target.frame.includes('[REDACTED]'));
  assert.ok(!Object.hasOwn(events[0], 'privateValues'));
  await binding({ frame: fixture.native.page.frames()[1] }, { type: 'click', trusted: false, strategies: [] });
  assert.equal(events.length, 1);
});
