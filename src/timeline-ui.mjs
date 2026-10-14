// Static markup and a dependency-free renderer can be shared by the live
// operator console and the read-only evidence viewer.
export const timelineMarkup = '<div class="relay-timeline-mount" aria-label="Run timeline"></div>';

export const timelineCss = `
.relay-timeline{--relay-ink:#173229;--relay-muted:#69786f;--relay-line:#dce5df;background:#fbfdfb;color:var(--relay-ink);border:1px solid var(--relay-line);border-radius:16px;padding:26px;font:14px/1.5 system-ui,-apple-system,sans-serif;margin:24px 0}
.relay-badge[data-state=evidence_conflict]{background:#ffe8e1;color:#993e28}
.relay-timeline *{box-sizing:border-box}.relay-timeline h2{font-size:25px;line-height:1.25;letter-spacing:-.7px;margin:8px 0 22px;max-width:850px}.relay-timeline h3{font-size:15px;margin:24px 0 12px}.relay-topline{display:flex;justify-content:space-between;align-items:center;gap:16px}.relay-eyebrow{font-size:10px;letter-spacing:1.5px;font-weight:750;text-transform:uppercase;color:var(--relay-muted)}.relay-badge{font-size:11px;font-weight:700;padding:5px 10px;border-radius:30px;background:#e8eee9;white-space:nowrap}.relay-badge[data-state=success],.relay-badge[data-state=completed],.relay-badge[data-state=verified],.relay-check[data-state=passed]{background:#def2e6;color:#176541}.relay-badge[data-state=paused],.relay-badge[data-state=operator_control],.relay-badge[data-state=intervention_required]{background:#fff0d7;color:#89580d}.relay-badge[data-state=failure]{background:#ffe8e1;color:#993e28}.relay-metrics{display:grid;grid-template-columns:100px 1fr 1fr;gap:16px;border-top:1px solid var(--relay-line);border-bottom:1px solid var(--relay-line);padding:17px 0}.relay-metric-label{font-size:11px;color:var(--relay-muted);margin-bottom:4px}.relay-metric-value{font-size:15px;font-weight:650}.relay-metric:first-child .relay-metric-value{font-size:27px;line-height:1.1}.relay-note{font-size:12px;color:var(--relay-muted);margin:14px 0 0}.relay-pause{background:#fff6e5;border-left:3px solid #cd922b;padding:12px 15px;margin:16px 0 0;border-radius:4px;font-size:13px}.relay-columns{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(320px,1.15fr);gap:28px}.relay-steps,.relay-events{list-style:none;margin:0;padding:0}.relay-step{padding:13px 0;border-bottom:1px solid var(--relay-line)}.relay-step-title{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:650}.relay-step-name{display:flex;align-items:center;gap:9px}.relay-step-number{font-size:10px;font-weight:700;color:var(--relay-muted);min-width:21px}.relay-checks{display:flex;gap:6px;flex-wrap:wrap;padding-left:30px;margin-top:8px}.relay-check{font-size:10px;background:#edf1ee;color:#596b60;border-radius:4px;padding:3px 6px}.relay-events{max-height:510px;overflow:auto;padding-right:8px}.relay-event{position:relative;border-left:1px solid var(--relay-line);padding:0 0 19px 18px;margin-left:5px}.relay-event:before{content:'';position:absolute;left:-4px;top:6px;width:7px;height:7px;background:#83a091;border-radius:50%}.relay-event[data-kind=pause]:before,.relay-event[data-kind=human]:before{background:#cd922b}.relay-event[data-kind=proposal]:before{background:#98a7b4}.relay-event-title{font-size:12px;font-weight:650}.relay-event-detail{font-size:11px;color:var(--relay-muted);margin-top:3px}.relay-event-time{font:10px ui-monospace,monospace;color:#87938b;float:right;margin-left:12px}.relay-details{font-size:11px;color:var(--relay-muted);margin-top:18px}.relay-details summary{cursor:pointer}.relay-details p{margin:8px 0;overflow-wrap:anywhere}.relay-empty{font-size:12px;color:var(--relay-muted);padding:13px 0}.relay-viewer{margin:0;background:#eff3ef;color:#173229;font:14px system-ui}.relay-viewer-header{background:#173229;color:#fff;padding:22px max(24px,calc((100vw - 1200px)/2));display:flex;justify-content:space-between;align-items:center;gap:20px}.relay-viewer-logo{font-size:25px;font-weight:750;letter-spacing:-1px}.relay-viewer-logo span{color:#9ce4b9}.relay-viewer-main{max-width:1200px;margin:26px auto;padding:0 24px}.relay-viewer-subtitle{color:#64776b;font-size:13px}.relay-viewer-integrity{font-size:12px;color:#64776b}.relay-viewer-error{color:#a3432a;font-size:12px}@media(max-width:760px){.relay-timeline{padding:20px}.relay-columns{grid-template-columns:1fr;gap:0}.relay-metrics{grid-template-columns:80px 1fr}.relay-metric:last-child{grid-column:1/-1}.relay-timeline h2{font-size:21px}.relay-viewer-header{align-items:flex-start;flex-direction:column}}
`;

