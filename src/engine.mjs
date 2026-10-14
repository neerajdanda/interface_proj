import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateCapability, validateInputs, validateDecision, extractMoney } from './contract.mjs';
import { Ownership } from './ownership.mjs';
import { scrub } from './policy.mjs';

const frame='Member workspace';
export const textCondition=text=>({target:{frame,strategies:[{kind:'text',text}]},op:'visible'});
export const sandboxOutcomes=[{code:'MEMBER_NOT_FOUND',when:textCondition('Member not found')},{code:'VALIDATION_ERROR',when:textCondition('Validation error')}];
export const sandboxRecoveries=[{code:'SERVICE_NOTICE',when:textCondition('Service notice'),action:{type:'click',target:{frame,strategies:[{kind:'role',role:'button',name:'Continue'}]}},maxAttempts:1}];
const hardSignals=[['PERMISSION_DENIED','Permission denied'],['SESSION_EXPIRED','Session expired'],['APPLICATION_ERROR','Application error'],['UNEXPECTED_DIALOG','Supervisor approval required']];

class Stop extends Error {
  constructor(status,code,details={}) {super(code);this.status=status;this.code=code;this.details=details;}
}

/** Only policy-checked, leased actions pass this boundary. */
export async function safeAct(surface,policy,ownership,action,inputs,effect='read',owner='automation') {
  const ticket=ownership.ticket();
  ownership.assert(ticket,owner);
  policy.assertUrl(surface.page.url());
  policy.assertAction(action,{effect,owner});
  const canonical=surface.describeAction ? await surface.describeAction(action) : action;
  policy.assertAction(canonical,{effect,owner});
  return ownership.execute(ticket,owner,()=>surface.act(action,inputs));
}

