import { scrub } from './policy.mjs';

const ACTIONS = new Set(['fill', 'click', 'select', 'wait', 'navigate', 'read']);
const PHASES = new Set(['before', 'action', 'after', 'success']);
const STATUSES = new Set(['success', 'failure', 'business_outcome', 'intervention_required']);
const REASONS = {
  SESSION_EXPIRED: 'The application session expired.',
  UNEXPECTED_DIALOG: 'An unexpected dialog needs an operator.',
  AMBIGUOUS_TARGET: 'More than one control matched the action.',
  TARGET_AMBIGUOUS: 'More than one control matched the action.',
  TARGET_NOT_FOUND: 'The expected control is unavailable.',
  CHECKPOINT_TIMEOUT: 'The expected page state did not appear in time.',
  MODEL_ESCALATION: 'Discovery requested operator assistance.',
  MEMBER_NOT_FOUND: 'The member was not found.',
  VALIDATION_ERROR: 'The application rejected the input.',
  PERMISSION_DENIED: 'The application denied permission.',
  APPLICATION_ERROR: 'The application reported an error.',
  GOAL_VERIFIED: 'The goal was verified.',
};

function safeText(value, limit = 180) {
  if (typeof value !== 'string') return '';
  return scrub(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
}
function code(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value.toUpperCase() : ''; }
function phase(value) { return PHASES.has(value) ? value : ''; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function reason(value) { return REASONS[code(value)] || 'An interruption needs review.'; }
function actionType(action) { return ACTIONS.has(action?.type) ? action.type : ''; }
function actionTitle(action) {
  const type = actionType(action);
  // Only the control's descriptor is retained. Entered values, parameters,
  // frame observations, selectors and complete target objects never leave here.
  const strategy = Array.isArray(action?.target?.strategies) ? action.target.strategies[0] : null;
  const label = safeText(strategy?.name ?? strategy?.label ?? strategy?.text, 90);
  const verbs = { fill: 'Enter', click: 'Click', select: 'Select', wait: 'Wait', navigate: 'Open application', read: 'Read' };
  return type ? `${verbs[type]}${label ? ` · ${label}` : ''}` : 'Application action';
}

/** A presentation projection, not an alternate source of execution state.
 * Callers pass scrubbed evidence; this function also discards all observations,
 * inputs, output values, decision bodies, URLs and control credentials.
 */
export function buildTimeline({ events = [], result = null, modelCalls } = {}) {
  const records = Array.isArray(events) ? events.filter(event => event && typeof event === 'object') : [];
  const started = records.find(event => event.type === 'run.started') || {};
  const timeline = {
    mode: ['discovery', 'replay'].includes(started.mode) ? started.mode : 'unknown',
    goal: safeText(started.goal || started.capabilityTitle || started.capabilityName || started.capability) || 'Run goal not recorded',
    capability: safeText(started.capability, 100),
    status: records.length ? 'running' : 'empty',
    modelCalls: count(modelCalls) ?? count(result?.modelCalls) ?? records.filter(event => event.type === 'model.observed').length,
    currentStep: '', currentPhase: '', owner: records.length ? 'automation' : 'unknown',
    pauseReason: '', checkpointTelemetryAvailable: false, operatorTestActor: false, historyTruncated: false, steps: [], items: [],
  };
  let previousSequence = 0;
  let firstGap = -1;
  for (const [index, record] of records.entries()) {
    const sequence = count(record.sequence);
    if (sequence === null || sequence === 0) continue;
    if (sequence > previousSequence + 1) {
      timeline.historyTruncated = true;
      if (firstGap === -1) firstGap = index;
    }
    previousSequence = sequence;
  }
  const steps = new Map();
  const actionHistory = new Set();
  function stepFor(id, title = '', type = '') {
    const key = safeText(id, 100);
    if (!key || key === 'success') return null;
    if (!steps.has(key)) steps.set(key, { id: key, title: title || `Step ${steps.size + 1}`, actionType: type, state: 'planned', checkpoints: { before: 'not_recorded', after: 'not_recorded' } });
    const step = steps.get(key);
    if (title) step.title = title;
    if (type) step.actionType = type;
    return step;
  }
  if (Array.isArray(started.plan)) {
    for (const entry of started.plan) {
      if (!entry || typeof entry !== 'object') continue;
      stepFor(entry.id, safeText(entry.title, 100), ACTIONS.has(entry.actionType) ? entry.actionType : '');
    }
  }
  function add(event, kind, title, detail = '', extra = {}) {
    timeline.items.push({
      sequence: count(event.sequence),
      time: typeof event.time === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(event.time) ? event.time : '',
      kind, title, detail, step: safeText(event.step, 100), phase: phase(event.phase), ...extra,
    });
  }
  let observedCount = 0;
  for (const event of records) {
    const stepId = safeText(event.step, 100);
    const eventPhase = phase(event.phase);
    const relevant = /^(?:model\.|action\.|checkpoint\.|intervention\.|recovery\.|run\.(?:stopped|completed))/.test(event.type || '');
    if (relevant && stepId) timeline.currentStep = stepId;
    if (relevant && eventPhase) timeline.currentPhase = eventPhase;
    const isStepEvent = /^action\./.test(event.type || '') || /^checkpoint\./.test(event.type || '') && ['before', 'after'].includes(eventPhase) || event.type === 'model.decided' && event.decision?.kind === 'action';
    const step = isStepEvent ? stepFor(stepId) : steps.get(stepId);
    switch (event.type) {
      case 'run.started':
        add(event, 'run', timeline.mode === 'discovery' ? 'Discovery started' : timeline.mode === 'replay' ? 'Replay started' : 'Run started');
        break;
      case 'model.observed':
        observedCount += 1;
        add(event, 'model', 'Observation prepared for model', `Discovery observation ${observedCount}`);
        break;
      case 'model.decided': {
        const kind = event.decision?.kind;
        if (step && step.state === 'planned') step.state = 'proposed';
        const titles = { action: 'Model proposed an action', finish: 'Model proposed completion', escalate: 'Model requested assistance' };
        add(event, 'proposal', titles[kind] || 'Model returned a decision', 'A proposal does not confirm an application action.');
        break;
      }
      case 'action.started':
      case 'action.completed': {
        const complete = event.type === 'action.completed';
        const title = actionTitle(event.action);
        if (stepId) actionHistory.add(stepId);
        if (step) { step.title = title; step.actionType = actionType(event.action); step.state = complete ? 'completed' : 'started'; }
        timeline.currentPhase = 'action';
        add(event, 'action', `${complete ? 'Action completed' : 'Action started'} · ${title}`, '', { state: complete ? 'completed' : 'started' });
        break;
      }
      case 'checkpoint.started':
      case 'checkpoint.passed': {
        timeline.checkpointTelemetryAvailable = true;
        const passed = event.type === 'checkpoint.passed';
        const conditions = Array.isArray(event.expected) ? event.expected.length : count(event.conditionCount);
        const state = conditions === 0 ? 'empty' : passed ? 'passed' : 'checking';
        if (step && ['before', 'after'].includes(eventPhase)) step.checkpoints[eventPhase] = state;
        if (step && passed && eventPhase === 'after' && conditions !== 0) step.state = 'verified';
        const boundary = eventPhase === 'success' || stepId === 'success' ? 'Goal verification' : eventPhase === 'before' ? 'Before action' : eventPhase === 'after' ? 'After action' : 'Checkpoint';
        const detail = conditions === 0 ? 'No conditions at this boundary.' : conditions === null ? 'Condition count not recorded.' : `${conditions} ${conditions === 1 ? 'condition' : 'conditions'}`;
        add(event, 'checkpoint', `${boundary} · ${conditions === 0 ? 'boundary reached' : passed ? 'passed' : 'checking'}`, detail, { state });
        break;
      }
      case 'checkpoint.revalidate':
        add(event, 'checkpoint', 'Checkpoint recheck requested', 'Verification follows after control returns.', { state: 'requested' });
        break;
      case 'intervention.requested':
        timeline.status = 'paused'; timeline.owner = 'paused'; timeline.pauseReason = reason(event.code);
        if (step) step.state = 'paused';
        add(event, 'pause', 'Automation paused', timeline.pauseReason, { code: code(event.code) });
        break;
      case 'control.transferred':
        if (['human', 'automation'].includes(event.owner)) {
          timeline.owner = event.owner;
          timeline.status = event.owner === 'human' ? 'operator_control' : 'running';
          if (event.owner === 'automation') timeline.pauseReason = '';
          add(event, 'control', event.owner === 'human' ? 'Operator took control' : 'Automation resumed', event.owner === 'automation' ? 'The same session continues; its checkpoint is rechecked.' : 'Automation cannot act while the operator owns the session.');
        }
        break;
      case 'human.action':
      case 'human.browser_action': {
        const testActor = ['simulated operator test actor', 'automated HTTP console test actor', 'automated_test_actor'].includes(event.actor);
        if (testActor) timeline.operatorTestActor = true;
        const actor = event.actor === 'simulated operator test actor' ? 'Simulated operator test actor' : event.actor === 'automated HTTP console test actor' ? 'Automated HTTP console test actor' : event.actor === 'automated_test_actor' ? 'Automated console test actor' : event.type === 'human.browser_action' ? 'Operator browser action' : 'Operator action';
        add(event, 'human', `${actor} · ${actionTitle(event.action || event)}`, event.type === 'human.browser_action' ? 'Direct browser recording is best effort.' : 'Entered values are omitted.');
        break;
      }
      case 'test.actor':
        if (['simulated operator test actor', 'automated HTTP console test actor', 'automated_test_actor'].includes(event.actor)) {
          timeline.operatorTestActor = true;
          add(event, 'test', 'Operator test actor recorded', event.actor === 'automated_test_actor' ? 'Automated console test actor; no human participant is implied.' : event.actor === 'automated HTTP console test actor' ? 'Automated HTTP console test actor; no human participant is implied.' : 'Simulated operator test actor; no human participant is implied.');
        }
        break;
      case 'recovery.applied':
        add(event, 'recovery', 'Declared recovery applied', count(event.attempt) !== null ? `Recovery attempt ${event.attempt}` : 'A bounded recovery was recorded.', { code: code(event.code) });
        break;
      case 'capability.recorded':
        timeline.capability = safeText(event.capability, 100) || timeline.capability;
        add(event, 'artifact', 'Reusable capability recorded', count(event.steps) !== null ? `${event.steps} recorded actions` : 'The discovery artifact was saved.');
        break;
      case 'run.completed':
        timeline.status = 'success'; timeline.pauseReason = '';
        add(event, 'success', 'Run completed', 'The goal was verified. Private outputs are omitted.');
        break;
      case 'run.stopped':
        timeline.status = STATUSES.has(event.status) ? event.status : 'failure';
        if (timeline.status === 'intervention_required') timeline.pauseReason = reason(event.code);
        add(event, 'stop', timeline.status === 'business_outcome' ? 'Application outcome recorded' : timeline.status === 'intervention_required' ? 'Operator assistance required' : 'Run stopped', reason(event.code), { code: code(event.code) });
        break;
      default: break;
    }
  }
  if (STATUSES.has(result?.status)) timeline.status = result.status;
  if (result?.status === 'intervention_required') timeline.pauseReason = reason(result.code);
  if (typeof result?.step === 'string') timeline.currentStep = safeText(result.step, 100);
  if (PHASES.has(result?.phase)) timeline.currentPhase = result.phase;
  timeline.steps = [...steps.values()];
  if (timeline.historyTruncated) {
    const retainedIndices = records.slice(firstGap).filter(event => /^action\./.test(event.type || '') || /^checkpoint\./.test(event.type || '') && ['before', 'after'].includes(event.phase)).map(event => timeline.steps.findIndex(step => step.id === safeText(event.step, 100))).filter(index => index >= 0);
    const firstRetainedStep = retainedIndices.length ? Math.min(...retainedIndices) : timeline.steps.length;
    for (const [index, step] of timeline.steps.entries()) {
      if (index < firstRetainedStep && step.state === 'planned' && !actionHistory.has(step.id)) step.state = 'history_omitted';
    }
  }
  return timeline;
}
