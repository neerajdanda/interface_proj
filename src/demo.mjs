import { readFile } from 'node:fs/promises';
import { startSandbox } from './sandbox.mjs';
import { BrowserSurface } from './surface.mjs';
import { Policy } from './policy.mjs';
import { Evidence } from './evidence.mjs';
import { Runner, safeAct } from './engine.mjs';

// This exercises the saved capability on real UIs. It never simulates discovery.
const capability=JSON.parse(await readFile(new URL('../evidence/capability.json',import.meta.url),'utf8'));
const sandbox=await startSandbox({port:0});
const rows=[];
try {
  for(const scenario of ['normal','not_found','validation','slow','interstitial','permission','app_error','ambiguous','session_expired']) {
    const surface=await BrowserSurface.launch({baseUrl:sandbox.baseUrl,scenario});
    const policy=new Policy({baseUrl:sandbox.baseUrl});await policy.protect(surface.context);
    const evidence=new Evidence(new URL(`../work/demo/${scenario}/`,import.meta.url).pathname,['67890']);await evidence.init();
    const operator=scenario==='session_expired'?{
      async start(){},
      async onIntervention(runner){
        await runner.ownership.claim();
        const action={type:'click',target:{frame:'Member workspace',strategies:[{kind:'role',role:'button',name:'Restore session'}]}};
        await safeAct(surface,policy,runner.ownership,action,{},'reversible','human');
        await evidence.event('human.action',{actor:'simulated operator test actor',action,sessionId:runner.ownership.sessionId,epoch:runner.ownership.epoch});
        await runner.ownership.resume();
      }
    }:null;
    try {
      const result=await new Runner({surface,policy,evidence,operator}).replay(capability,{member_id:'67890'});
      const expected={normal:'success',not_found:'business_outcome',validation:'business_outcome',slow:'success',interstitial:'success',permission:'intervention_required',app_error:'intervention_required',ambiguous:'intervention_required',session_expired:'success'}[scenario];
      if(result.status!==expected||result.modelCalls!==0)throw new Error(`Unexpected result for ${scenario}`);
      if(result.status==='success'&&result.outputs.savings_balance.minorUnits!==812500)throw new Error('Incorrect output');
      rows.push({scenario,status:result.status,code:result.code,modelCalls:0,handoffs:result.handoffs||0});
    }finally{await surface.close();}
  }
  console.table(rows);
  console.log('All replay scenarios verified. The handoff uses an explicit test actor; run the README operator command for a person.');
}finally{await sandbox.close();}
