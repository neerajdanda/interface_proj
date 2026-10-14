import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { loadPlaywright } from './runtime.mjs';
import { sensitiveRow, extractFrameObservation, redactObservation, redactObservationValue, redactedTarget, markObservationPrivacy, privacyMaskPatterns, rememberPrivateValues } from './observation-privacy.mjs';
const timeout = 2500;

export class SurfaceError extends Error {
  constructor(code, message) { super(message); this.name = 'SurfaceError'; this.code = code; }
}

const describe = target => {
  const strategy = target?.strategies?.[0];
  const label = strategy?.name || strategy?.label || strategy?.text || 'control';
  return `${target?.frame ? `${target.frame}: ` : ''}${String(label).replace(/\b\d{5,}\b/g, '[REDACTED]')}`;
};

function resolveValue(value, inputs) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'param')) {
    if (!Object.hasOwn(inputs, value.param)) throw new SurfaceError('missing_parameter', `Input parameter '${value.param}' is missing.`);
    return String(inputs[value.param]);
  }
  return String(value ?? '');
}

/** UI adapter: all state and actions come from browser-visible DOM controls. */
export class BrowserSurface {
  constructor({ browser, context, page, baseUrl, scenario = 'normal' }) {
    this.browser = browser; this.context = context; this.page = page; this.baseUrl = baseUrl; this.scenario = scenario;
    this._humanCallback = null; this._recorderInstalled = false;
    this._privacyValues = new Set();
  }

