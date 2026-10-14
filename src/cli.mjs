#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { startSandbox } from './sandbox.mjs';
import { BrowserSurface } from './surface.mjs';
import { Policy } from './policy.mjs';
import { Evidence, verifyLog } from './evidence.mjs';
import { Runner } from './engine.mjs';
import { OperatorConsole } from './operator.mjs';
import { ReviewServer } from './review.mjs';

export function parseArgs(argv) {
  const options={};
  for(let index=0;index<argv.length;index++) {
    const key=argv[index];if(!key.startsWith('--'))throw new Error('Options must start with --');
    if(['--headed','--auto-sandbox','--show-outputs'].includes(key)){options[key.slice(2)]=true;continue;}
    if(index+1>=argv.length||argv[index+1].startsWith('--'))throw new Error(`Missing value for ${key}`);
    options[key.slice(2)]=argv[++index];
  }
  return options;
}

export async function runCommand(command,options) {
  if(command==='review') {
    const viewer=new ReviewServer({directory:resolve(options['run-dir']||'evidence/discovery'),port:Number(options.port||4181)});
    await viewer.start();
    console.log(`Saved run timeline: http://127.0.0.1:${viewer.port}`);
    await new Promise(resolve=>{for(const event of ['SIGINT','SIGTERM'])process.once(event,resolve);});
    await viewer.close();return;
  }
  if(command==='sandbox') {
    const sandbox=await startSandbox({port:Number(options.port||4173)});
    console.log(`Relay sandbox: ${sandbox.baseUrl}/bank`);
    await new Promise(resolve=>{for(const event of ['SIGINT','SIGTERM'])process.once(event,resolve);});
    await sandbox.close();return;
  }
  if(command==='verify-evidence'){console.log(JSON.stringify(await verifyLog(resolve(options.log)),null,2));return;}
  if(!['discover','replay'].includes(command))throw new Error('Usage: node src/cli.mjs sandbox|discover|replay|review|verify-evidence [options]');
  const target=new URL(options.target||'http://127.0.0.1:4173/bank');
  const policy=new Policy({baseUrl:target.origin,...(options.policy?JSON.parse(await readFile(resolve(options.policy),'utf8')):{})});
  policy.assertUrl(target.href);
  const inputs=JSON.parse(options.inputs||'{"member_id":"12345"}');
  const evidence=new Evidence(resolve(options['run-dir']||`evidence/${command}`),Object.values(inputs).filter(v=>typeof v==='string'));
  await evidence.init();
  let sandbox,surface,model,operator;
  try {
    if(options['auto-sandbox'])sandbox=await startSandbox({port:Number(target.port||80)});
    surface=await BrowserSurface.launch({baseUrl:target.origin,headless:!options.headed,scenario:options.scenario||'normal'});
    await policy.protect(surface.context);
    if(options['operator-port'])operator=new OperatorConsole({port:Number(options['operator-port'])});
    const runner=new Runner({surface,policy,evidence,operator,checkpointTimeoutMs:Number(options['checkpoint-timeout']||4000)});
    let result;
    if(command==='discover') {
      const providers=await import('./model.mjs');
      if((options.provider||'openai')==='codex-bridge') {
        model=new providers.BridgeModel({port:Number(options['bridge-port']||4190),model:options.model||'Codex live session'});await model.start();
      }else if((options.provider||'openai')==='openai')model=new providers.OpenAIModel({model:options.model||process.env.OPENAI_MODEL||'gpt-4.1-mini'});
      else throw new Error('Supported providers: openai, codex-bridge');
      const artifactPath=resolve(options.artifact||'evidence/capability.json');await mkdir(dirname(artifactPath),{recursive:true});
      result=await runner.discover({goal:options.goal||'Look up member {{member_id}} and read their savings balance',inputs,entry:{path:target.pathname,frame:'Member workspace'},model,artifactPath,maxSteps:Number(options['max-steps']||16)});
    }else{
      const capability=JSON.parse(await readFile(resolve(options.artifact||'evidence/capability.json'),'utf8'));
      result=await runner.replay(capability,inputs);
    }
    const display={...result};if(!options['show-outputs']&&display.outputs)display.outputs=Object.fromEntries(Object.keys(display.outputs).map(k=>[k,'[REDACTED: use --show-outputs for synthetic demo values]']));
    console.log(JSON.stringify(display,null,2));
    if(!['success','business_outcome'].includes(result.status))process.exitCode=2;
    return result;
  }finally{await model?.close();await operator?.close();await surface?.close();await sandbox?.close();}
}

if(import.meta.url===new URL(process.argv[1],'file:').href) {
  runCommand(process.argv[2],parseArgs(process.argv.slice(3))).catch(error=>{
    // Avoid echoing provider/browser errors containing local secrets or page data.
    console.error(`Relay could not start: ${error.code||error.name||'ERROR'}. Check setup and command options.`);
    process.exitCode=1;
  });
}