export class Runner {
  constructor({surface,policy,evidence,operator=null,checkpointTimeoutMs=4000,handoffTimeoutMs=120000}) {
    if(!Number.isSafeInteger(checkpointTimeoutMs)||checkpointTimeoutMs<1||checkpointTimeoutMs>30000||!Number.isSafeInteger(handoffTimeoutMs)||handoffTimeoutMs<1||handoffTimeoutMs>600000)throw new Error('Runner deadlines must be bounded positive milliseconds');
    Object.assign(this,{surface,policy,evidence,operator,checkpointTimeoutMs,handoffTimeoutMs});
    this.ownership=new Ownership(evidence);this.recoveryCounts=new Map();
    this.currentStep=null;this.currentPhase=null;this.handoffs=0;
    this.recorderReady=this.surface.attachHumanRecorder?.(event=>{
      if(this.ownership.owner==='human')void this.evidence.event('human.browser_action',{...event,sessionId:this.ownership.sessionId,epoch:this.ownership.epoch});
    });
  }
  async guard(capability) {
    this.policy.assertUrl(this.surface.page.url());
    for(const outcome of capability.outcomes||[]) {
      if(await this.surface.check(outcome.when,this.inputs))throw new Stop('business_outcome',outcome.code);
    }
    for(const recovery of capability.recoveries||[]) {
      if(await this.surface.check(recovery.when,this.inputs)) {
        const count=this.recoveryCounts.get(recovery.code)||0;
        if(count>=recovery.maxAttempts)throw new Stop('failure','RECOVERY_EXHAUSTED',{condition:recovery.code});
        this.recoveryCounts.set(recovery.code,count+1);
        await this.evidence.event('recovery.applied',{code:recovery.code,attempt:count+1,step:this.currentStep});
        await safeAct(this.surface,this.policy,this.ownership,recovery.action,this.inputs,'reversible');
      }
    }
    for(const [code,text] of hardSignals) {
      if(await this.surface.check(textCondition(text),this.inputs))return code;
    }
    return null;
  }
  async intervene(code,expected) {
    if(this.handoffs>=2)throw new Stop('failure','HANDOFF_LIMIT');
    this.handoffs++;
    const observed=await this.surface.observe();
    await this.evidence.snapshot(this.surface,`intervention-${this.handoffs}`);
    await this.ownership.pause({code,capability:this.capabilityId,step:this.currentStep,phase:this.currentPhase,expected,observed});
    if(!this.operator)throw new Stop('intervention_required',code,{intervention:this.ownership.pending});
    this.operator.runner=this;
    // A console normally waits for a person; a test actor can exercise the same
    // live-session ownership protocol through this explicit, documented seam.
    await this.operator.onIntervention?.(this);
    await this.ownership.waitForResume(this.handoffTimeoutMs);
    // The caller rechecks its precise checkpoint; no completed action is repeated.
    await this.evidence.event('checkpoint.revalidate',{step:this.currentStep,phase:this.currentPhase,sessionId:this.ownership.sessionId});
  }
  async ensure(conditions,capability,phase) {
    this.currentPhase=phase;
    this.expectedConditions=conditions;
    await this.evidence.event('checkpoint.started',{step:this.currentStep,phase,expected:conditions});
    let deadline=Date.now()+this.checkpointTimeoutMs;
    for(;;) {
      const code=await this.guard(capability);
      if(code) {await this.intervene(code,conditions);deadline=Date.now()+this.checkpointTimeoutMs;continue;}
      let okay=true;
      for(const condition of conditions)if(!await this.surface.check(condition,this.inputs)){okay=false;break;}
      if(okay){await this.evidence.event('checkpoint.passed',{step:this.currentStep,phase,expected:conditions});return;}
      if(Date.now()>=deadline) {
        if(this.operator){await this.intervene('CHECKPOINT_TIMEOUT',conditions);deadline=Date.now()+this.checkpointTimeoutMs;continue;}
        throw new Stop('failure','CHECKPOINT_TIMEOUT',{expected:conditions});
      }
      await new Promise(resolve=>setTimeout(resolve,80));
    }
  }
  async start(entry,inputs,capabilityId) {
    this.inputs=inputs;this.capabilityId=capabilityId;
    await this.recorderReady;
    if(this.operator){this.operator.runner=this;await this.operator.start();}
    const url=new URL(entry.path,this.policy.baseUrl);
    // Scenario is test configuration, never a route learned by the model.
    if(this.surface.scenario&&this.surface.scenario!=='normal')url.searchParams.set('scenario',this.surface.scenario);
    this.policy.assertUrl(url.href);
    this.policy.assertAction({type:'navigate'});
    await this.ownership.execute(this.ownership.ticket(),'automation',()=>this.surface.navigate(url.href));
  }
  async outputs(capability) {
    const outputs={};
    for(const [key,output] of Object.entries(capability.outputs)) {
      this.policy.assertUrl(this.surface.page.url());
      this.policy.assertAction({type:'read',target:output.target});
      const value=await this.ownership.execute(this.ownership.ticket(),'automation',()=>this.surface.read(output.target));
      outputs[key]=output.type==='money'?extractMoney(value):value;
    }
    return outputs;
  }
  async failure(error,modelCalls=0) {
    const observed=await this.surface.observe().catch(()=>({state:'unavailable'}));
    await this.evidence.snapshot(this.surface,'failure').catch(()=>{});
    const result={status:error.status||'failure',code:error.code||'EXECUTION_ERROR',step:this.currentStep,phase:this.currentPhase,expected:error.details?.expected||this.expectedConditions||null,observed,sessionId:this.ownership.sessionId,modelCalls,...error.details};
    await this.evidence.event('run.stopped',{status:result.status,code:result.code,step:result.step,phase:result.phase,modelCalls,handoffs:this.handoffs});
    return this.evidence.result(result);
  }
  async replay(capability,inputs) {
    try {
      validateCapability(capability);validateInputs(capability,inputs);
      await this.evidence.event('run.started',{mode:'replay',capability:capability.id,goal:capability.name,modelCalls:0,plan:capability.steps.map(step=>{const target=step.action.target?.strategies?.[0];return {id:step.id,actionType:step.action.type,title:step.action.type==='wait'?'Wait for the page':`${step.action.type} ${target?.name||target?.label||target?.text||'control'}`};})});
      await this.start(capability.entry,inputs,capability.id);
      for(const step of capability.steps) {
        this.currentStep=step.id;
        await this.ensure(step.before,capability,'before');
        await this.evidence.event('action.started',{step:step.id,action:step.action,effect:step.effect,reason:'Execute recorded capability step'});
        this.currentPhase='action';
        try {await safeAct(this.surface,this.policy,this.ownership,step.action,inputs,step.effect);}
        catch(error) {
          if(!['ambiguous_target','target_not_found'].includes(error.code))throw error;
          // These errors occur during targeting, before dispatch. Human changes
          // the live UI; only then may the original action be resolved again.
          await this.intervene(error.code,step.before);
          await this.ensure(step.before,capability,'before');
          this.currentPhase='action';
          await safeAct(this.surface,this.policy,this.ownership,step.action,inputs,step.effect);
        }
        await this.evidence.event('action.completed',{step:step.id,action:step.action});
        await this.ensure(step.after,capability,'after');
      }
      this.currentStep='success';
      await this.ensure(capability.success,capability,'success');
      const outputs=await this.outputs(capability);
      await this.evidence.snapshot(this.surface,'success');
      const result={status:'success',code:'GOAL_VERIFIED',outputs,sessionId:this.ownership.sessionId,modelCalls:0,handoffs:this.handoffs};
      await this.evidence.event('run.completed',{status:'success',modelCalls:0,handoffs:this.handoffs,outputNames:Object.keys(outputs)});
      return this.evidence.result(result);
    }catch(error){return this.failure(error);}
  }
  async discover(options) {
    const session=new DiscoverySession(this,options);
    try {
      await session.initialize();
      for(;;) {
        const request=await session.request();
        const decision=await options.model.decide(request);
        const result=await session.apply(decision);
        if(result)return result;
      }
    }catch(error){return this.failure(error,session.calls);}
  }
}

