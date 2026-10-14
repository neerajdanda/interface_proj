import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { startSandbox } from '../src/sandbox.mjs';
import { BrowserSurface } from '../src/surface.mjs';
import { Policy } from '../src/policy.mjs';
import { Evidence, verifyLog } from '../src/evidence.mjs';
import { Runner } from '../src/engine.mjs';
import { OpenAIModel } from '../src/model.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const arguments_ = process.argv.slice(2);
const api = arguments_.includes('--api');
const human = arguments_.includes('--human');
if (arguments_.some(value => !['--api', '--human'].includes(value)) || human && !api) {
  console.error('Usage: node tools/verify-live.mjs [--api [--human]]');
  process.exit(1);
}
if (api && !process.env.OPENAI_API_KEY) {
  try { loadEnvFile(join(project, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') { console.error('Could not load the local .env file.'); process.exit(1); } }
}
if (api && !process.env.OPENAI_API_KEY) {
  console.error('API verification requires OPENAI_API_KEY in the process environment. Do not paste a key into chat.');
  process.exitCode = 1;
} else {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'tests/surface.test.mjs', 'tests/replay-live.test.mjs'], {
      cwd: project, env: { ...process.env, RELAY_LIVE_TESTS: '1', RELAY_HTTP_TESTS: '1' }, stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (value, signal) => resolve(signal ? 1 : value ?? 1));
  });
  process.exitCode = code;
  if (code === 0 && api) {
    let sandbox, surface, model;
    try {
      const { mkdir } = await import('node:fs/promises');
      const parent = join(project, 'work', 'verification');
      await mkdir(parent, { recursive: true });
      const directory = await mkdtemp(join(parent, 'api-'));
      const artifactPath = join(directory, 'capability.json');
      sandbox = await startSandbox({ port: 0 });
      model = new OpenAIModel();
      const runs = [];
      for (const mode of ['discovery', 'replay']) {
        surface = await BrowserSurface.launch({ baseUrl: sandbox.baseUrl });
        const policy = new Policy({ baseUrl: sandbox.baseUrl });
        await policy.protect(surface.context);
        const evidence = new Evidence(join(directory, mode), ['12345', '67890']);
        await evidence.init();
        const runner = new Runner({ surface, policy, evidence });
        const result = mode === 'discovery'
          ? await runner.discover({ goal: 'Look up member {{member_id}} and read their savings balance', inputs: { member_id: '12345' }, entry: { path: '/bank', frame: 'Member workspace' }, model, artifactPath })
          : await runner.replay(JSON.parse(await readFile(artifactPath, 'utf8')), { member_id: '67890' });
        const expectedCents = mode === 'discovery' ? 1248050 : 812500;
        if (result.status !== 'success' || result.outputs?.savings_balance?.minorUnits !== expectedCents || result.outputs.savings_balance.currency !== 'USD') {
          throw Object.assign(new Error('Verification did not obtain the expected synthetic result'), { code: result.code || 'UNEXPECTED_RESULT' });
        }
        if (mode === 'replay' && result.modelCalls !== 0) throw Object.assign(new Error('Replay used a model'), { code: 'REPLAY_MODEL_CALL' });
        if (mode === 'discovery' && result.modelCalls < 1) throw Object.assign(new Error('Discovery used no model'), { code: 'NO_MODEL_DISCOVERY' });
        runs.push({ mode, status: result.status, modelCalls: result.modelCalls, outputVerified: true, integrity: await verifyLog(join(evidence.directory, 'events.jsonl')) });
        await surface.close(); surface = null;
      }
      const verification = { genuineAPIDiscovery: true, nativeBrowserReplay: true, automatedConsoleTestActor: true, humanParticipant: false, runs };
      await writeFile(join(directory, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', { mode: 0o600 });
      console.log(`API discovery and zero-model replay verified. Redacted evidence: ${directory}`);
      if (human) {
        const { runHumanVerification } = await import('./verify-human.mjs');
        const manual = await runHumanVerification({ capabilityPath: artifactPath });
        verification.manualVerification = { directory: manual.directory, ...manual.verification };
        verification.humanParticipant = manual.verification?.humanParticipant === true;
        await writeFile(join(directory, 'verification.json'), JSON.stringify(verification, null, 2) + '\n', { mode: 0o600 });
        if (!verification.humanParticipant) throw Object.assign(new Error('Manual takeover was not verified'), { code: 'HUMAN_VERIFICATION_PENDING' });
        console.log(`Complete API discovery, replay, and attested manual takeover verified. Evidence: ${directory}`);
      }
    } catch (error) {
      console.error(`${human ? 'End-to-end' : 'API'} verification did not pass: ${error.code || error.name || 'EXECUTION_ERROR'}. No overall success is claimed; any completed stages retain their separate evidence.`);
      process.exitCode = 1;
    } finally {
      await surface?.close(); await model?.close(); await sandbox?.close();
    }
  }
}
