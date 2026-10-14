import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { startSandbox } from '../src/sandbox.mjs';
import { BrowserSurface } from '../src/surface.mjs';
import { Policy } from '../src/policy.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Runner } from '../src/engine.mjs';
import { OperatorConsole } from '../src/operator.mjs';
import { HUMAN_ATTESTATION, validateHumanVerification } from '../src/human-verification.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));

function options(args) {
  const values = { capability: join(project, 'evidence', 'capability.json'), timeout: 300000, port: 4180 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--capability', '--timeout-ms', '--port'].includes(flag) || args[index + 1] === undefined) throw Object.assign(new Error('Use --capability PATH, --timeout-ms N, or --port N'), { code: 'INVALID_ARGUMENTS' });
    const value = args[++index];
    if (flag === '--capability') values.capability = resolve(value);
    else if (flag === '--timeout-ms') values.timeout = Number(value);
    else values.port = Number(value);
  }
  if (!Number.isSafeInteger(values.timeout) || values.timeout < 1000 || values.timeout > 600000 || !Number.isSafeInteger(values.port) || values.port < 0 || values.port > 65535) throw Object.assign(new Error('Invalid bounded deadline or console port'), { code: 'INVALID_ARGUMENTS' });
  return values;
}

async function attest() {
  if (!process.stdin.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 60000);
  try {
    const answer = await terminal.question(`To attest that you personally clicked Take control, Restore session, and Return control, type exactly:\n${HUMAN_ATTESTATION}\n> `, { signal: deadline.signal });
    return answer.trim() === HUMAN_ATTESTATION;
  } catch { return false; }
  finally { clearTimeout(timer); terminal.close(); }
}

async function checkPersistedPrivacy(directory) {
  const forbidden = ['12345', '67890', 'Alex Morgan', 'Jordan Reed', '$8,125.00', '$12,480.50', '812500', '1248050'];
  for (const name of await readdir(directory)) {
    if (!/\.(?:json|jsonl)$/.test(name)) continue;
    const raw = await readFile(join(directory, name), 'utf8');
    const objects = name.endsWith('.jsonl') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : [JSON.parse(raw)];
    for (const object of objects) {
      // Hashes are opaque integrity metadata; do not mistake a coincidental
      // numeric hash substring for a persisted account value.
      const clean = JSON.stringify(object, (key, value) => ['hash', 'previousHash', 'finalHash'].includes(key) ? undefined : value);
      if (forbidden.some(value => clean.includes(value))) return false;
    }
  }
  return true;
}

