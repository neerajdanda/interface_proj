import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyLog } from './evidence.mjs';
import { scrub } from './policy.mjs';
import { buildTimeline } from './timeline.mjs';
import { renderTimelineHtml } from './timeline-ui.mjs';

const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const STATUS = new Set(['success', 'failure', 'business_outcome', 'intervention_required']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;

async function boundedRead(path, limit) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw Object.assign(new Error('Evidence file is not a bounded regular file'), { code: 'INVALID_EVIDENCE_FILE' });
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > limit) throw Object.assign(new Error('Evidence file exceeded its size limit'), { code: 'INVALID_EVIDENCE_FILE' });
  return text;
}

/** Recheck the actual loaded bytes; do not trust a prior verification of other bytes. */
function verifySnapshot(text) {
  let previous = '0'.repeat(64);
  const events = [];
  for (const line of text.trim() ? text.trim().split('\n') : []) {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid evidence event');
    const { hash, previousHash, ...body } = event;
    const actual = createHash('sha256').update(previous + JSON.stringify(body)).digest('hex');
    if (hash !== actual || previousHash !== previous || body.sequence !== events.length + 1) throw new Error('Evidence integrity mismatch');
    previous = hash;
    events.push(event);
  }
  const runIds = new Set(events.map(event => event.runId));
  if (events.length && (runIds.size !== 1 || !UUID.test(events[0].runId))) throw new Error('Evidence contains conflicting run identities');
  if (events.filter(event => event.type === 'run.started').length > 1) throw new Error('Evidence contains more than one run');
  return { events, finalHash: previous };
}

async function stableLog(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await boundedRead(path, MAX_LOG_BYTES);
    let verified;
    try { verified = await verifyLog(path); }
    catch (error) {
      const after = await boundedRead(path, MAX_LOG_BYTES);
      if (after !== first) continue;
      if (after && !after.endsWith('\n')) {
        const lastBreak = after.lastIndexOf('\n');
        verifySnapshot(lastBreak < 0 ? '' : after.slice(0, lastBreak + 1));
        try { JSON.parse(after.slice(lastBreak + 1)); } catch { return { updating: true }; }
      }
      throw error;
    }
    const after = await boundedRead(path, MAX_LOG_BYTES);
    if (first !== after) continue;
    const loaded = verifySnapshot(after);
    if (verified.events !== loaded.events.length || verified.finalHash !== loaded.finalHash) continue;
    return loaded;
  }
  return { updating: true };
}

function safeReport(result) {
  const report = {};
  if (STATUS.has(result.status)) report.status = result.status;
  if (typeof result.code === 'string' && CODE.test(result.code)) report.code = result.code;
  if (integer(result.modelCalls)) report.modelCalls = result.modelCalls;
  if (integer(result.handoffs)) report.handoffs = result.handoffs;
  return report;
}

function reconcileResult(events, result) {
  if (!result) return { state: 'missing', message: 'No result file has been written.' };
  if (typeof result !== 'object' || Array.isArray(result) || !STATUS.has(result.status)) return { state: 'invalid', message: 'The separate result file is not a recognized run result.' };
  const runId = events[0]?.runId;
  if (Object.hasOwn(result, 'runId') && result.runId !== runId) return { state: 'mismatch', message: 'The result belongs to a different run. It is excluded from this timeline.' };
  const started = events.find(event => event.type === 'run.started');
  const terminal = events.findLast(event => ['run.completed', 'run.stopped'].includes(event.type));
  const observedCalls = events.filter(event => event.type === 'model.observed').length;
  const expectedCalls = ['replay', 'discovery'].includes(started?.mode) ? observedCalls : null;
  const sessions = new Set(events.map(event => event.sessionId).filter(value => typeof value === 'string'));
  let mismatch = sessions.size > 0 && result.sessionId && !sessions.has(result.sessionId);
  if (terminal) {
    if (terminal.status && terminal.status !== result.status) mismatch = true;
    if (terminal.type === 'run.completed' && result.status !== 'success') mismatch = true;
    if (terminal.type === 'run.completed' && result.code !== 'GOAL_VERIFIED') mismatch = true;
    if (terminal.code && terminal.code !== result.code) mismatch = true;
    if (integer(terminal.modelCalls) && terminal.modelCalls !== result.modelCalls) mismatch = true;
    if (integer(terminal.handoffs) && terminal.handoffs !== result.handoffs) mismatch = true;
    if (Array.isArray(terminal.outputNames) && result.outputs && typeof result.outputs === 'object') {
      if (JSON.stringify([...terminal.outputNames].sort()) !== JSON.stringify(Object.keys(result.outputs).sort())) mismatch = true;
    }
  }
  if (expectedCalls !== null && integer(result.modelCalls) && expectedCalls !== result.modelCalls) mismatch = true;
  if (mismatch) return { state: 'mismatch', message: 'The separate result conflicts with verified run events. It is excluded from this timeline.' };
  const reported = safeReport(result);
  if (!Object.hasOwn(result, 'runId')) return { state: 'legacy', message: 'Earlier log format: result stored separately. Its run identity is not bound to this event chain.', reported };
  if (!terminal) return { state: 'pending', message: 'The result has the same run identity, but no terminal event has been recorded.', reported: { ...(reported.modelCalls !== undefined ? { modelCalls: reported.modelCalls } : {}) } };
  return { state: 'matched', message: 'Result identity and terminal metadata match the verified run.', reported };
}

