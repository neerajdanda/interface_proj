import { readFile } from 'node:fs/promises';
import { ConnectedSurface } from '../src/connected-surface.mjs';
import { Policy } from '../src/policy.mjs';
import { Evidence } from '../src/evidence.mjs';
import { Runner, DiscoverySession, safeAct } from '../src/engine.mjs';

/** Pass a documented CUA Tab handle. Call request(), let a real model infer the
 * next decision, then call apply(decision) in the next active tool invocation. */
export async function beginHostedDiscovery({tab,baseUrl,runDir,artifactPath,inputs,goal,modelName}) {
  const policy=new Policy({baseUrl});
  const surface=new ConnectedSurface({tab,baseUrl,policy});
  const evidence=new Evidence(runDir,Object.values(inputs));await evidence.init();
  const runner=new Runner({surface,policy,evidence});
  const session=new DiscoverySession(runner,{goal,inputs,entry:{path:'/bank',frame:'Member workspace'},model:{mode:'codex-bridge',model:modelName},artifactPath});
  await session.initialize();
  return {session,runner,surface,evidence};
}

/** A deterministic replay on a live hosted browser. Optional operator is
 * transparently simulated; its UI action and the control transfers are real. */
export async function runHostedReplay({tab,baseUrl,runDir,artifactPath,inputs,scenario='normal',simulateOperator=false}) {
  const policy=new Policy({baseUrl});
  const surface=new ConnectedSurface({tab,baseUrl,policy,scenario});
  const evidence=new Evidence(runDir,Object.values(inputs));await evidence.init();
  const operator=simulateOperator?{
    async start(){},
    async onIntervention(runner){
      await runner.ownership.claim();
      const name=scenario==='session_expired'?'Restore session':'Operator unlock';
      const action={type:'click',target:{frame:'Member workspace',strategies:[{kind:'role',role:'button',name}]}};
      await safeAct(surface,policy,runner.ownership,action,{},'reversible','human');
      await evidence.event('human.action',{actor:'simulated operator test actor',action,sessionId:runner.ownership.sessionId,epoch:runner.ownership.epoch});
      await runner.ownership.resume();
    }
  }:null;
  const capability=JSON.parse(await readFile(artifactPath,'utf8'));
  return new Runner({surface,policy,evidence,operator}).replay(capability,inputs);
}
