import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const site = path.resolve(import.meta.dirname, '../source');
const root = process.env.SITE_QA_ROOT || path.resolve(import.meta.dirname, fs.existsSync(path.join(site,'dist')) ? '../source/dist' : '../published/dist');
const output = path.join(import.meta.dirname, 'english');fs.mkdirSync(output,{recursive:true});
const read = n => JSON.parse(fs.readFileSync(path.join(root,'assets',n)));
const prior = n => fs.existsSync(path.join(site,'.git'))
 ? JSON.parse(execFileSync('git',['show',`e267ac61ca59548022dfe820b338958402781b27:dist/assets/${n}`],{cwd:site,encoding:'utf8'}))
 : JSON.parse(execFileSync('git',['show',`ab1e76468385e275921658af38376efd97fb6694:sites/blackwall-presentation/published/dist/assets/${n}`],{cwd:path.resolve(import.meta.dirname,'../../..'),encoding:'utf8'}));
const checks=[];const check=(name,ok,detail='')=>checks.push({name,result:ok?'PASS':'FAIL',detail});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const currentFlow=read('process-flow.json'),oldFlow=prior('process-flow.json');
const routeContract=f=>f.scenarios.map(s=>({id:s.id,steps:s.steps.map(x=>({node:x.node,edge:x.edge,events:x.events,policyFields:x.policyFields})),messages:s.sequenceMessages.map(m=>({from:m.from,to:m.to,kind:m.kind,step:m.step,hasCondition:!!m.condition}))}));
check('Sequence participants, message routing, ordering, response kinds, conditions and policy links remain intact',equal(routeContract(currentFlow),routeContract(oldFlow))&&equal(currentFlow.nodes.map(n=>({id:n.id,policyFields:n.policyFields,sources:n.sources})),oldFlow.nodes.map(n=>({id:n.id,policyFields:n.policyFields,sources:n.sources}))));
const oldEvidence=prior('evidence.json'),evidence=read('evidence.json');
const auditContract=e=>e.sessions.map(s=>({id:s.id,sessionRef:s.sessionRef,initialStatus:s.initialStatus,finalStatus:s.finalStatus,events:s.events.map(({title,description,...raw})=>raw)}));
check('Recorded audit event IDs, types, statuses, reasons, tools and effects remain unchanged',equal(auditContract(evidence),auditContract(oldEvidence)));
check('Recorded model configuration and numerical evidence remain unchanged',equal(evidence.models,oldEvidence.models)&&equal(evidence.metrics,oldEvidence.metrics));
const contexts=read('session-contexts.json'),oldContexts=prior('session-contexts.json');
check('Original user prompts and replay proposals remain verbatim',equal(contexts.sessions.map(s=>({id:s.id,prompt:s.prompt.text,replay:s.replayProposal?.text})),oldContexts.sessions.map(s=>({id:s.id,prompt:s.prompt.text,replay:s.replayProposal?.text}))));
const guide=read('policy-guide.json'),oldGuide=prior('policy-guide.json');
check('Policy field identity, JSON types, groups, editability and feature links remain unchanged',equal(guide.fields.map(f=>({id:f.id,path:f.path,type:f.type,group:f.group,runtimeEditable:f.runtimeEditable,featureIds:f.featureIds,aliases:f.aliases})),oldGuide.fields.map(f=>({id:f.id,path:f.path,type:f.type,group:f.group,runtimeEditable:f.runtimeEditable,featureIds:f.featureIds,aliases:f.aliases}))));
for(const n of ['policy.schema.json','policy-publication.schema.json'])check(`${n} retains the application validation contract`,equal(read(n),prior(n)));
check('Original clips and posters retain source files and durations',equal(evidence.videos.map(v=>({id:v.id,file:v.file,poster:v.poster,duration:v.duration})),oldEvidence.videos.map(v=>({id:v.id,file:v.file,poster:v.poster,duration:v.duration}))));
const pol=/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(?:Wczytuj|Wybierz|Zapisano|Polityki|Zdarzenie|użytkownika|Przypisano|Odtwórz|NAGRANE|NARZĘDZIE|Wszystkie|Brak dopasowań)\b/;
const errors=[];const browser=await chromium.launch({headless:true});
const p=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});p.on('pageerror',e=>errors.push(e.message));
await p.goto('http://127.0.0.1:8790/',{waitUntil:'networkidle'});await p.waitForSelector('.session-item');await p.waitForSelector('#policy-fields [data-policy-field]');
check('Main page declares English and has English metadata',await p.locator('html').getAttribute('lang')==='en'&&!pol.test(await p.title()));
const localizedText=await p.evaluate(()=>{const clone=document.body.cloneNode(true);clone.querySelectorAll('script,style,#session-prompt,pre,code,#session-replay-text').forEach(n=>n.remove());return clone.textContent;});
check('Initial visible presentation copy is English',!pol.test(localizedText));
for(const s of contexts.sessions){await p.locator(`[data-session="${s.id}"]`).click();const t=await p.locator('#session-title').innerText();const c=await p.locator('#session-context').evaluate(el=>{const n=el.cloneNode(true);n.querySelectorAll('#session-prompt,pre,code').forEach(x=>x.remove());return n.textContent;});check(`English session explanation: ${s.id}`,!pol.test(t+c));if(s.prompt.translationEN){check(`English translation is provided for original Polish prompt: ${s.id}`,await p.locator('#session-translation').isVisible());await p.locator('#session-translation summary').click();check(`English translation matches source: ${s.id}`,await p.locator('#session-translation-text').innerText()===s.prompt.translationEN&&!pol.test(s.prompt.translationEN));}else check(`English original is not redundantly translated: ${s.id}`,await p.locator('#session-translation').isHidden());for(let i=0;i<evidence.sessions.find(x=>x.id===s.id).events.length;i++){await p.locator('#replay-scrub').evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},i);const text=await p.locator('.event-detail').evaluate(el=>{const n=el.cloneNode(true);n.querySelectorAll('code,pre').forEach(x=>x.remove());return n.textContent;});check(`English audit explanation: ${s.id} event ${i+1}`,!pol.test(text));}}
for(const f of guide.fields){await p.evaluate(id=>window.BlackwallPolicyGuide.selectField(id),f.id);const t=await p.locator('#policy-detail').evaluate(el=>{const n=el.cloneNode(true);n.querySelectorAll('code,pre,video').forEach(x=>x.remove());return n.textContent;});check(`English policy explanation: ${f.path}`,!pol.test(t));}
for(const s of currentFlow.scenarios){await p.locator('#process-scenario').selectOption(s.id);const t=await p.locator('#process-workbench').evaluate(el=>{const n=el.cloneNode(true);n.querySelectorAll('pre,code').forEach(x=>x.remove());return n.textContent;});check(`English sequence explanation: ${s.id}`,!pol.test(t));}
for(const v of evidence.videos){await p.locator(`[data-video="${v.id}"]`).click();check(`English recording description: ${v.id}`,!pol.test(await p.locator('.video-caption').innerText()));}
check('Desktop has no horizontal page overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await p.locator('#start').scrollIntoViewIfNeeded();await p.screenshot({path:path.join(output,'english-desktop.png')});
await p.setViewportSize({width:390,height:844});await p.goto('http://127.0.0.1:8790/',{waitUntil:'networkidle'});await p.waitForSelector('.session-item');check('Mobile has no horizontal page overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await p.screenshot({path:path.join(output,'english-mobile.png')});
await p.goto('http://127.0.0.1:8790/presentation.html',{waitUntil:'networkidle'});check('Alternate presentation entry point is English',await p.locator('html').getAttribute('lang')==='en');
check('No uncaught browser errors',errors.length===0,errors.join('; '));await browser.close();
const report={generated_at:new Date().toISOString(),scope:'English localization, recorded evidence preservation and desktop/mobile UI. No new model or API calls.',checks,errors,passed:checks.filter(x=>x.result==='PASS').length,total:checks.length,sourceHashes:Object.fromEntries(['evidence.json','session-contexts.json','process-flow.json','policy-guide.json'].map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'assets',n))).digest('hex')]))};fs.writeFileSync(path.join(output,'english-localization.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,total:report.total,failures:checks.filter(x=>x.result==='FAIL')}));process.exitCode=checks.some(x=>x.result==='FAIL')?1:0;
