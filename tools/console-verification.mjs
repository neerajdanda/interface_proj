import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Runner } from '../src/engine.mjs';
import { OperatorConsole } from '../src/operator.mjs';
import { Policy } from '../src/policy.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** This verifies an automated console test actor, never a human participant. */
export function validateConsoleVerification({ events = [], result, integrity, continuity, stepIds, adapter, privacyVerified }) {
  const reasons = [];
  const require = (condition, code) => { if (!condition) reasons.push(code); };
  const runId = events[0]?.runId;
  require(events.length > 0 && UUID.test(runId || '') && events.every((event, index) => event.runId === runId && event.sequence === index + 1), 'EVENT_RUN_OR_ORDER_INVALID');
  let previous = '0'.repeat(64);
  const chainValid = events.every(event => {
    const { hash, previousHash, ...body } = event;
    const valid = hash === createHash('sha256').update(previous + JSON.stringify(body)).digest('hex') && previousHash === previous;
    previous = hash;
    return valid;
  });
  require(chainValid && integrity?.events === events.length && integrity?.finalHash === events.at(-1)?.hash, 'INTEGRITY_NOT_VERIFIED');
  require(['BrowserSurface', 'ConnectedSurface'].includes(adapter), 'ADAPTER_UNSPECIFIED');
  require(result?.status === 'success' && result.code === 'GOAL_VERIFIED', 'REPLAY_NOT_SUCCESSFUL');
  require(result?.modelCalls === 0 && !events.some(event => event.type === 'model.observed'), 'REPLAY_USED_MODEL');
  require(result?.handoffs === 1, 'HANDOFF_COUNT_INVALID');
  require(result?.outputs?.savings_balance?.currency === 'USD' && result.outputs.savings_balance.minorUnits === 812500, 'SYNTHETIC_OUTPUT_MISMATCH');
  const actor = events.find(event => event.type === 'test.actor');
  require(actor?.actor === 'automated_test_actor' && actor.consoleControlsAutomated === true && actor.humanParticipant === false, 'AUTOMATED_ACTOR_NOT_DECLARED');
  const starts = events.filter(event => event.type === 'run.started');
  require(starts.length === 1 && starts[0].mode === 'replay' && actor?.sequence < starts[0]?.sequence, 'REPLAY_START_INVALID');
  const pauses = events.filter(event => event.type === 'intervention.requested');
  const pause = pauses[0];
  require(pauses.length === 1 && pause?.code === 'SESSION_EXPIRED', 'EXPECTED_PAUSE_MISSING');
  const transfers = events.filter(event => event.type === 'control.transferred');
  const claim = transfers[0], resume = transfers[1];
  require(transfers.length === 2 && claim?.owner === 'human' && resume?.owner === 'automation', 'CONTROL_TRANSFER_INVALID');
  const controls = events.filter(event => event.type === 'human.action');
  const repair = controls.find(event => event.action?.type === 'click' && event.action.target?.strategies?.some(strategy => strategy.kind === 'role' && strategy.role === 'button' && strategy.name === 'Restore session'));
  require(Boolean(repair) && controls.every(event => event.actor === 'automated_test_actor'), 'AUTOMATED_CONSOLE_REPAIR_MISSING');
  require(pause?.sequence < claim?.sequence && claim?.sequence < repair?.sequence && repair?.sequence < resume?.sequence && controls.every(event => event.sequence > claim?.sequence && event.sequence < resume?.sequence), 'HANDOFF_ORDER_INVALID');
  require(UUID.test(result?.sessionId || '') && [pause, claim, resume, ...controls].every(event => event?.sessionId === result?.sessionId), 'SESSION_CHANGED');
  require(Number.isSafeInteger(pause?.epoch) && claim?.epoch > pause.epoch && resume?.epoch > claim.epoch && controls.every(event => event.epoch === claim.epoch), 'LEASE_EPOCH_INVALID');
  require(!events.some(event => event.type === 'action.started' && event.sequence > claim?.sequence && event.sequence < resume?.sequence), 'AUTOMATION_DURING_OPERATOR_CONTROL');
  const recheck = events.find(event => event.type === 'checkpoint.revalidate' && event.sequence > resume?.sequence && event.step === pause?.step && event.phase === pause?.phase && event.sessionId === result?.sessionId);
  require(Boolean(recheck) && events.some(event => event.type === 'checkpoint.passed' && event.sequence > recheck.sequence && event.step === pause?.step && event.phase === pause?.phase), 'RESUMED_CHECKPOINT_NOT_VERIFIED');
  const actions = events.filter(event => event.type === 'action.started').map(event => event.step);
  require(Array.isArray(stepIds) && actions.length === stepIds.length && actions.every((id, index) => id === stepIds[index]), 'RECORDED_STEPS_CHANGED_OR_REPEATED');
  const terminals = events.filter(event => event.type === 'run.completed' || event.type === 'run.stopped');
  require(terminals.length === 1 && terminals[0].type === 'run.completed' && terminals[0].modelCalls === 0 && terminals[0].handoffs === 1, 'TERMINAL_EVENT_INVALID');
  require(continuity?.samePage === true && continuity.sameSession === true && continuity.pausedPageWasOriginal === true, 'SESSION_CONTINUITY_UNPROVEN');
  if (adapter === 'BrowserSurface') require(continuity?.sameContext === true && continuity.storagePreserved === true, 'NATIVE_CONTEXT_OR_STORAGE_CHANGED');
  if (adapter === 'ConnectedSurface') require(continuity?.sameTab === true && continuity.storagePreserved === null, 'HOSTED_TAB_CONTINUITY_UNPROVEN');
  require(privacyVerified === true, 'PERSISTED_PRIVACY_UNVERIFIED');
  return {
    status: reasons.length ? 'incomplete' : 'verified',
    humanParticipant: false,
    manualProof: false,
    automatedConsoleTestActor: true,
    adapter,
    genuineAPIDiscovery: false,
    nativeBrowserReplay: reasons.length === 0 && adapter === 'BrowserSurface',
    hostedBrowserReplay: reasons.length === 0 && adapter === 'ConnectedSurface',
    modelCalls: result?.modelCalls ?? null,
    handoffs: result?.handoffs ?? null,
    runId: UUID.test(runId || '') ? runId : null,
    reasons: [...new Set(reasons)],
  };
}