  static async launch({ baseUrl, headless = true, scenario = 'normal', channel = process.env.RELAY_BROWSER_CHANNEL || undefined } = {}) {
    const playwright = await loadPlaywright();
    let browser;
    try { browser = await playwright.chromium.launch({ headless, ...(channel ? { channel } : {}) }); }
    catch (error) {
      // Bundled Chromium is a supported fallback when Chrome is unavailable.
      if (channel !== 'chrome' || !/executable.*(?:doesn't exist|not found)|chrome.*not found/i.test(error.message)) throw error;
      browser = await playwright.chromium.launch({ headless });
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // The caller installs route and ownership policy before any target navigation.
    return new BrowserSurface({ browser, context, page, baseUrl, scenario });
  }

  async navigate(url) {
    await this.page.goto(new URL(url, this.baseUrl || this.page.url()).href, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('load', { timeout }).catch(() => {});
  }

  describeTarget(target) { return describe(redactObservationValue(target, [...this._privacyValues])); }

  async describeAction(action) {
    if (!action.target) return action;
    await this.observe();
    const control = await this._resolve(action.target);
    const descriptor = await control.evaluate(element => {
      const role = element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox', INPUT: ['button', 'submit', 'reset'].includes(element.type) ? 'button' : element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : 'textbox' })[element.tagName] || 'generic';
      let name = element.getAttribute('aria-label');
      const labelledBy = element.getAttribute('aria-labelledby');
      if (!name && labelledBy) name = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (!name && element.labels?.length) name = [...element.labels].map(label => label.innerText.trim()).join(' ');
      if (!name && ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && role !== 'button') name = element.closest('tr')?.querySelector('th')?.innerText.trim() || 'Unlabelled field';
      if (!name && element.tagName === 'INPUT' && role === 'button') name = element.value;
      const visibleText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : (element.innerText || '').trim();
      if (!name) name = visibleText;
      else if (role === 'button' && visibleText && visibleText !== name) name = name + ' / ' + visibleText;
      return { role, name };
    });
    descriptor.name = redactObservationValue(descriptor.name, [...this._privacyValues]);
    const canonical = redactObservationValue({ ...action, target: { ...(action.target.frame ? { frame: action.target.frame } : {}), strategies: [{ kind: 'role', ...descriptor }] } }, [...this._privacyValues]);
    if (redactedTarget.test(JSON.stringify(canonical.target))) throw new SurfaceError('sensitive_target', 'A sensitive locator cannot be used for automation.');
    return canonical;
  }

  async _frame(target) {
    if (!target?.frame) return this.page.mainFrame();
    const matches = [];
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const element = await frame.frameElement();
      if (await element.getAttribute('title') === target.frame || await element.getAttribute('name') === target.frame) matches.push(frame);
    }
    if (matches.length > 1) throw new SurfaceError('ambiguous_target', `More than one frame matches '${target.frame}'.`);
    if (!matches.length) throw new SurfaceError('target_not_found', `Frame '${target.frame}' is not available.`);
    return matches[0];
  }

  _strategy(frame, strategy) {
    switch (strategy.kind) {
      case 'role': return frame.getByRole(strategy.role, { name: strategy.name, exact: true });
      case 'label': return frame.getByLabel(strategy.name, { exact: true });
      case 'text': return frame.getByText(strategy.text, { exact: true });
      case 'row': {
        const rows = frame.locator('tr').filter({ has: frame.getByText(strategy.label, { exact: true }) });
        if (strategy.control === 'input') return rows.locator('input, textarea, [role="textbox"]');
        if (strategy.control === 'select') return rows.locator('select, [role="combobox"]');
        if (strategy.control === 'text') return rows.locator('td:last-child');
        throw new SurfaceError('invalid_target', 'A row target needs an input, select, or text control.');
      }
      default: throw new SurfaceError('invalid_target', 'Unsupported target strategy.');
    }
  }

  async _resolve(target, { optional = false } = {}) {
    if (!target || !Array.isArray(target.strategies) || target.strategies.length === 0) throw new SurfaceError('invalid_target', 'Target needs at least one structural strategy.');
    // A filtered locator must never accidentally address an application control
    // literally named like a redaction marker or fall back to a weaker strategy.
    if (redactedTarget.test(JSON.stringify(redactObservationValue(target, [...this._privacyValues])))) throw new SurfaceError('sensitive_target', 'A sensitive locator cannot be used for automation.');
    let frame;
    try { frame = await this._frame(target); }
    catch (error) { if (optional && error.code === 'target_not_found') return null; throw error; }
    for (const strategy of target.strategies) {
      const candidates = this._strategy(frame, strategy);
      const visible = [];
      for (let index = 0; index < await candidates.count(); index++) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible()) visible.push(candidate);
      }
      // Fallback only on zero matches. Ambiguity is never resolved by choosing first.
      if (visible.length > 1) throw new SurfaceError('ambiguous_target', `More than one visible control matches '${this.describeTarget(target)}'.`);
      if (visible.length === 1) return visible[0];
    }
    if (optional) return null;
    throw new SurfaceError('target_not_found', `No visible control matches '${this.describeTarget(target)}'.`);
  }

  async act(action, inputs = {}) {
    switch (action.type) {
      case 'fill': {
        const control = await this._resolve(action.target);
        await control.fill(resolveValue(action.value, inputs), { timeout });
        return { performed: true, type: 'fill', target: describe(action.target) };
      }
      case 'click': {
        const control = await this._resolve(action.target);
        await control.click({ timeout });
        return { performed: true, type: 'click', target: describe(action.target) };
      }
      case 'select': {
        const control = await this._resolve(action.target);
        await control.selectOption({ label: resolveValue(action.value, inputs) }, { timeout });
        return { performed: true, type: 'select', target: describe(action.target) };
      }
      case 'wait': {
        const ms = Number(action.ms ?? 100);
        if (!Number.isFinite(ms) || ms < 0 || ms > 1000) throw new SurfaceError('invalid_action', 'Wait must be between 0 and 1000 milliseconds.');
        await this.page.waitForTimeout(ms);
        return { performed: true, type: 'wait' };
      }
      default: throw new SurfaceError('invalid_action', 'Unsupported browser action.');
    }
  }

  async check(condition, inputs = {}) {
    const control = await this._resolve(condition.target, { optional: true });
    if (!control) return false;
    if (condition.op === 'visible') return true;
    const text = await this._readControl(control);
    const value = resolveValue(condition.value, inputs);
    if (condition.op === 'text_equals') return text === value;
    if (condition.op === 'text_contains') return text.includes(value);
    throw new SurfaceError('invalid_condition', 'Unsupported checkpoint condition.');
  }

  async _readControl(control) {
    const field = await control.evaluate(element => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
    return field ? await control.inputValue() : (await control.innerText()).trim();
  }

  /** Returns an in-memory value for an approved read; evidence never includes it. */
  async read(target) { return this._readControl(await this._resolve(target)); }

  async _collectObservationFrames() {
    const frames = [];
    if (this.page.frames().length > 8) throw new SurfaceError('observation_limit', 'Too many frames for a bounded observation.');
    for (const frame of this.page.frames()) {
      let name;
      if (frame !== this.page.mainFrame()) {
        const element = await frame.frameElement();
        name = await element.getAttribute('title') || await element.getAttribute('name') || 'Embedded workspace';
      }
      const data = await frame.evaluate(extractFrameObservation);
      frames.push({ ...data, ...(name ? { name } : {}) });
    }
    return frames;
  }

  async observe() {
    const frames = await this._collectObservationFrames();
    this._privacyValues = rememberPrivateValues(this._privacyValues, frames);
    return redactObservation(frames, { url: this.page.url(), title: await this.page.title(), privateValues: [...this._privacyValues] });
  }

  /** Screenshots and companion snapshots are always masked by default. */
  async evidence(path) {
    const screenshot = extname(path).toLowerCase() === '.png' ? path : `${path}.png`;
    const snapshot = screenshot.replace(/\.png$/i, '.json');
    await mkdir(dirname(screenshot), { recursive: true });
    await this.page.screenshot({ path: screenshot, fullPage: true, mask: await this._masks(), maskColor: '#35445a', animations: 'disabled' });
    await writeFile(snapshot, `${JSON.stringify(await this.observe(), null, 2)}\n`, { mode: 0o600 });
    return { screenshot, snapshot };
  }

  async _masks() {
    await this.observe();
    const privateValues = [...this._privacyValues];
    for (const frame of this.page.frames()) await frame.evaluate(markObservationPrivacy, { privateValues, patterns: privacyMaskPatterns });
    return this.page.frames().flatMap(frame => [frame.locator('input, textarea, select'), frame.locator('tr').filter({ hasText: sensitiveRow }).locator('td'), frame.locator('[data-relay-private]')]);
  }

  async screenshot() { return this.page.screenshot({ fullPage: true, mask: await this._masks(), maskColor: '#35445a', animations: 'disabled' }); }

  /** Root ownership policy decides when trusted human events are admitted. */
  async attachHumanRecorder(callback) {
    this._humanCallback = callback;
    if (this._recorderInstalled) return;
    this._recorderInstalled = true;
    await this.page.exposeBinding('__relayHumanEvent', async (source, event) => {
      if (!this._humanCallback || !event.trusted) return;
      let frameName;
      if (source.frame !== this.page.mainFrame()) try {
        const element = await source.frame.frameElement();
        frameName = await element.getAttribute('title') || await element.getAttribute('name');
      } catch { return; }
      this._privacyValues = rememberPrivateValues(this._privacyValues, [{ privateValues: event.privateValues || [] }]);
      await this.observe();
      const safeEvent = redactObservationValue({ type: event.type, trusted: true, target: { ...(frameName ? { frame: frameName } : {}), strategies: event.strategies }, timestamp: new Date().toISOString() }, [...this._privacyValues]);
      try { await this._humanCallback(safeEvent); } catch { /* Recorder failure must not interrupt an operator. */ }
    });
    const install = extract => {
      if (window.__relayRecorderInstalled) return;
      window.__relayRecorderInstalled = true;
      const label = element => {
        if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) return labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
        if (element.labels?.length) return [...element.labels].map(item => item.innerText.trim()).join(' ');
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return element.closest('tr')?.querySelector('th')?.innerText.trim() || '';
        return (element.innerText || '').trim();
      };
      const record = event => {
        if (!event.isTrusted) return;
        const element = event.target.closest('button, a[href], input, textarea, select, [role="button"], [role="textbox"], [role="combobox"]');
        if (!element) return;
        const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
        if (event.type === 'click' && field) return;
        if (event.type === 'change' && !field) return;
        const name = label(element).replace(/\$\s?[\d,]+(?:\.\d{2})?/g, '[REDACTED]').replace(/\b\d{5,}\b/g, '[REDACTED]');
        if (!name || name === '[REDACTED]') return;
        const rowLabel = element.closest('tr')?.querySelector('th')?.innerText.trim();
        const hasLabel = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.labels?.length;
        const role = element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' })[element.tagName];
        const strategy = field && rowLabel && !hasLabel ? { kind: 'row', label: rowLabel, control: element.tagName === 'SELECT' ? 'select' : 'input' } : { kind: 'role', role, name };
        // Capture the dictionary before the click's application handler changes
        // the page; only sanitized descriptors leave the binding below.
        const privateValues = extract(document.body).privateValues;
        window.__relayHumanEvent({ type: field ? element.tagName === 'SELECT' ? 'select' : 'fill' : 'click', trusted: true, strategies: [strategy], privateValues }).catch(() => {});
      };
      document.addEventListener('click', record, true);
      document.addEventListener('change', record, true);
    };
    const installSource = `(${install.toString()})(${extractFrameObservation.toString()})`;
    await this.page.addInitScript({ content: installSource });
    for (const frame of this.page.frames()) await frame.evaluate(installSource).catch(error => {
      if (!/execution context was destroyed|frame was detached|target page.*closed/i.test(error.message)) throw error;
    });
  }

  async close() { await this.context.close(); await this.browser.close(); }
}
