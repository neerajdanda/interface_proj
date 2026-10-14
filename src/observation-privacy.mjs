import { scrub } from './policy.mjs';

// These are the fields understood by the local fixture, not a general PII detector.
export const sensitiveRow = /\b(member id|member name|full name|account|balance|deposit|routing|email|phone|address|ssn)\b/i;
export const redactedTarget = /\[REDACTED(?:_[A-Z]+)?\]/;
const patternRules = [
  { source: '\\bBearer\\s+[^\\s"\']+', flags: 'gi', replacement: 'Bearer [REDACTED]' },
  { source: '\\bsk-[A-Za-z0-9_-]{12,}\\b', flags: 'g', replacement: '[REDACTED_TOKEN]' },
  { source: '\\b(password|passwd|secret|token|api[_ -]?key)\\s*[:=]\\s*[^\\s,;]+', flags: 'gi', replacement: '$1=[REDACTED]' },
  { source: '\\b\\d{3}-\\d{2}-\\d{4}\\b', flags: 'g', replacement: '[REDACTED_SSN]' },
  { source: '\\b(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]\\d{3}[-. ]\\d{4}\\b', flags: 'g', replacement: '[REDACTED_PHONE]' },
  { source: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b', flags: 'gi', replacement: '[REDACTED_EMAIL]' },
  { source: '(?:-?\\$\\s*-?|\\bUSD\\s*-?)\\d[\\d,]*(?:\\.\\d{2})?\\b', flags: 'g', replacement: '[REDACTED_MONEY]' },
  { source: '\\b\\d{5,}\\b', flags: 'g', replacement: '[REDACTED_NUMBER]' },
];

/** Self-contained so both browser APIs can evaluate the exact same DOM extraction. */
export function extractFrameObservation(root) {
  const doc = root?.ownerDocument || document;
  const body = doc.body;
  const sensitive = /\b(member id|member name|full name|account|balance|deposit|routing|email|phone|address|ssn)\b/i;
  const privateValues = [];
  let privateSize = 0;
  const addPrivate = value => {
    if (!value || privateValues.includes(value)) return;
    if (privateValues.length >= 512 || (privateSize += value.length) > 65536) throw new Error('Privacy observation exceeded its bounded private-value dictionary.');
    privateValues.push(value);
  };
  const textOf = element => (element?.innerText ?? element?.textContent ?? '').trim();
  for (const row of doc.querySelectorAll('tr')) {
    const label = textOf(row.querySelector('th') || row.querySelector('td'));
    if (!sensitive.test(label)) continue;
    for (const cell of row.querySelectorAll('td')) {
      const value = textOf(cell);
      if (value && value !== label) addPrivate(value);
    }
  }
  // Read values only into the private dictionary. They never enter observations.
  for (const field of doc.querySelectorAll('input, textarea, select')) {
    if (field.tagName === 'INPUT' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(field.type)) continue;
    if (typeof field.value === 'string' && field.value) addPrivate(field.value);
    if (field.tagName === 'SELECT') for (const option of field.selectedOptions || []) {
      addPrivate(textOf(option));
    }
  }
  const visible = element => !!element.getClientRects().length && doc.defaultView.getComputedStyle(element).visibility !== 'hidden';
  const roleOf = element => element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', SELECT: 'combobox', TEXTAREA: 'textbox', INPUT: ['button', 'submit', 'reset'].includes(element.type) ? 'button' : element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : 'textbox' })[element.tagName];
  const labelOf = element => {
    if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) return labelledBy.split(/\s+/).map(id => textOf(doc.getElementById(id))).join(' ').trim();
    if (element.labels?.length) return [...element.labels].map(textOf).join(' ');
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && roleOf(element) !== 'button') return textOf(element.closest('tr')?.querySelector('th')) || 'Unlabelled field';
    if (element.tagName === 'INPUT' && roleOf(element) === 'button') return element.value;
    return textOf(element) || element.getAttribute('title') || '';
  };
  const controls = [...doc.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"]')].filter(visible).slice(0,120).map(element => {
    const role = roleOf(element), name = labelOf(element);
    const rowLabel = textOf(element.closest('tr')?.querySelector('th'));
    const hasLabel = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.labels?.length;
    const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) && role !== 'button';
    const strategy = field && rowLabel && !hasLabel ? { kind: 'row', label: rowLabel, control: element.tagName === 'SELECT' ? 'select' : 'input' } : { kind: 'role', role, name };
    return { role, name, strategies: [strategy] };
  });
  return { title: doc.title || '', url: doc.location?.href || '', text: body?.innerText ?? body?.textContent ?? '', controls, privateValues,
    childFrames: [...doc.querySelectorAll('iframe')].map(element => ({ title: element.getAttribute('title') || '', name: element.getAttribute('name') || '', src: element.getAttribute('src') || '' })) };
}