async function persistedPrivacy(directory) {
  const forbidden = ['12345', '67890', 'Alex Morgan', 'Jordan Reed', '$8,125.00', '$12,480.50', '812500', '1248050'];
  for (const name of await readdir(directory)) {
    if (!/\.(?:json|jsonl)$/.test(name)) continue;
    const raw = await readFile(join(directory, name), 'utf8');
    const records = name.endsWith('.jsonl') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : [JSON.parse(raw)];
    for (const record of records) {
      const serialized = JSON.stringify(record, (key, value) => ['hash', 'previousHash', 'finalHash', 'capabilityHash'].includes(key) || ['runId', 'sessionId'].includes(key) && UUID.test(value || '') ? undefined : value);
      if (forbidden.some(value => serialized.includes(value))) return false;
    }
  }
  return true;
}

async function writeSummary(directory, summary) {
  const temporary = join(directory, `.console-verification-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'console-verification.json'));
}

/** Start a real replay and leave takeover/action/resume to the caller's UI
 * automation. No console control requests, ownership mutation, or repair UI
 * actions occur inside this helper. Caller must close after reviewing success.
 */
export async function beginConsoleReplay({ surface, baseUrl, directory, capabilityPath = join(project, 'evidence', 'capability.json'), operator, port = 0, timeoutMs = 300000 } = {}) {
  if (!surface?.page || !baseUrl || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('A live surface, origin, and bounded timeout are required');
  const adapter = surface.tab ? 'ConnectedSurface' : 'BrowserSurface';
  if (surface.scenario !== 'session_expired') throw new Error('Console verification requires a fresh session_expired surface');
  if (operator && (operator.runner || operator.actor !== 'automated_test_actor')) throw new Error('Use a new console explicitly labeled automated_test_actor');
  if (directory) {
    await mkdir(directory, { recursive: true });
    if ((await readdir(directory)).length) throw new Error('Console verification requires an empty evidence directory');
  } else {
    const parent = join(project, 'work', 'verification');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'console-'));
  }
  const artifactBytes = await readFile(capabilityPath, 'utf8');
  const capability = JSON.parse(artifactBytes);
  const evidence = new Evidence(directory, ['12345', '67890', 'Alex Morgan', 'Jordan Reed']);
  await evidence.init();
  await evidence.event('test.actor', { actor: 'automated_test_actor', consoleControlsAutomated: true, humanParticipant: false, adapter, capabilityHash: createHash('sha256').update(artifactBytes).digest('hex'), purpose: 'Drive actual console UI controls; preserve the same browser session and revalidate its checkpoint' });
  const policy = surface.policy || new Policy({ baseUrl });
  if (surface.context) await policy.protect(surface.context);
  operator ||= new OperatorConsole({ port, actor: 'automated_test_actor' });
  const runner = new Runner({ surface, policy, evidence, operator, handoffTimeoutMs: timeoutMs });
  const page = surface.page, context = surface.context, tab = surface.tab;
  const sessionId = runner.ownership.sessionId;
  const marker = randomUUID();
  const continuity = { samePage: false, sameContext: adapter === 'BrowserSurface' ? false : null, sameTab: adapter === 'ConnectedSurface' ? false : null, sameSession: false, storagePreserved: adapter === 'BrowserSurface' ? false : null, pausedPageWasOriginal: false };
  let notifyReady, state = 'starting', closed = false;
  const ready = new Promise(resolve => { notifyReady = resolve; });
  operator.onIntervention = async active => {
    continuity.pausedPageWasOriginal = active === runner && surface.page === page && runner.ownership.sessionId === sessionId && (adapter === 'BrowserSurface' ? surface.context === context : surface.tab === tab);
    if (adapter === 'BrowserSurface') await page.evaluate(value => sessionStorage.setItem('relay.console-verification.marker', value), marker);
    state = 'paused';
    notifyReady({ url: `http://127.0.0.1:${operator.port}`, directory, code: runner.ownership.pending?.code, sessionId });
  };
  const close = async () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    await operator.close().catch(() => {});
    if (adapter === 'BrowserSurface') await surface.close().catch(() => {});
  };
  const timer = setTimeout(() => { void close(); }, timeoutMs + 30000);
  const completion = (async () => {
    try {
      const result = await runner.replay(capability, { member_id: '67890' });
      continuity.samePage = surface.page === page;
      continuity.sameSession = result.sessionId === sessionId && runner.ownership.sessionId === sessionId;
      if (adapter === 'BrowserSurface') {
        continuity.sameContext = surface.context === context;
        continuity.storagePreserved = await page.evaluate(() => sessionStorage.getItem('relay.console-verification.marker')).catch(() => null) === marker;
      } else continuity.sameTab = surface.tab === tab;
      const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const integrity = await verifyLog(join(directory, 'events.jsonl'));
      const privacyVerified = await persistedPrivacy(directory);
      const verification = validateConsoleVerification({ events, result, integrity, continuity, stepIds: capability.steps.map(step => step.id), adapter, privacyVerified });
      const summary = { ...verification, checkedAt: new Date().toISOString(), integrity, continuity, privacyVerified, storageContinuity: adapter === 'BrowserSurface' ? 'Session-storage marker retained' : 'Not asserted for hosted adapter; same live tab/page/session checked' };
      await writeSummary(directory, summary);
      state = verification.status;
      notifyReady({ url: `http://127.0.0.1:${operator.port}`, directory, code: result.code, state });
      return { directory, verification: summary };
    } catch (error) {
      state = 'incomplete';
      const verification = { status: 'incomplete', humanParticipant: false, manualProof: false, automatedConsoleTestActor: true, adapter, checkedAt: new Date().toISOString(), reasons: [error.code || error.name || 'EXECUTION_ERROR'] };
      await writeSummary(directory, verification);
      notifyReady({ directory, state, code: verification.reasons[0] });
      return { directory, verification };
    }
  })();
  return { runner, operator, surface, evidence, directory, completion, ready, close, status: () => state };
}
