import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateHumanVerification } from '../src/human-verification.mjs';

const runId = 'dfb7b9e2-8f8b-4a57-91e7-d3ef6c0f6b8d';
const sessionId = 'b21b76b3-3a0d-4f5a-8baf-5e327b8279d3';
const repair = { type: 'click', target: { frame: 'Member workspace', strategies: [{ kind: 'role', role: 'button', name: 'Restore session' }] } };
function fixture(change = () => {}) {
  const records = [
    { type: 'verification.manual.started', adapter: 'BrowserSurface', manualInvocation: true, consoleActionsAutomated: false },
    { type: 'run.started', mode: 'replay', modelCalls: 0 },
    { type: 'action.started', step: 'step-1' },
    { type: 'action.completed', step: 'step-1' },
    { type: 'action.started', step: 'step-2' },
    { type: 'action.completed', step: 'step-2' },
    { type: 'intervention.requested', code: 'SESSION_EXPIRED', step: 'step-2', phase: 'after', sessionId, epoch: 2 },
    { type: 'control.transferred', owner: 'human', sessionId, epoch: 3 },
    { type: 'human.browser_action', trusted: true, typeOfAction: 'click', sessionId, epoch: 3 },
    { type: 'human.action', actor: 'human_operator', action: repair, sessionId, epoch: 3 },
    { type: 'control.transferred', owner: 'automation', sessionId, epoch: 4 },
    { type: 'checkpoint.revalidate', step: 'step-2', phase: 'after', sessionId },
    { type: 'checkpoint.passed', step: 'step-2', phase: 'after' },
    { type: 'action.started', step: 'step-3' },
    { type: 'action.completed', step: 'step-3' },
    { type: 'checkpoint.passed', step: 'success', phase: 'success' },
    { type: 'run.completed', status: 'success', modelCalls: 0, handoffs: 1 },
    { type: 'verification.manual.attested', affirmed: true, method: 'interactive_terminal', consoleActionsAutomated: false },
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
    events,
    result: { status: 'success', code: 'GOAL_VERIFIED', sessionId, modelCalls: 0, handoffs: 1, outputs: { savings_balance: { currency: 'USD', minorUnits: 812500 } } },
    integrity: { events: events.length, finalHash: previousHash },
    continuity: { samePage: true, sameContext: true, sameSession: true, storagePreserved: true, pausedPageWasOriginal: true },
    stepIds: ['step-1', 'step-2', 'step-3'],
    privacyVerified: true,
  };
}

test('manual proof requires explicit participant attestation and a successful same-session console protocol', () => {
  const proof = validateHumanVerification(fixture());
  assert.equal(proof.status, 'verified');
  assert.equal(proof.humanParticipant, true);
  assert.equal(proof.genuineAPIDiscovery, false, 'manual replay does not imply API discovery');
  assert.deepEqual(proof.reasons, []);
  assert.match(proof.humanParticipationBasis, /no identity or biometric verification/);
});

test('trusted browser events alone cannot certify a human participant', () => {
  const proof = validateHumanVerification(fixture(records => {
    records.splice(records.findIndex(event => event.type === 'human.action'), 1);
    records.splice(records.findIndex(event => event.type === 'verification.manual.attested'), 1);
  }));
  assert.equal(proof.humanParticipant, false);
  assert.ok(proof.reasons.includes('MANUAL_REPAIR_MISSING'));
  assert.ok(proof.reasons.includes('PARTICIPANT_ATTESTATION_MISSING'));
});

test('unspecified and automated console actors remain ineligible for human verification', () => {
  for (const actor of [undefined, 'automated_test_actor', 'simulated operator test actor']) {
    const proof = validateHumanVerification(fixture(records => { records.find(event => event.type === 'human.action').actor = actor; }));
    assert.equal(proof.humanParticipant, false);
    assert.ok(proof.reasons.includes('AUTOMATED_OR_UNSPECIFIED_ACTOR'));
  }
});

test('mixed runs and altered hashes cannot certify a manual run', () => {
  const mixed = fixture(records => { records[3].runId = 'db3a3d6f-edf1-4f8f-aa19-4f72e95d21ce'; });
  assert.ok(validateHumanVerification(mixed).reasons.includes('MIXED_OR_MISSING_RUN'));
  const changed = fixture(); changed.events[9].actor = 'another actor';
  assert.ok(validateHumanVerification(changed).reasons.includes('INTEGRITY_NOT_VERIFIED'));
});

test('stale leases and new sessions cannot satisfy the handoff proof', () => {
  const stale = fixture(records => { records.find(event => event.type === 'human.action').epoch = 2; });
  assert.ok(validateHumanVerification(stale).reasons.includes('LEASE_EPOCH_INVALID'));
  const switched = fixture(records => { records.find(event => event.type === 'human.action').sessionId = 'ce21ecb0-7f94-4d20-88a1-42d1b9c7298e'; });
  assert.ok(validateHumanVerification(switched).reasons.includes('SESSION_CHANGED'));
});

test('resuming without rechecking the paused checkpoint is incomplete', () => {
  const proof = validateHumanVerification(fixture(records => { records.splice(records.findIndex(event => event.type === 'checkpoint.revalidate'), 1); }));
  assert.ok(proof.reasons.includes('RESUMED_CHECKPOINT_NOT_VERIFIED'));
});

test('repeating a saved action and executing automation while human owns control fail proof', () => {
  const repeated = fixture(records => { records.splice(14, 0, { type: 'action.started', step: 'step-1' }); });
  assert.ok(validateHumanVerification(repeated).reasons.includes('RECORDED_STEPS_CHANGED_OR_REPEATED'));
  const concurrent = fixture(records => { records.splice(9, 0, { type: 'action.started', step: 'step-3' }); });
  assert.ok(validateHumanVerification(concurrent).reasons.includes('AUTOMATION_DURING_HUMAN_CONTROL'));
});

test('runtime continuity, correct synthetic output, privacy scan, and zero model calls are required', () => {
  const replaced = fixture(); replaced.continuity.sameContext = false;
  assert.ok(validateHumanVerification(replaced).reasons.includes('SESSION_CONTINUITY_UNPROVEN'));
  const wrongOutput = fixture(); wrongOutput.result.outputs.savings_balance.minorUnits = 1248050;
  assert.ok(validateHumanVerification(wrongOutput).reasons.includes('SYNTHETIC_OUTPUT_MISMATCH'));
  const unscanned = fixture(); unscanned.privacyVerified = false;
  assert.ok(validateHumanVerification(unscanned).reasons.includes('PERSISTED_PRIVACY_UNVERIFIED'));
  const model = fixture(records => { records.splice(2, 0, { type: 'model.observed' }); });
  assert.ok(validateHumanVerification(model).reasons.includes('REPLAY_USED_MODEL'));
});

test('empty or unsuccessful evidence produces explicit incomplete reasons', () => {
  assert.equal(validateHumanVerification({}).humanParticipant, false);
  const incomplete = fixture(); incomplete.result.status = 'failure';
  assert.ok(validateHumanVerification(incomplete).reasons.includes('REPLAY_NOT_SUCCESSFUL'));
});