function renderRelayTimeline(element, snapshot = {}) {
  const mount = element.matches?.('.relay-timeline-mount') ? element : element.querySelector('.relay-timeline-mount') || element;
  const doc = element.ownerDocument;
  const previous = mount.querySelector('.relay-details');
  const detailsOpen = previous?.open || false;
  const scroll = mount.querySelector('.relay-events')?.scrollTop || 0;
  const statuses = { running: 'In progress', paused: 'Paused', operator_control: 'Operator in control', success: 'Goal verified', failure: 'Stopped', business_outcome: 'Application outcome', intervention_required: 'Needs operator', empty: 'No events recorded', planned: 'Planned', proposed: 'Proposed', started: 'Started', completed: 'Completed', verified: 'Checkpoint verified', evidence_conflict: 'Evidence conflict', stale: 'Connection lost · stale events', legacy_success: 'Earlier recording · reported success', history_omitted: 'Earlier events omitted' };
  const owners = { automation: 'Automation', human: 'Operator', paused: 'Waiting for operator', unknown: 'Not recorded' };
  const phases = { before: 'Before action', after: 'After action', action: 'Application action', success: 'Goal verification' };
  const checkpoints = { not_recorded: 'not recorded', checking: 'checking', passed: 'passed', empty: 'no conditions' };
  function node(tag, className, text) {
    const value = doc.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined && text !== null) value.textContent = String(text);
    return value;
  }
  function badge(state) {
    const value = node('span', 'relay-badge', statuses[state] || 'Not recorded');
    value.dataset.state = Object.hasOwn(statuses, state) ? state : 'unknown';
    return value;
  }
  const section = node('section', 'relay-timeline');
  const top = node('div', 'relay-topline');
  top.append(node('div', 'relay-eyebrow', `Actual run / ${snapshot.mode === 'discovery' ? 'Discovery' : snapshot.mode === 'replay' ? 'Deterministic replay' : 'Recorded events'}`), badge(snapshot.status));
  const displayedGoal = typeof snapshot.goal === 'string' ? snapshot.goal.replace(/^Look up member \{\{member_id\}\}/i, 'Look up a member') : 'Run goal not recorded';
  section.append(top, node('h2', '', displayedGoal || 'Run goal not recorded'));
  const metrics = node('div', 'relay-metrics');
  const current = (snapshot.steps || []).find(step => step.id === snapshot.currentStep);
  const lastItem = Array.isArray(snapshot.items) ? snapshot.items.at(-1) : null;
  const savedCapability = lastItem?.kind === 'artifact';
  const finalVerification = snapshot.currentStep === 'success' || snapshot.currentPhase === 'success';
  const location = savedCapability ? 'Capability saved' : finalVerification ? 'Goal verification' : current?.title || (snapshot.status === 'empty' ? 'Waiting for a run' : 'Recorded boundary');
  const modelCalls = Number.isSafeInteger(snapshot.modelCalls) && snapshot.modelCalls >= 0 ? snapshot.modelCalls : 'Not recorded';
  for (const [label, value] of [['Model calls', modelCalls], ['Current position', `${location}${phases[snapshot.currentPhase] && !finalVerification && !savedCapability ? ` · ${phases[snapshot.currentPhase]}` : ''}`], ['Session control', owners[snapshot.owner] || owners.unknown]]) {
    const metric = node('div', 'relay-metric');
    metric.append(node('div', 'relay-metric-label', label), node('div', 'relay-metric-value', value));
    metrics.append(metric);
  }
  section.append(metrics);
  if (snapshot.pauseReason) section.append(node('div', 'relay-pause', snapshot.pauseReason));
  if (snapshot.operatorTestActor) section.append(node('p', 'relay-note', 'Operator handoff in this run used an explicitly simulated or automated test actor. No human participant is implied.'));
  if (snapshot.historyTruncated) section.append(node('p', 'relay-note', 'Earlier events are omitted from this view. Unrecorded older steps are not shown as completed or pending.'));
  section.append(node('p', 'relay-note', snapshot.checkpointTelemetryAvailable ? 'Only explicitly recorded checkpoint checks appear below. “No conditions” marks an empty boundary.' : 'Checkpoint telemetry was not recorded for this run. Action records do not imply a passed checkpoint.'));
  const columns = node('div', 'relay-columns');
  const left = node('div'); left.append(node('h3', '', 'Recorded steps'));
  const steps = node('ol', 'relay-steps');
  for (const [index, step] of (Array.isArray(snapshot.steps) ? snapshot.steps : []).entries()) {
    const row = node('li', 'relay-step');
    const title = node('div', 'relay-step-title');
    const name = node('div', 'relay-step-name');
    name.append(node('span', 'relay-step-number', String(index + 1).padStart(2, '0')), node('span', '', step.title || `Step ${index + 1}`));
    title.append(name, badge(step.state)); row.append(title);
    const checks = node('div', 'relay-checks');
    for (const checkpoint of ['before', 'after']) {
      const state = step.checkpoints?.[checkpoint] || 'not_recorded';
      const chip = node('span', 'relay-check', `${checkpoint === 'before' ? 'Before' : 'After'} · ${checkpoints[state] || 'not recorded'}`);
      chip.dataset.state = Object.hasOwn(checkpoints, state) ? state : 'not_recorded'; checks.append(chip);
    }
    row.append(checks); steps.append(row);
  }
  if (!steps.children.length) left.append(node('p', 'relay-empty', 'No application steps recorded yet.'));
  left.append(steps);
  const right = node('div'); right.append(node('h3', '', 'What happened'));
  const events = node('ol', 'relay-events');
  for (const item of Array.isArray(snapshot.items) ? snapshot.items : []) {
    const row = node('li', 'relay-event');
    row.dataset.kind = ['run', 'model', 'proposal', 'action', 'checkpoint', 'pause', 'control', 'human', 'test', 'recovery', 'artifact', 'success', 'stop'].includes(item.kind) ? item.kind : 'run';
    if (typeof item.time === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(item.time)) {
      const date = new Date(item.time);
      if (!Number.isNaN(date.getTime())) row.append(node('time', 'relay-event-time', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    }
    row.append(node('div', 'relay-event-title', item.title || 'Recorded event'));
    if (item.detail) row.append(node('div', 'relay-event-detail', item.detail));
    events.append(row);
  }
  if (!events.children.length) right.append(node('p', 'relay-empty', 'The timeline will populate from actual run events.'));
  right.append(events); columns.append(left, right); section.append(columns);
  const details = node('details', 'relay-details'); details.open = detailsOpen;
  details.append(node('summary', '', 'Recording details'), node('p', '', `Capability: ${snapshot.capability || 'not recorded'}`), node('p', '', `Current step: ${snapshot.currentStep || 'not recorded'} · phase: ${snapshot.currentPhase || 'not recorded'}`), node('p', '', 'Model proposals, dispatched actions and checkpoint results are separate records. Private inputs, page observations and financial outputs are omitted.'));
  section.append(details); mount.replaceChildren(section); events.scrollTop = scroll;
}

export const timelineScript = `globalThis.renderRelayTimeline = ${renderRelayTimeline.toString()};`;

function applyRelayReviewState(mount, state) {
  const doc = mount.ownerDocument;
  let snapshot = state.timeline || state;
  if (state.result?.state === 'legacy' && state.result.reported?.status === 'success' && snapshot.status === 'running') snapshot = { ...snapshot, status: 'legacy_success' };
  globalThis.renderRelayTimeline(mount, snapshot);
  const integrity = doc.getElementById('integrity');
  integrity.textContent = state.integrity?.state === 'verified' ? 'Verified saved event log · Read-only' : state.integrity?.message || '';
  const report = doc.getElementById('reported-result');
  const labels = { success: 'Success', failure: 'Failure', business_outcome: 'Application outcome', intervention_required: 'Operator assistance required' };
  const label = labels[state.result?.reported?.status];
  const finalStatusMissing = !['completed', 'stopped'].includes(state.integrity?.runState);
  report.textContent = state.result?.state === 'legacy' && label ? `Earlier recording: saved result reports ${label}${finalStatusMissing ? '; the final status event was not recorded.' : '; its run identity is not bound to the event log.'}` : state.result?.state === 'mismatch' || state.result?.state === 'invalid' ? state.result.message || '' : '';
  doc.getElementById('timeline-error').textContent = state.integrity?.state === 'invalid' ? 'Saved events were cleared because their integrity check failed.' : '';
  return snapshot;
}

function htmlText(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function scriptData(value) { return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`); }

/** A local GET-only viewer. The snapshot must come from buildTimeline. */
export function renderTimelineHtml(snapshot, { title = 'Relay | Run timeline', subtitle = 'Actual events · private values omitted', stateUrl = null, saved = false, pollInterval = 1200 } = {}) {
  if (stateUrl !== null && (typeof stateUrl !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(stateUrl) || stateUrl.startsWith('//'))) throw new TypeError('stateUrl must be a local absolute path');
  if (!Number.isSafeInteger(pollInterval) || pollInterval < 500 || pollInterval > 60000) throw new TypeError('pollInterval must be between 500 and 60000 milliseconds');
  const initial = scriptData(snapshot || {});
  const polling = stateUrl ? `const applyRelayReviewState=${applyRelayReviewState.toString()};let timelineUpdating=false;let lastTimeline=${initial};async function updateTimeline(){if(timelineUpdating)return;timelineUpdating=true;try{const response=await fetch(${scriptData(stateUrl)},{cache:'no-store'});const state=await response.json();if(!state.timeline&&!response.ok)throw Error('Run evidence is unavailable.');lastTimeline=applyRelayReviewState(mount,state);}catch(error){renderRelayTimeline(mount,{...lastTimeline,status:'stale'});document.getElementById('timeline-error').textContent='Connection lost. Previously loaded events are stale until the saved run can be refreshed.';}finally{timelineUpdating=false;}}updateTimeline();setInterval(updateTimeline,${pollInterval});` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlText(title)}</title><style>${timelineCss}</style></head><body class="relay-viewer"><header class="relay-viewer-header"><div class="relay-viewer-logo">↗ relay<span>.</span></div><div>${saved ? 'Saved run · read-only' : 'Run timeline'}</div></header><main class="relay-viewer-main"><p class="relay-viewer-subtitle">${htmlText(subtitle)}</p>${timelineMarkup}<p class="relay-viewer-integrity" id="integrity"></p><p class="relay-viewer-integrity" id="reported-result"></p><p class="relay-viewer-error" id="timeline-error" role="status"></p></main><script>${timelineScript}\nconst mount=document.querySelector('.relay-timeline-mount');renderRelayTimeline(mount,${initial});${polling}</script></body></html>`;
}