/** Incremental discovery also supports a hosted computer-use client whose UI
 * operations must execute in the current tool call. Same compiler and guards. */
export class DiscoverySession {
  constructor(runner,{goal,inputs,entry,model,artifactPath,maxSteps=16,timeoutMs=600000}) {
    if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>64||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Discovery limits must be bounded positive integers');
    Object.assign(this,{runner,goal,inputs,entry,model,artifactPath,maxSteps,timeoutMs});
    this.steps=[];this.history=[];this.calls=0;this.repeats=0;this.previousObservation='';
    this.envelope={outcomes:sandboxOutcomes,recoveries:sandboxRecoveries};
  }
  async initialize() {
    if(!this.goal.includes('{{member_id}}'))throw new Stop('failure','GOAL_MUST_USE_PARAMETER',{expected:'Use {{member_id}} in the goal, never a sensitive literal'});
    validateInputs({inputs:{member_id:{type:'string'}}},this.inputs);
    await this.runner.evidence.event('run.started',{mode:'discovery',goal:this.goal,provenance:{mode:this.model.mode,model:this.model.model}});
    await this.runner.start(this.entry,this.inputs,'discover-member-savings');
    this.deadline=Date.now()+this.timeoutMs;
  }
  async request() {
    const r=this.runner;
    if(this.calls>=this.maxSteps||Date.now()>=this.deadline) {
      const code=this.calls>=this.maxSteps?'MAX_STEPS':'DISCOVERY_TIMEOUT';
      await r.intervene(code,[]);throw new Stop('intervention_required',code);
    }
    r.currentStep=`step-${this.calls+1}`;
    const issue=await r.guard(this.envelope);if(issue)await r.intervene(issue,[]);
    const observation=await r.surface.observe();
    const fingerprint=JSON.stringify(observation);
    this.repeats=fingerprint===this.previousObservation?this.repeats+1:0;this.previousObservation=fingerprint;
    if(this.repeats>=3){await r.intervene('DISCOVERY_DEAD_END',[]);this.repeats=0;}
    await r.evidence.event('model.observed',{step:r.currentStep,observation});
    this.calls++;
    return {goal:this.goal,inputContract:{member_id:{type:'string',sensitive:true}},observation,history:this.history};
  }
  async apply(rawDecision) {
    const r=this.runner;
    if(this.complete)throw new Stop('failure','DISCOVERY_ALREADY_COMPLETE');
    if(Date.now()>=this.deadline){await r.intervene('DISCOVERY_TIMEOUT',[]);throw new Stop('intervention_required','DISCOVERY_TIMEOUT');}
    const decision=validateDecision(rawDecision);
    await r.evidence.event('model.decided',{step:r.currentStep,decision});
    if(decision.kind==='escalate'){await r.intervene('MODEL_ESCALATION',[]);return null;}
    if(decision.kind==='finish') {
      if(this.steps.length<2)throw new Stop('failure','INSUFFICIENT_DISCOVERY');
      await r.ensure(decision.success,this.envelope,'success');
      // Identity is part of the calling contract, independent of a model's claim.
      const identity=decision.success.some(c=>c.op==='text_equals'&&c.value?.param==='member_id'&&c.target.strategies.some(s=>s.kind==='row'&&s.label==='Member ID'&&s.control==='text'));
      if(!identity)throw new Stop('failure','MISSING_IDENTITY_CHECKPOINT');
      const capability={schemaVersion:'1.0.0',id:'member-savings.lookup',name:'Member savings lookup',description:'Search for a member and return the verified savings balance through the legacy UI.',vendor:{product:'Relay Ledger',version:'1'},entry:this.entry,inputs:{member_id:{type:'string',pattern:'^[0-9]{5}$',sensitive:true}},outputs:decision.outputs,steps:this.steps,success:decision.success,outcomes:sandboxOutcomes,recoveries:sandboxRecoveries,review:{state:'draft'},provenance:{mode:this.model.mode,model:this.model.model}};
      validateCapability(capability);validateInputs(capability,this.inputs);
      const serialized=JSON.stringify(capability,null,2)+'\n';
      for(const value of Object.values(this.inputs))if(serialized.includes(String(value)))throw new Stop('failure','SENSITIVE_LITERAL_IN_ARTIFACT');
      const outputs=await r.outputs(capability);
      await writeFile(this.artifactPath,serialized);
      await r.evidence.event('capability.recorded',{capability:capability.id,steps:this.steps.length,sha256:createHash('sha256').update(serialized).digest('hex'),provenance:capability.provenance});
      await r.evidence.snapshot(r.surface,'success');
      this.complete=true;
      await r.evidence.event('run.completed',{status:'success',code:'GOAL_VERIFIED',modelCalls:this.calls,handoffs:r.handoffs,outputNames:Object.keys(outputs)});
      return r.evidence.result({status:'success',code:'GOAL_VERIFIED',outputs,sessionId:r.ownership.sessionId,modelCalls:this.calls,handoffs:r.handoffs,artifact:this.artifactPath});
    }
    if(!decision.before?.length)throw new Stop('failure','MISSING_PRECONDITION');
    const step={id:r.currentStep,action:decision.action,before:decision.before,after:decision.after||[],effect:['fill','select'].includes(decision.action.type)?'reversible':'read',retry:{maxAttempts:1}};
    await r.ensure(step.before,this.envelope,'before');
    await r.evidence.event('action.started',{step:step.id,action:step.action,effect:step.effect,reason:'Execute a validated model decision'});
    await safeAct(r.surface,r.policy,r.ownership,step.action,this.inputs,step.effect);
    await r.evidence.event('action.completed',{step:step.id,action:step.action});
    await r.ensure(step.after,this.envelope,'after');
    this.steps.push(step);this.history.push(scrub({step:step.id,action:step.action,checkpoint:step.after},Object.values(this.inputs)));
    return null;
  }
}