// The HTTP contract is an independent allowlist over the timeline projection.
function allowProjection(projection) {
  const strings = (source, keys) => {
    const output = {};
    for (const key of keys) if (typeof source?.[key] === 'string') output[key] = scrub(source[key].slice(0, 2000));
    return output;
  };
  return {
    ...strings(projection, ['mode', 'goal', 'status', 'currentStep', 'currentPhase', 'owner', 'pauseReason', 'capability']),
    modelCalls: integer(projection.modelCalls) ? projection.modelCalls : 0,
    checkpointTelemetryAvailable: projection.checkpointTelemetryAvailable === true,
    operatorTestActor: projection.operatorTestActor === true,
    historyTruncated: projection.historyTruncated === true,
    steps: (Array.isArray(projection.steps) ? projection.steps : []).slice(0, 2000).map(step => ({
      ...strings(step, ['id', 'title', 'actionType', 'state']),
      checkpoints: strings(step.checkpoints, ['before', 'after']),
    })),
    items: (Array.isArray(projection.items) ? projection.items : []).slice(0, 2000).map(item => ({
      ...strings(item, ['time', 'kind', 'title', 'detail', 'step', 'phase', 'state', 'code']),
      sequence: integer(item.sequence) ? item.sequence : null,
    })),
  };
}

function envelope(integrity, timeline, result = { state: 'missing', message: 'No separate result is available.' }, runId) {
  return { mode: 'saved', readOnly: true, label: 'Saved run / read-only', source: { kind: 'saved', label: 'Saved run / read-only', ...(runId ? { runId } : {}) }, integrity, result, timeline: allowProjection(timeline) };
}

/** Fixed-file, read-only state loader. No observations, inputs, outputs, or decisions leave it. */
export async function readSavedReview(directory) {
  const emptyTimeline = () => buildTimeline({ events: [] });
  let log;
  try { log = await stableLog(join(directory, 'events.jsonl')); }
  catch (error) {
    if (error.code === 'ENOENT') return envelope({ state: 'missing', message: 'No saved event log exists yet.', events: 0 }, emptyTimeline());
    return envelope({ state: 'invalid', message: 'Evidence integrity check failed. Saved events are not displayed.', events: 0 }, emptyTimeline());
  }
  if (log.updating) return envelope({ state: 'updating', message: 'The event log is being written. Waiting for a complete, stable copy.', events: 0 }, emptyTimeline());
  if (log.events.length === 0) return envelope({ state: 'empty', message: 'The saved event log is empty. No run has been recorded.', events: 0, finalHash: log.finalHash }, emptyTimeline());
  let parsedResult;
  let result;
  try { parsedResult = JSON.parse(await boundedRead(join(directory, 'result.json'), MAX_RESULT_BYTES)); }
  catch (error) { result = error.code === 'ENOENT' ? { state: 'missing', message: 'No result file has been written.' } : { state: 'invalid', message: 'The separate result file could not be read. It is excluded from this timeline.' }; }
  result ||= reconcileResult(log.events, parsedResult);
  const calls = log.events.filter(event => event.type === 'model.observed').length;
  const boundResult = result.state === 'matched' ? safeReport(parsedResult) : null;
  const timeline = buildTimeline({ events: log.events, result: boundResult, modelCalls: calls });
  if (result.state === 'mismatch') timeline.status = 'evidence_conflict';
  const terminal = log.events.findLast(event => ['run.completed', 'run.stopped'].includes(event.type));
  const runState = terminal?.type === 'run.completed' ? 'completed' : terminal ? 'stopped' : 'incomplete';
  const message = `Saved event chain verified. ${runState === 'incomplete' ? 'No terminal event has been recorded. ' : ''}${result.state === 'legacy' || result.state === 'mismatch' ? result.message + ' ' : ''}This viewer cannot control a browser.`;
  return envelope({ state: 'verified', runState, message, events: log.events.length, finalHash: log.finalHash }, timeline, result, log.events[0].runId);
}

/** A loopback-only viewer for one configured run directory. It has no action endpoints. */
export class ReviewServer {
  constructor({ directory, port = 4181 } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('A single saved run directory is required');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Review port must be between 0 and 65535');
    this.directory = resolve(directory); this.port = port; this.server = null; this.baseUrl = null;
  }
  async state() { return readSavedReview(this.directory); }
  async start() {
    if (this.server) return this;
    this.server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
      const host = `127.0.0.1:${this.port}`;
      if (request.headers.host !== host || request.headers.origin && request.headers.origin !== `http://${host}`) { response.writeHead(403).end(); return; }
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      if (!['/', '/state'].includes(request.url)) { response.writeHead(404).end(); return; }
      try {
        const state = await this.state();
        if (request.url === '/state') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.writeHead(state.integrity.state === 'invalid' ? 409 : 200).end(JSON.stringify(state));
        } else {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(renderTimelineHtml(state.timeline, { title: 'Relay | Saved run', subtitle: 'Saved run / read-only', stateUrl: '/state', saved: true }));
        }
      } catch { response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'SAVED_REVIEW_UNAVAILABLE' })); }
    });
    try {
      await new Promise((resolveStart, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', resolveStart); });
    } catch (error) { this.server = null; throw error; }
    this.port = this.server.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }
  async close() {
    if (!this.server) return;
    const server = this.server; this.server = null;
    server.closeIdleConnections?.();
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
}
