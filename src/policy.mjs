const IRREVERSIBLE = /\b(?:submit\s+transfer|delete|confirm\s+payment|send\s+money|transfer\s+funds|close\s+account|wire\s+transfer|execute\s+payment)\b/i;
const SUPPORTED_ACTIONS = new Set(['navigate', 'fill', 'click', 'select', 'wait', 'read']);
const STATIC_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media']);
const GENERATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PolicyError extends Error {
  constructor(message, code = 'POLICY_DENIED') {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

function deny(message, code) { throw new PolicyError(message, code); }

/** Policy is checked independently of a model's claims about an action's risk. */
export class Policy {
  constructor({ baseUrl, allowedPaths = ['/bank', '/workspace'], allowedActions = ['navigate', 'fill', 'click', 'select', 'wait', 'read'] } = {}) {
    let base;
    try { base = new URL(baseUrl); } catch { deny('baseUrl must be an absolute HTTP(S) URL', 'INVALID_POLICY'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) deny('baseUrl must not contain credentials or a non-HTTP protocol', 'INVALID_POLICY');
    if (!Array.isArray(allowedPaths) || !allowedPaths.length || allowedPaths.some((path) => typeof path !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes('//') || path === '/')) deny('allowedPaths must contain explicit absolute route prefixes', 'INVALID_POLICY');
    if (!Array.isArray(allowedActions) || !allowedActions.length || allowedActions.some((action) => !SUPPORTED_ACTIONS.has(action))) deny('unsupported allowed action type', 'INVALID_POLICY');
    this.baseUrl = base.href;
    this.origin = base.origin;
    this.allowedPaths = Object.freeze([...new Set(allowedPaths)].map((path) => path.replace(/\/$/, '')));
    this.allowedActions = new Set(allowedActions);
  }

  assertUrl(value) {
    let url;
    try { url = new URL(value, this.baseUrl); } catch { deny('invalid navigation URL', 'URL_DENIED'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== this.origin) deny('navigation must remain on the configured application origin', 'URL_DENIED');
    // Reject alternate server interpretations of encoded separators/traversal.
    let decodedPath;
    try { decodedPath = decodeURIComponent(url.pathname); } catch { deny('malformed encoded navigation path', 'URL_DENIED'); }
    if (decodedPath.includes('\\') || decodedPath.split('/').length !== url.pathname.split('/').length || decodedPath.split('/').some((part) => part === '.' || part === '..') || /%(?:2f|5c|2e)/i.test(decodedPath)) deny('encoded path ambiguity is outside the route allowlist', 'URL_DENIED');
    if (!this.allowedPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) deny('navigation route is outside the configured allowlist', 'URL_DENIED');
    return url.href;
  }

  assertAction(action, { effect = 'read', owner = 'automation', observedTarget } = {}) {
    if (!['automation', 'human'].includes(owner)) deny('a paused session cannot perform actions', 'CONTROL_NOT_OWNED');
    if (!action || typeof action !== 'object' || !this.allowedActions.has(action.type)) deny('action type is outside the configured allowlist', 'ACTION_DENIED');
    if (!['read', 'reversible', 'irreversible'].includes(effect)) deny('unknown action effect', 'ACTION_DENIED');
    if (effect === 'irreversible') deny('irreversible actions are blocked by this deployment', 'IRREVERSIBLE_ACTION');
    const text = (action.target?.strategies || []).map((strategy) => strategy.name ?? strategy.label ?? strategy.text ?? '').join(' ');
    if (IRREVERSIBLE.test(text)) deny('target denotes an irreversible operation', 'IRREVERSIBLE_ACTION');
    const observedText = typeof observedTarget === 'string' ? observedTarget : observedTarget && typeof observedTarget === 'object' ? [observedTarget.name, observedTarget.label, observedTarget.text, ...(observedTarget.strategies || []).map((strategy) => strategy.name ?? strategy.label ?? strategy.text ?? '')].filter((part) => typeof part === 'string').join(' ') : '';
    if (IRREVERSIBLE.test(observedText)) deny('resolved live control denotes an irreversible operation', 'IRREVERSIBLE_ACTION');
    // Model decisions do not get arbitrary URL, script, CSS, or keyboard channels.
    if (['url', 'script', 'javascript', 'selector', 'css', 'evaluate', 'key'].some((key) => Object.hasOwn(action, key))) deny('unrestricted execution channels are prohibited', 'ACTION_DENIED');
    return action;
  }

  /** Install before opening the app; deny cross-origin redirects and subresources. */
  async protect(context) {
    if (!context || typeof context.route !== 'function') deny('a browser context is required', 'INVALID_POLICY');
    const handler = async (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient'); }
      if (url.origin !== this.origin || url.username || url.password) return route.abort('blockedbyclient');
      const resourceType = request.resourceType();
      const isStatic = STATIC_TYPES.has(resourceType) && (/^\/(?:static|assets)\//.test(url.pathname) || url.pathname === '/favicon.ico') && ['GET', 'HEAD'].includes(request.method());
      if (isStatic) return route.continue();
      try { this.assertUrl(url.href); } catch { return route.abort('blockedbyclient'); }
      return route.continue();
    };
    await context.route('**/*', handler);
    return handler;
  }
}

/** Redact persisted evidence. Declared sensitive outputs must also be omitted by callers. */
export function scrub(value, secrets = []) {
  if (!Array.isArray(secrets)) throw new TypeError('secrets must be an array');
  const known = secrets.filter((secret) => typeof secret === 'string' && secret.length > 0).sort((left, right) => right.length - left.length);
  const seen = new WeakSet();
  function text(input) {
    let output = input;
    for (const secret of known) output = output.split(secret).join('[REDACTED]');
    return output
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
      .replace(/\b(password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
      .replace(/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, '[REDACTED_PHONE]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/(?:-?\$\s*-?|\bUSD\s*-?)\d[\d,]*\.\d{2}\b/g, '[REDACTED_MONEY]')
      .replace(/\b\d{5}\b/g, '[REDACTED_MEMBER]')
      .replace(/\b\d{8,17}\b/g, '[REDACTED_ACCOUNT]');
  }
  function visit(item, key = '') {
    if (/^(?:password|passwd|credentials?|tokens?|authorization|cookie|api[_-]?key|member[_-]?id|account[_-]?(?:id|number)|savings[_-]?balance|minorUnits|full[_-]?name|ssn)$/i.test(key)) return '[REDACTED]';
    // Control metadata must survive the same /state round trip as its lease.
    // Numeric UUID segments can resemble account/member values by coincidence.
    // Exempt only validated generated IDs in these two metadata fields, never
    // arbitrary numeric strings or UUID-like text in application observations.
    if (typeof item === 'string' && ['sessionId', 'runId'].includes(key) && GENERATED_UUID.test(item)) return known.includes(item) ? '[REDACTED]' : item;
    if (typeof item === 'string') return text(item);
    if (typeof item === 'bigint') return '[REDACTED_INTEGER]';
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[CIRCULAR]';
    seen.add(item);
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    const output = {};
    for (const [entryKey, entry] of Object.entries(item)) output[entryKey] = visit(entry, entryKey);
    return output;
  }
  return visit(value);
}
