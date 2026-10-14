import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateConsoleVerification } from '../tools/console-verification.mjs';

const runId = 'dfb7b9e2-8f8b-4a57-91e7-d3ef6c0f6b8d';
const sessionId = 'b21b76b3-3a0d-4f5a-8baf-5e327b8279d3';
function fixture({ adapter = 'BrowserSurface', change = () => {} } = {}) {
  const records = [
    { type: 'test.actor', actor: 'automated_test_actor', consoleControlsAutomated: true, humanParticipant: false },
    { type: 'run.started', mode: 'replay', modelCalls: 0 },
    { type: 'action.started', step: 'step-1' },
    { type: 'action.completed', step: 'step-1' },
    { type: 'action.started', step: 'step-2' },
    { type: 'action.completed', step: 'step-2' },
    { type: 'intervention.requested', code: 'SESSION_EXPIRED', step: 'step-2', phase: 'after', sessionId, epoch: 2 },
    { type: 'control.transferred', owner: 'human', sessionId, epoch: 3 },
    { type: 'human.action', actor: 'automated_test_actor', action: { type: 'click', target: { frame: 'Member workspace', strategies: [{ kind: 'role', role: 'button', name: 'Restore session' }] } }, sessionId, epoch: 3 },
    { type: 'control.transferred', owner: 'automation', sessionId, epoch: 4 },
    { type: 'checkpoint.revalidate', step: 'step-2', phase: 'after', sessionId },
    { type: 'checkpoint.passed', step: 'step-2', phase: 'after' },
    { type: 'action.started', step: 'step-3' },
    { type: 'action.completed', step: 'step-3' },
    { type: 'checkpoint.passed', step: 'success', phase: 'success' },
    { type: 'run.completed', status: 'success', modelCalls: 0, handoffs: 1 },
  ];
  change(records);
  let previousHash = '0'.repeat(64);
  const events = records.map((record, index) => {
    const body = { runId, sequence: index + 1, ...record };
    const hash = createHash('sha256').update(previousHash + JSON.stringify(body)).digest('hex');
    const event = { ...body, previousHash, hash };
    previousHash = hash;
    return event;
  });
  return {
    adapter, events,
    result: { status: 'success', code: 'GOAL_VERIFIED', sessionId, modelCalls: 0, handoffs: 1, outputs: { savings_balance: { currency: 'USD', minorUnits: 812500 } } },
    integrity: { events: events.length, finalHash: previousHash },
    continuity: { samePage: true, sameSession: true, pausedPageWasOriginal: true, sameContext: adapter === 'BrowserSurface' ? true : null, storagePreserved: adapter === 'BrowserSurface' ? true : null, sameTab: adapter === 'ConnectedSurface' ? true : null },
    stepIds: ['step-1', 'step-2', 'step-3'], privacyVerified: true,
  };
}

test('automated native console proof remains explicit about its actor and lack of human/API participation', () => {
  const proof = validateConsoleVerification(fixture());
  assert.equal(proof.status, 'verified');
  assert.equal(proof.nativeBrowserReplay, true);
  assert.equal(proof.hostedBrowserReplay, false);
  assert.equal(proof.humanParticipant, false);
  assert.equal(proof.manualProof, false);
  assert.equal(proof.genuineAPIDiscovery, false);
});

test('hosted proof claims same live tab but never native or storage continuity', () => {
  const proof = validateConsoleVerification(fixture({ adapter: 'ConnectedSurface' }));
  assert.equal(proof.status, 'verified');
  assert.equal(proof.hostedBrowserReplay, true);
  assert.equal(proof.nativeBrowserReplay, false);
  const overstated = fixture({ adapter: 'ConnectedSurface' }); overstated.continuity.storagePreserved = true;
  assert.ok(validateConsoleVerification(overstated).reasons.includes('HOSTED_TAB_CONTINUITY_UNPROVEN'));
});

test('mixed actors and trusted browser events cannot replace actual console repair records', () => {
  const human = fixture({ change: records => { records.find(event => event.type === 'human.action').actor = 'human_operator'; } });
  assert.ok(validateConsoleVerification(human).reasons.includes('AUTOMATED_CONSOLE_REPAIR_MISSING'));
  const noRepair = fixture({ change: records => { records.find(event => event.type === 'human.action').type = 'human.browser_action'; } });
  assert.ok(validateConsoleVerification(noRepair).reasons.includes('AUTOMATED_CONSOLE_REPAIR_MISSING'));
});

test('changed hashes and cross-session repairs fail independent proof', () => {
  const tampered = fixture(); tampered.events[8].actor = 'human_operator';
  assert.ok(validateConsoleVerification(tampered).reasons.includes('INTEGRITY_NOT_VERIFIED'));
  const replaced = fixture({ change: records => { records.find(event => event.type === 'human.action').sessionId = 'dc6f4658-5636-49e9-902d-51b1afac43b2'; } });
  assert.ok(validateConsoleVerification(replaced).reasons.includes('SESSION_CHANGED'));
});

test('unverified checkpoints, stale leases, and repeated recorded actions cannot pass', () => {
  const noRecheck = fixture({ change: records => { records.splice(records.findIndex(event => event.type === 'checkpoint.revalidate'), 1); } });
  assert.ok(validateConsoleVerification(noRecheck).reasons.includes('RESUMED_CHECKPOINT_NOT_VERIFIED'));
  const stale = fixture({ change: records => { records.find(event => event.type === 'human.action').epoch = 2; } });
  assert.ok(validateConsoleVerification(stale).reasons.includes('LEASE_EPOCH_INVALID'));
  const repeated = fixture({ change: records => { records.splice(12, 0, { type: 'action.started', step: 'step-1' }); } });
  assert.ok(validateConsoleVerification(repeated).reasons.includes('RECORDED_STEPS_CHANGED_OR_REPEATED'));
});

test('native storage/context, synthetic output, privacy scan, and zero-model checks are necessary', () => {
  const wrongContext = fixture(); wrongContext.continuity.sameContext = false;
  assert.ok(validateConsoleVerification(wrongContext).reasons.includes('NATIVE_CONTEXT_OR_STORAGE_CHANGED'));
  const wrongOutput = fixture(); wrongOutput.result.outputs.savings_balance.minorUnits = 1248050;
  assert.ok(validateConsoleVerification(wrongOutput).reasons.includes('SYNTHETIC_OUTPUT_MISMATCH'));
  const unscanned = fixture(); unscanned.privacyVerified = false;
  assert.ok(validateConsoleVerification(unscanned).reasons.includes('PERSISTED_PRIVACY_UNVERIFIED'));
  const model = fixture({ change: records => { records.splice(2, 0, { type: 'model.observed' }); } });
  assert.ok(validateConsoleVerification(model).reasons.includes('REPLAY_USED_MODEL'));
});