export async function runHumanVerification({ capabilityPath = join(project, 'evidence', 'capability.json'), timeoutMs = 300000, port = 4180 } = {}) {
  const opts = options(['--capability', capabilityPath, '--timeout-ms', String(timeoutMs), '--port', String(port)]);
  if (!process.stdin.isTTY) throw Object.assign(new Error('Run verify:human from an interactive terminal so the participant can attest after the console steps'), { code: 'INTERACTIVE_PARTICIPANT_REQUIRED' });
  const artifactBytes = await readFile(opts.capability, 'utf8');
  const capability = JSON.parse(artifactBytes);
  const parent = join(project, 'work', 'verification');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'human-'));
  let sandbox, surface, operator, evidence, runner;
  let cancelled = false, timer;
  const continuity = { samePage: false, sameContext: false, sameSession: false, storagePreserved: false, pausedPageWasOriginal: false };
  const stop = () => { cancelled = true; void surface?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    sandbox = await startSandbox({ port: 0 });
    surface = await BrowserSurface.launch({ baseUrl: sandbox.baseUrl, headless: false, scenario: 'session_expired' });
    const originalPage = surface.page, originalContext = surface.context;
    const policy = new Policy({ baseUrl: sandbox.baseUrl });
    await policy.protect(surface.context);
    evidence = new Evidence(directory, ['12345', '67890', 'Alex Morgan', 'Jordan Reed']);
    await evidence.init();
    await evidence.event('verification.manual.started', { adapter: 'BrowserSurface', manualInvocation: true, consoleActionsAutomated: false, capabilityHash: createHash('sha256').update(artifactBytes).digest('hex'), capabilitySource: opts.capability === join(project, 'evidence', 'capability.json') ? 'checked-in hosted-discovery artifact' : 'provided artifact; API provenance requires its separate verification record' });
    operator = new OperatorConsole({ port: opts.port, actor: 'human_operator' });
    runner = new Runner({ surface, policy, evidence, operator, handoffTimeoutMs: opts.timeout });
    const originalSessionId = runner.ownership.sessionId;
    const marker = randomUUID();
    operator.onIntervention = async active => {
      continuity.pausedPageWasOriginal = active === runner && surface.page === originalPage && surface.context === originalContext && runner.ownership.sessionId === originalSessionId;
      if (runner.ownership.pending?.code !== 'SESSION_EXPIRED') return;
      // An unrelated marker proves control transfer did not replace browser
      // storage. This is setup only: no console requests or repair clicks.
      await surface.page.evaluate(value => sessionStorage.setItem('relay.manual-verification.marker', value), marker);
      console.log(`\nSession paused. Open http://127.0.0.1:${operator.port} in your browser.\nPersonally click: Take control → Restore session → Return control.\nUse the console controls, then return to this terminal to attest.\nThe harness does not perform those actions for you.\n`);
    };
    timer = setTimeout(stop, opts.timeout + 30000);
    const result = await runner.replay(capability, { member_id: '67890' });
    clearTimeout(timer);
    continuity.samePage = surface.page === originalPage;
    continuity.sameContext = surface.context === originalContext;
    continuity.sameSession = result.sessionId === originalSessionId && runner.ownership.sessionId === originalSessionId;
    continuity.storagePreserved = await surface.page.evaluate(() => sessionStorage.getItem('relay.manual-verification.marker')).catch(() => null) === marker;
    if (result.status === 'success' && !cancelled && await attest()) await evidence.event('verification.manual.attested', { affirmed: true, method: 'interactive_terminal', consoleActionsAutomated: false });
    const raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
    const events = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
    const integrity = await verifyLog(join(directory, 'events.jsonl'));
    const privacyVerified = await checkPersistedPrivacy(directory);
    const proof = validateHumanVerification({ events, result, integrity, continuity, stepIds: capability.steps.map(step => step.id), privacyVerified });
    await writeFile(join(directory, 'human-verification.json'), JSON.stringify({ ...proof, checkedAt: new Date().toISOString(), integrity, continuity, privacyVerified }, null, 2) + '\n');
    if (proof.status !== 'verified') {
      console.error(`Manual verification incomplete: ${proof.reasons.join(', ')}. No human-participant success is claimed.`);
    } else console.log('Manual console takeover and same-session zero-model replay verified, with participant attestation.');
    console.log(`Redacted evidence: ${directory}`);
    return { directory, verification: proof };
  } catch (error) {
    const proof = { status: 'incomplete', humanParticipant: false, genuineAPIDiscovery: false, nativeBrowserReplay: false, checkedAt: new Date().toISOString(), reasons: [cancelled ? 'CANCELLED_OR_DEADLINE' : error.code || error.name || 'EXECUTION_ERROR'] };
    await writeFile(join(directory, 'human-verification.json'), JSON.stringify(proof, null, 2) + '\n');
    console.error(`Manual verification incomplete: ${cancelled ? 'CANCELLED_OR_DEADLINE' : error.code || error.name || 'EXECUTION_ERROR'}. No success is claimed.\nRedacted evidence: ${directory}`);
    return { directory, verification: proof };
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await operator?.close().catch(() => {}); await surface?.close().catch(() => {}); await sandbox?.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2));
    const { verification } = await runHumanVerification({ capabilityPath: opts.capability, timeoutMs: opts.timeout, port: opts.port });
    process.exitCode = verification.status === 'verified' ? 0 : 1;
  } catch (error) { console.error(`Manual verification could not start: ${error.code || error.name || 'EXECUTION_ERROR'}. ${error.message}`); process.exitCode = 1; }
}
