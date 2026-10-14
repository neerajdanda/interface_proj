import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HUMAN_ATTESTATION = 'I performed the console steps';

/** Validate a manual session's recorded protocol and runtime continuity.
 * A trusted browser event is deliberately insufficient: Playwright can create
 * trusted events too. The person's explicit attestation is recorded separately.
 */
export function validateHumanVerification({ events, result, integrity, continuity, stepIds, privacyVerified }) {
  const reasons = [];
  const require = (condition, code) => { if (!condition) reasons.push(code); };
  const list = Array.isArray(events) ? events : [];
  const runId = list[0]?.runId;
  require(list.length > 0 && UUID.test(runId || '') && list.every(event => event.runId === runId), 'MIXED_OR_MISSING_RUN');
  require(list.every((event, index) => event.sequence === index + 1), 'EVENT_ORDER_INVALID');
  let previousHash = '0'.repeat(64);
  const chainMatches = list.every(event => {
    const { hash, previousHash: recordedPrevious, ...body } = event;
    const expected = createHash('sha256').update(previousHash + JSON.stringify(body)).digest('hex');
    const valid = hash === expected && recordedPrevious === previousHash;
    previousHash = hash;
    return valid;
  });
  require(chainMatches && integrity?.events === list.length && integrity?.finalHash === list.at(-1)?.hash, 'INTEGRITY_NOT_VERIFIED');
  require(result?.status === 'success' && result?.code === 'GOAL_VERIFIED', 'REPLAY_NOT_SUCCESSFUL');
  require(result?.modelCalls === 0 && !list.some(event => event.type === 'model.observed'), 'REPLAY_USED_MODEL');
  require(result?.handoffs === 1, 'HANDOFF_COUNT_INVALID');
  require(result?.outputs?.savings_balance?.currency === 'USD' && result.outputs.savings_balance.minorUnits === 812500, 'SYNTHETIC_OUTPUT_MISMATCH');
  const starts = list.filter(event => event.type === 'run.started');
  require(starts.length === 1 && starts[0].mode === 'replay', 'REPLAY_START_INVALID');
  const manual = list.find(event => event.type === 'verification.manual.started');
  require(manual?.adapter === 'BrowserSurface' && manual.manualInvocation === true && manual.consoleActionsAutomated === false && manual.sequence < starts[0]?.sequence, 'MANUAL_PROVENANCE_MISSING');
  require(!list.some(event => event.type === 'test.actor' || event.type === 'human.action' && event.actor !== 'human_operator'), 'AUTOMATED_OR_UNSPECIFIED_ACTOR');
  const pauses = list.filter(event => event.type === 'intervention.requested');
  const pause = pauses[0];
  require(pauses.length === 1 && pause?.code === 'SESSION_EXPIRED', 'EXPECTED_PAUSE_MISSING');
  const transfers = list.filter(event => event.type === 'control.transferred');
  const claim = transfers[0], resume = transfers[1];
  require(transfers.length === 2 && claim?.owner === 'human' && resume?.owner === 'automation', 'CONTROL_TRANSFER_INVALID');
  const humanActions = list.filter(event => event.type === 'human.action');
  const repair = humanActions.find(event => event.action?.type === 'click' && event.action.target?.strategies?.some(strategy => strategy.kind === 'role' && strategy.role === 'button' && strategy.name === 'Restore session'));
  require(Boolean(repair) && humanActions.every(event => event.sequence > claim?.sequence && event.sequence < resume?.sequence), 'MANUAL_REPAIR_MISSING');
  require(pause?.sequence < claim?.sequence && claim?.sequence < repair?.sequence && repair?.sequence < resume?.sequence, 'HANDOFF_ORDER_INVALID');
  require(UUID.test(result?.sessionId || '') && [pause, claim, resume, ...humanActions].every(event => event?.sessionId === result?.sessionId), 'SESSION_CHANGED');
  require(Number.isSafeInteger(pause?.epoch) && claim?.epoch > pause.epoch && resume?.epoch > claim.epoch && humanActions.every(event => event.epoch === claim.epoch), 'LEASE_EPOCH_INVALID');
  require(!list.some(event => event.type === 'action.started' && event.sequence > claim?.sequence && event.sequence < resume?.sequence), 'AUTOMATION_DURING_HUMAN_CONTROL');
  const recheck = list.find(event => event.type === 'checkpoint.revalidate' && event.sequence > resume?.sequence && event.step === pause?.step && event.phase === pause?.phase && event.sessionId === result?.sessionId);
  require(Boolean(recheck) && list.some(event => event.type === 'checkpoint.passed' && event.sequence > recheck.sequence && event.step === pause?.step && event.phase === pause?.phase), 'RESUMED_CHECKPOINT_NOT_VERIFIED');
  const actionIds = list.filter(event => event.type === 'action.started').map(event => event.step);
  require(Array.isArray(stepIds) && actionIds.length === stepIds.length && actionIds.every((id, index) => id === stepIds[index]), 'RECORDED_STEPS_CHANGED_OR_REPEATED');
  const terminals = list.filter(event => event.type === 'run.completed' || event.type === 'run.stopped');
  require(terminals.length === 1 && terminals[0].type === 'run.completed' && terminals[0].modelCalls === 0 && terminals[0].handoffs === 1, 'TERMINAL_EVENT_INVALID');
  require(['samePage', 'sameContext', 'sameSession', 'storagePreserved', 'pausedPageWasOriginal'].every(key => continuity?.[key] === true), 'SESSION_CONTINUITY_UNPROVEN');
  require(privacyVerified === true, 'PERSISTED_PRIVACY_UNVERIFIED');
  const attestation = list.find(event => event.type === 'verification.manual.attested');
  require(attestation?.affirmed === true && attestation.method === 'interactive_terminal' && attestation.consoleActionsAutomated === false && attestation.sequence > terminals[0]?.sequence, 'PARTICIPANT_ATTESTATION_MISSING');
  return {
    status: reasons.length ? 'incomplete' : 'verified',
    humanParticipant: reasons.length === 0,
    humanParticipationBasis: 'Explicit participant attestation plus manual console protocol; no identity or biometric verification',
    genuineAPIDiscovery: false,
    nativeBrowserReplay: reasons.length === 0,
    modelCalls: result?.modelCalls ?? null,
    handoffs: result?.handoffs ?? null,
    runId: UUID.test(runId || '') ? runId : null,
    reasons: [...new Set(reasons)],
  };
}
