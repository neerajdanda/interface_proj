import {BrowserSurface,SurfaceError} from './surface.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {extractFrameObservation, redactObservationValue} from './observation-privacy.mjs';

// Development verification adapter for the desktop's hosted browser. The shipped
// adapter uses Playwright and network interception; this adapter uses CUA APIs.
export class ConnectedSurface extends BrowserSurface {
  constructor({tab,baseUrl,policy,scenario='normal'}) {
    super({browser:null,context:null,page:null,baseUrl,scenario});
    this.tab=tab;this.policy=policy;this.currentUrl=baseUrl+'/bank';
    this.page={url:()=>this.currentUrl,title:()=>this.tab.title()};
  }
  async navigate(url){this.policy.assertUrl(url);if(await this.tab.url()===url)await this.tab.reload();else await this.tab.goto(url);this.currentUrl=await this.tab.url();}
  async _frame(target){
    this.currentUrl=await this.tab.url();this.policy.assertUrl(this.currentUrl);
    if(!target?.frame)return this.tab.playwright;
    await this._collectObservationFrames();
    const matches=this._frameRefs.filter(frame=>frame.names.includes(target.frame));
    if(matches.length!==1)throw new SurfaceError(matches.length?'ambiguous_target':'target_not_found','Frame must be unique');
    return matches[0].api;
  }
  async _readControl(control){return control.evaluate(e=>['INPUT','TEXTAREA','SELECT'].includes(e.tagName)?e.value:e.innerText.trim());}
  async describeAction(action){
    if(action.target){const control=await this._resolve(action.target);const href=await control.getAttribute('href');if(href)this.policy.assertUrl(new URL(href,this.currentUrl).href);}
    return super.describeAction(action);
  }
  async act(action,inputs={}) {
    if(action.type==='wait'){await new Promise(resolve=>setTimeout(resolve,action.ms||100));return {performed:true,type:'wait'};}
    const control=await this._resolve(action.target);
    const value=action.value?.param?String(inputs[action.value.param]):String(action.value??'');
    if(action.type==='click')await control.click();
    else if(action.type==='fill')await control.fill(value);
    else if(action.type==='select')await control.selectOption({label:value});
    else throw new SurfaceError('invalid_action','Unsupported action');
    this.currentUrl=await this.tab.url();this.policy.assertUrl(this.currentUrl);
    // Refresh visible state after every interaction through the documented API.
    await this.tab.getAXState({emit:false});
    return {performed:true,type:action.type};
  }
  async _collectObservationFrames(){
    this.currentUrl=await this.tab.url();this.policy.assertUrl(this.currentUrl);
    const frames=[],references=[];
    const collect=async(api,name,names=[])=>{
      if(frames.length>=8)throw new SurfaceError('observation_limit','Too many frames for a bounded observation.');
      const data=await api.locator('body').evaluate(extractFrameObservation);
      frames.push({...data,...(name?{name}:{})});
      if(name)references.push({api,names});
      for(const child of data.childFrames){
        if(child.src)this.policy.assertUrl(new URL(child.src,data.url||this.currentUrl).href);
        const attribute=child.title?'title':child.name?'name':null;
        if(!attribute)throw new SurfaceError('observation_limit','An embedded frame needs a semantic title or name for safe observation.');
        const selector='iframe['+attribute+'='+JSON.stringify(child[attribute])+']';
        if(await api.locator(selector).count()!==1)throw new SurfaceError('ambiguous_target','Embedded frame must be unique');
        await collect(api.frameLocator(selector),child.title||child.name,[child.title,child.name].filter(Boolean));
      }
    };
    await collect(this.tab.playwright);
    this._frameRefs=references;
    return frames;
  }
  async evidence(path){
    await mkdir(dirname(path),{recursive:true});
    const snapshot=path+'.json';
    const observation=await this.observe();
    const dom=redactObservationValue(await this.tab.playwright.domSnapshot(),[...this._privacyValues]);
    await writeFile(snapshot,JSON.stringify({observation,redactedDom:dom},null,2),{mode:0o600});
    return {snapshot};
  }
  async screenshot(){throw new SurfaceError('preview_unavailable','Hosted verification uses structural redacted evidence; use the standalone Playwright adapter for masked live previews.');}
  async attachHumanRecorder(callback){this._humanCallback=callback;}
  async close(){}
}