export function rememberPrivateValues(known, frames) {
  const values = new Set([...known, ...frames.flatMap(frame => frame.privateValues)]);
  if (values.size > 512 || [...values].reduce((size, value) => size + value.length, 0) > 65536) {
    throw Object.assign(new Error('Privacy observation exceeded its bounded private-value dictionary.'), { code: 'privacy_limit' });
  }
  return values;
}

export function redactObservationValue(value, privateValues = []) {
  const known = [...new Set(privateValues)].filter(value => typeof value === 'string' && value);
  // Provider DOM snapshots can quote/escape field payloads before returning
  // their text. Remove the encoded literal as well as the original value.
  const representations = known.flatMap(value => [...new Set([value, value.replace(/\s+/g, ' ').trim()])]
    .flatMap(literal => [literal, JSON.stringify(literal).slice(1,-1), literal.replace(/'/g, "''")]));
  const safe = scrub(value, representations);
  const visit = item => {
    if (typeof item === 'string') return patternRules.reduce((text, rule) => text.replace(new RegExp(rule.source, rule.flags), rule.replacement), item);
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(visit);
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
  };
  return visit(safe);
}

function safeUrl(rawUrl, privateValues) {
  const url = new URL(rawUrl);
  const redact = text => redactObservationValue(text, privateValues);
  const decode = text => { try { return decodeURIComponent(text); } catch { return text; } };
  if (url.username) url.username = '[REDACTED]';
  if (url.password) url.password = '[REDACTED]';
  url.pathname = url.pathname.split('/').map(part => encodeURIComponent(redact(decode(part)))).join('/');
  for (const key of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(key);
    url.searchParams.delete(key);
    for (const value of values) url.searchParams.append(redact(key), /member|account|token|secret|password|email|phone/i.test(key) ? '[REDACTED]' : redact(value));
  }
  if (url.hash) url.hash = redact(decode(url.hash.slice(1)));
  return redact(url.href);
}

/** Redact after gathering every frame, before truncation or any external boundary. */
export function redactObservation(frames, { url, title, privateValues = [] }) {
  const known = [...new Set([...privateValues, ...frames.flatMap(frame => frame.privateValues || [])])];
  const controls = frames.flatMap(frame => frame.controls.map(control => ({ role: control.role, name: control.name,
    target: { ...(frame.name ? { frame: frame.name } : {}), strategies: control.strategies } })));
  const safe = redactObservationValue({ url: safeUrl(url, known), title,
    frames: frames.map(frame => ({ name: frame.name || 'Main page', title: frame.title, text: frame.text })), controls }, known);
  safe.title = safe.title.slice(0,180);
  for (const frame of safe.frames) { frame.name = frame.name.slice(0,180); frame.title = frame.title.slice(0,180); frame.text = frame.text.trim().slice(0,12000); }
  safe.text = safe.frames.map(frame => frame.text).join('\n\n').slice(0,18000);
  safe.controls = safe.controls.slice(0,120).map(control => ({ ...control, name: control.name.slice(0,180) }));
  return safe;
}

/** Mask repeated visible values/labels as well as the original sensitive cells. */
export function markObservationPrivacy({ privateValues: rawPrivateValues, patterns }) {
  const normalizedText = value => value.replace(/\s+/g, ' ').trim();
  const privateValues = [...new Set(rawPrivateValues.flatMap(value => [value, normalizedText(value)]))].filter(Boolean);
  const expressions = patterns.map(pattern => new RegExp(pattern.source, pattern.flags));
  const sensitive = value => value && (privateValues.some(privateValue => value.includes(privateValue) || normalizedText(value).includes(privateValue)) || expressions.some(expression => { expression.lastIndex = 0; return expression.test(value); }));
  for (const element of document.querySelectorAll('[data-relay-private]')) element.removeAttribute('data-relay-private');
  for (const element of document.querySelectorAll('body *')) {
    const directText = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ');
    const labels = ['aria-label', 'title', 'alt', 'placeholder'].map(name => element.getAttribute(name) || '').join('\n');
    const visibleText = normalizedText(element.innerText || '');
    const childText = [...element.childNodes].filter(node => node.nodeType === 1).map(node => normalizedText(node.innerText || ''));
    // A value can be split over inline elements. Mask its smallest containing
    // element, while keeping ordinary page ancestors available to the reviewer.
    const splitValue = privateValues.some(value => visibleText.includes(value) && !childText.some(text => text.includes(value)));
    const splitPattern = expressions.some(expression => {
      expression.lastIndex = 0;
      return [...visibleText.matchAll(expression)].some(match => !childText.some(text => text.includes(match[0])));
    });
    if (sensitive(directText) || sensitive(labels) || splitValue || splitPattern) element.setAttribute('data-relay-private', '');
  }
}

export const privacyMaskPatterns = patternRules.map(({ source, flags }) => ({ source, flags }));
