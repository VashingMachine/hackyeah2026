'use strict';
const $ = id => document.getElementById(id);
const all = s => [...document.querySelectorAll(s)];
const node = (tag, cls, text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text!=null)n.textContent=text; return n; };
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
let motion = !reducedQuery.matches;
let contextFeatures={}, evidence, selectedSession, eventIndex=0, playTimer=null, flowTimers=[];
let presentation=false, slideIndex=0, canvasFrame=0;
const slides=all('[data-slide]');
document.body.classList.add('js');
const observer=new IntersectionObserver(entries=>entries.forEach(e=>{
  if(e.isIntersecting){e.target.classList.add('visible'); if(e.target.matches('.test-metrics'))animateCounts(e.target); observer.unobserve(e.target);}
}),{threshold:.12});
all('.reveal').forEach(e=>observer.observe(e));
function animateCounts(container){
  if(!motion)return;
  const start=performance.now();
  function tick(t){const progress=Math.min(1,(t-start)/900), ease=1-Math.pow(1-progress,3);container.querySelectorAll('[data-count]').forEach(n=>{n.textContent=String(Math.round(Number(n.dataset.count)*ease));});if(progress<1&&motion)requestAnimationFrame(tick);else container.querySelectorAll('[data-count]').forEach(n=>{n.textContent=n.dataset.count;});}
  requestAnimationFrame(tick);
}
function updateMotion(){
  document.body.classList.toggle('reduced-motion',!motion);
  $('motion-toggle').setAttribute('aria-pressed',String(motion));
  $('motion-toggle').setAttribute('aria-label',motion?'Disable animations':'Enable animations');
  if(!motion){all('[data-count]').forEach(n=>{n.textContent=n.dataset.count;});cancelAnimationFrame(canvasFrame);}
  else startCanvas();
}
$('motion-toggle').addEventListener('click',()=>{motion=!motion;updateMotion();});
reducedQuery.addEventListener('change',e=>{motion=!e.matches;updateMotion();});
const mobileNav=$('mobile-nav');
$('menu-toggle').addEventListener('click',()=>{mobileNav.hidden=!mobileNav.hidden;$('menu-toggle').setAttribute('aria-expanded',String(!mobileNav.hidden));});
mobileNav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{mobileNav.hidden=true;$('menu-toggle').setAttribute('aria-expanded','false');}));
function updateScroll(){
  const max=document.documentElement.scrollHeight-innerHeight;
  document.querySelector('.scroll-progress i').style.width=`${max?scrollY/max*100:0}%`;
  const middle=innerHeight*.3;
  slideIndex=slides.reduce((index,s,i)=>s.getBoundingClientRect().top<=middle?i:index,0);
  $('slide-label').textContent=`${String(slideIndex+1).padStart(2,'0')} / ${slides[slideIndex].dataset.slide}`;
  $('slide-prev').disabled=slideIndex===0;$('slide-next').disabled=slideIndex===slides.length-1;
}
addEventListener('scroll',updateScroll,{passive:true});addEventListener('resize',updateScroll);updateScroll();
function moveSlide(delta){slides[Math.max(0,Math.min(slides.length-1,slideIndex+delta))].scrollIntoView({behavior:motion?'smooth':'instant',block:'start'});}
function setPresentation(on){
  presentation=on;document.body.classList.toggle('presentation-mode',on);$('presentation-dock').hidden=!on;
  $('present-toggle').setAttribute('aria-pressed',String(on));$('present-toggle').firstChild.textContent=on?'Exit presentation ':'Presentation mode ';
  if(on){updateScroll();slides[slideIndex].scrollIntoView({behavior:motion?'smooth':'instant',block:'start'});}
  else $('present-toggle').focus({preventScroll:true});
}
$('present-toggle').addEventListener('click',()=>setPresentation(!presentation));$('present-exit').addEventListener('click',()=>setPresentation(false));
$('slide-prev').addEventListener('click',()=>moveSlide(-1));$('slide-next').addEventListener('click',()=>moveSlide(1));
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){if(presentation)setPresentation(false);mobileNav.hidden=true;$('menu-toggle').setAttribute('aria-expanded','false');return;}
  if(!presentation||e.target.closest('input,select,textarea,video,#policy-fields,#policy-json,#proces'))return;
  if(['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();moveSlide(['ArrowRight','PageDown'].includes(e.key)?1:-1);}
});
const flowExamples={
  allow:{effect:'allow',label:'Go ahead',request:'Read the company file for the assigned client.',rule:'Reads must stay within the assigned client folder.',operation:'Read: Atlas / company.json',description:'The file is inside the allowed folder. The agent may read it.',evidenceSessionId:'kyc-approval'},
  approval:{effect:'require_approval',label:'Ask the user',request:'Replace the client’s KYC draft.',rule:'A write to an existing file needs approval.',operation:'Write: Atlas / kyc-draft.md',description:'After approval, Blackwall rechecks the file before the write.',evidenceSessionId:'kyc-approval'},
  deny:{effect:'deny',label:'Stop here',request:'Summarize the confidential deal.',rule:'Do not publish without the user’s request.',operation:'POST: external service',description:'The agent tries to share the summary. Blackwall blocks it before the request leaves.',evidenceSessionId:'ma-publication-block'}
};
let flowChoice='allow';
function runFlow(choice=flowChoice){
  flowChoice=choice;flowTimers.forEach(clearTimeout);flowTimers=[];
  const f=flowExamples[choice],lab=$('flow-lab');lab.dataset.effect=choice;
  all('[data-flow]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.flow===choice)));
  if($('flow-request'))$('flow-request').textContent=f.request;
  if($('flow-rule'))$('flow-rule').textContent=f.rule;
  $('flow-operation').textContent=f.operation;$('flow-effect').textContent=f.effect;$('flow-short').textContent=f.label;$('flow-description').textContent=f.description;
  const evidenceLink=$('flow-evidence-link');if(evidenceLink)evidenceLink.dataset.demoSession=f.evidenceSessionId;
  lab.classList.remove('animating');all('.flow-node').forEach(n=>n.classList.remove('lit'));
  if(!motion){all('.flow-node').forEach(n=>n.classList.add('lit'));return;}
  void lab.offsetWidth;lab.classList.add('animating');
  all('.flow-node').forEach((n,i)=>flowTimers.push(setTimeout(()=>n.classList.add('lit'),i*520)));
  flowTimers.push(setTimeout(()=>lab.classList.remove('animating'),2300));
}
all('[data-flow]').forEach(b=>b.addEventListener('click',()=>runFlow(b.dataset.flow)));$('flow-restart').addEventListener('click',()=>runFlow());
new IntersectionObserver((entries,o)=>{if(entries.some(e=>e.isIntersecting)){runFlow();o.disconnect();}},{threshold:.35}).observe($('flow-lab'));
function assetURL(value){
  if(typeof value!=='string'||!/^assets\/[a-zA-Z0-9_./-]+$/.test(value)||value.split('/').includes('..'))throw new Error('Invalid local asset');
  return value;
}
const sourceLabels={Pi:'Pi agent','Authenticated API harness replay':'API replay','Core.decideTool harness replay':'Engine replay'};
function shortKind(s){if(s.id==='uncertain-review-continuation')return'Replay + admin';return ['Pi','Pi conversation'].includes(s.sourceType)?'Pi agent':'Proposal replay';}
function timeLabel(value){return new Date(value).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Warsaw',hour12:false});}
function stateAt(index){
  let status=selectedSession.initialStatus;
  selectedSession.events.slice(0,index+1).forEach(e=>{
    if(e.status)status=e.status;
    else if(e.type==='session.started')status='active';
    else if(e.type==='session.terminated')status='terminated';
    else if(e.type==='session.reviewing')status='reviewing';
    else if(e.type==='session.blocked')status='blocked';
    else if(e.type==='approval.requested')status='awaiting_approval';
    else if(e.type==='decision.allowed'&&status==='awaiting_approval')status='active';
  });
  if(index===selectedSession.events.length-1)status=selectedSession.finalStatus;
  return status;
}
function stopPlayback(){clearTimeout(playTimer);playTimer=null;$('replay-play').textContent='▶';$('replay-play').setAttribute('aria-label','Play session events');}
function schedulePlayback(){
  $('replay-play').textContent='Ⅱ';$('replay-play').setAttribute('aria-label','Pause playback');
  playTimer=setTimeout(()=>{if(eventIndex<selectedSession.events.length-1){renderEvent(eventIndex+1,true);schedulePlayback();}else stopPlayback();},Number($('replay-speed').value));
}
const featureLabels={file_scope:'File scope',approval:'User approval',execution_grant:'One-time execution grant',topic_assignment:'Trusted topic',embeddings:'OpenAI embeddings',guardian:'Session supervisor',session_state:'Session state',network_scope:'HTTP controls',budgets:'Budgets',threat_feed:'Threat feed',semantic_review:'Jev assessment',output_control:'Input and output controls',policy_publication:'Policy publication'};
window.BlackwallFeatures=featureLabels;
function renderFeatureChips(target,ids=[]){
  target.replaceChildren();
  ids.forEach(id=>{const b=node('button','feature-chip',featureLabels[id]||id);b.type='button';b.dataset.feature=id;b.title=contextFeatures[id]||'View policy fields related to this feature';b.addEventListener('click',()=>{const details=$('policy-details');if(details)details.open=true;window.BlackwallPolicyGuide?.selectFeature(id);});target.append(b);});
}
function renderSessionContext(s){
  const c=s.context,p=c.prompt;
  const kinds={original_pi_user_prompt:'Original prompt sent to Pi',harness_user_task:'Replay input task',originating_human_task:'Scenario source task'};
  $('session-prompt').textContent=p.text;$('session-prompt-kind').textContent=kinds[p.kind]||'Recorded scenario input';
  $('session-prompt-note').textContent=[p.normalizationNote,`Source: ${p.source}`].filter(Boolean).join(' ');
  $('session-translation').hidden=!p.translationEN;$('session-translation').open=false;$('session-translation-text').textContent=p.translationEN||'';
  $('session-agent-action').textContent=c.agentAction;$('session-blackwall-action').textContent=c.blackwallAction;
  $('session-replay-proposal').hidden=!c.replayProposal;$('session-replay-text').textContent=c.replayProposal?.text||'';
  $('session-replay-note').textContent=c.replayProposal?[c.replayProposal.normalizationNote,`Source: ${c.replayProposal.source}`].filter(Boolean).join(' '):'';
  renderFeatureChips($('session-features'),c.featureIds);$('session-feature-summary').textContent=c.featureSummary;
}
function selectSession(s){
  stopPlayback();selectedSession=s;eventIndex=0;renderSessionContext(s);
  $('session-domain').textContent=`${s.domain} / ${s.sessionRef}`;$('session-title').textContent=s.title;$('session-subtitle').textContent=s.subtitle;
  $('session-kind').textContent=shortKind(s);$('session-kind').title=s.sourceType;
  $('session-proof').textContent=s.proof;$('session-note').textContent=s.note+' Selected audit events; sequence numbers and server times are preserved. Administrator and user approvals are simulated by the harness.';
  $('dash-source').textContent='DEMO AUDIT / POLICY v1';$('replay-scrub').max=String(s.events.length-1);
  const log=$('event-log');log.replaceChildren();
  s.events.forEach((e,i)=>{
    const b=node('button','event-row');b.type='button';b.dataset.index=String(i);b.setAttribute('aria-label',`Event seq ${e.seq}: ${e.title}`);
    b.append(node('span','event-number',String(e.seq).padStart(2,'0')));
    const body=node('div');body.append(node('strong','',e.title));body.append(node('small','',`${timeLabel(e.time)} · ${e.type}`));
    if(e.reason)body.append(node('span','event-reason-short',e.reason));b.append(body);b.addEventListener('click',()=>{stopPlayback();renderEvent(i);});log.append(b);
  });
  renderSessions();renderEvent(0);
}
let pendingSessionId=null,pendingSessionEvent='first';
function selectSessionById(id,event='first'){
  if(!id)return false;
  if(!evidence){pendingSessionId=id;pendingSessionEvent=event;return true;}
  const session=evidence.sessions.find(item=>item.id===id);
  if(!session)return false;
  pendingSessionId=null;pendingSessionEvent='first';
  const filter=$('session-filter');if(filter.value!=='all'&&filter.value!==session.domain){filter.value='all';}
  selectSession(session);if(event==='last')renderEvent(session.events.length-1);return true;
}
function pauseReplay(){stopPlayback();$('demo-video')?.pause();window.BlackwallProcess?.stop();}
window.BlackwallPresentation={selectSessionById,pause:pauseReplay};
function renderSessions(){
  if(!evidence)return;
  const filter=$('session-filter').value;const sessions=evidence.sessions.filter(s=>filter==='all'||s.domain===filter);
  $('session-count').textContent=String(sessions.length);$('sessions-list').replaceChildren();
  sessions.forEach(s=>{
    const b=node('button','session-item');b.type='button';b.setAttribute('aria-pressed',String(selectedSession?.id===s.id));b.dataset.session=s.id;
    b.append(node('strong','',s.title));b.append(node('small','',`${s.domain} / ${s.events.length} selected events`));
    const meta=node('span','item-meta');meta.append(node('span','',shortKind(s)));meta.append(node('i',`status-dot ${s.finalStatus==='active'?'green':s.finalStatus==='reviewing'?'amber':'red'}`));b.append(meta);
    b.addEventListener('click',()=>selectSession(s));$('sessions-list').append(b);
  });
}
function renderEvent(index,scroll=false){
  eventIndex=index;const e=selectedSession.events[index];const state=stateAt(index);
  $('session-state').textContent=state;$('session-state').dataset.state=state;
  $('event-position').textContent=`${index+1}/${selectedSession.events.length} · seq ${e.seq}`;
  $('event-effect').textContent=[e.tool,e.effect].filter(Boolean).join(' / ')||'—';
  $('replay-scrub').value=String(index);$('event-time').textContent=timeLabel(e.time);
  $('event-title').textContent=e.title;$('event-type').textContent=e.type;$('event-description').textContent=e.description;$('event-reason').textContent=e.reason||e.topic||'No reason code recorded for this event';
  const explanation=selectedSession.context.events[String(e.seq)];
  $('event-feature-explanation').textContent=explanation?.featureExplanation||'Informational audit event; it does not by itself prove execution or a block.';
  $('event-intervention').textContent=explanation?.interventionLabel||'Audit record';
  $('event-operation').hidden=!explanation?.operationSummary;$('event-operation').textContent=explanation?.operationSummary||'';
  renderFeatureChips($('event-feature-chips'),explanation?.featureIds||[]);
  $('event-symbol').textContent=e.type==='tool.completed'?'✓':e.effect==='deny'||e.type==='session.terminated'?'×':e.effect==='require_approval'||e.type==='session.reviewing'?'Ⅱ':e.type.startsWith('topic.')?'◎':'↗';
  all('.event-row').forEach(b=>{const i=Number(b.dataset.index);b.setAttribute('aria-pressed',String(i===index));b.classList.toggle('future',i>index);});
  const active=$('event-log').children[index];if(scroll&&active)$('event-log').scrollTo({top:Math.max(0,active.offsetTop-$('event-log').offsetTop-90),behavior:motion?'smooth':'instant'});
  const detail=document.querySelector('.event-detail');detail.classList.remove('flash');if(motion){void detail.offsetWidth;detail.classList.add('flash');}
}
$('session-filter').addEventListener('change',()=>{const list=evidence?.sessions.filter(s=>$('session-filter').value==='all'||s.domain===$('session-filter').value)||[];if(list.length&&!list.some(s=>s.id===selectedSession?.id))selectSession(list[0]);else renderSessions();});
$('replay-play').addEventListener('click',()=>{if(!selectedSession)return;if(playTimer){stopPlayback();return;}if(eventIndex===selectedSession.events.length-1)renderEvent(0);schedulePlayback();});
$('replay-reset').addEventListener('click',()=>{stopPlayback();if(selectedSession)renderEvent(0);});
$('replay-scrub').addEventListener('input',e=>{stopPlayback();if(selectedSession)renderEvent(Number(e.target.value),true);});
$('replay-speed').addEventListener('change',()=>{if(playTimer){stopPlayback();schedulePlayback();}});
const videoKinds={'runtime-publication':'Pi + admin / explicit replay','approval':'Pi / simulated approval','policy-block':'Policy control','harness-replay':'Explicit proposal replay','judge':'Pi / Jev','embedding':'Pi / topic detection','authorized-action':'Pi / allowed operation'};
function durationLabel(seconds){return`${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,'0')}`;}
function selectVideo(v,play=false){
  const player=$('demo-video');player.pause();player.poster=assetURL(v.poster);player.src=assetURL(v.file);player.load();
  $('video-title').textContent=v.title;$('video-description').textContent=v.description;$('video-kind').textContent=videoKinds[v.kind]||'Demo recording';
  $('video-placeholder').hidden=true;all('.video-choice').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.video===v.id)));
  if(play)player.play().catch(()=>{ /* Native controls remain available if autoplay policy blocks playback. */ });
}
function renderVideos(){
  const list=$('video-choices');list.replaceChildren();
  evidence.videos.forEach(v=>{
    const b=node('button','video-choice');b.type='button';b.dataset.video=v.id;b.setAttribute('aria-label',`Play: ${v.title}`);
    const thumb=node('div','video-thumb'),img=node('img');img.src=assetURL(v.poster);img.alt='';img.loading='lazy';img.width=640;img.height=360;thumb.append(img,node('span','video-duration',durationLabel(v.duration)));
    const copy=node('div');copy.append(node('strong','',v.title),node('small','',videoKinds[v.kind]||'Demo recording'));b.append(thumb,copy);b.addEventListener('click',()=>selectVideo(v,true));list.append(b);
  });if(evidence.videos.length)selectVideo(evidence.videos[0]);
}
$('demo-video').addEventListener('error',()=>{if($('demo-video').src){$('video-placeholder').hidden=false;$('video-placeholder').querySelector('p').textContent='Could not open the video. Select it again or choose another recording.';}});
$('video-fullscreen').addEventListener('click',()=>{const v=$('demo-video');if(v.requestFullscreen)v.requestFullscreen().catch(()=>{});else if(v.webkitEnterFullscreen)v.webkitEnterFullscreen();});
async function loadEvidence(){
  $('session-filter').disabled=true;
  try{
    const response=await fetch('assets/evidence.json',{cache:'no-cache'});if(!response.ok)throw new Error('Evidence unavailable');
    const d=await response.json();if(!Array.isArray(d.sessions)||!d.sessions.length||!d.sessions.every(s=>Array.isArray(s.events)&&s.events.length)||!Array.isArray(d.videos))throw new Error('Invalid evidence shape');
    const contextResponse=await fetch('assets/session-contexts.json',{cache:'no-cache'});if(!contextResponse.ok)throw new Error('Session context unavailable');
    const contexts=await contextResponse.json();if(!Array.isArray(contexts.sessions))throw new Error('Invalid context');
    d.sessions=d.sessions.map(s=>{const context=contexts.sessions.find(c=>c.id===s.id);if(!context?.prompt?.text||!context.events)throw new Error('Missing session context');return{...s,context};});
    contextFeatures=contexts.featureCatalog||{};
    evidence=d;const filter=$('session-filter');filter.replaceChildren(node('option','','All domains'));filter.firstChild.value='all';[...new Set(d.sessions.map(s=>s.domain))].forEach(domain=>{const option=node('option','',domain);option.value=domain;filter.append(option);});
    $('load-error').hidden=true;const pending=d.sessions.find(s=>s.id===pendingSessionId);selectSession(pending||d.sessions[0]);if(pending&&pendingSessionEvent==='last')renderEvent(pending.events.length-1);pendingSessionId=null;pendingSessionEvent='first';renderVideos();$('session-filter').disabled=false;
  }catch{ $('load-error').hidden=false;$('dash-source').textContent='Data temporarily unavailable';$('sessions-list').replaceChildren(node('p','loading-copy','Could not load the audit record. Use the retry button below.'));stopPlayback(); }
}
$('retry-data').addEventListener('click',loadEvidence);loadEvidence();
function startCanvas(){
  cancelAnimationFrame(canvasFrame);
  const canvas=$('wall-canvas'),ctx=canvas.getContext('2d');if(!ctx)return;
  let last=0;const particles=Array.from({length:36},(_,i)=>({x:(i*73%100)/100,y:(i*47%100)/100,size:i%4===0?2:1,speed:.011+(i%6)*.005}));
  function draw(time){
    if(!motion||document.hidden){canvasFrame=0;return;}
    if(time-last>40){last=time;const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio,1.5);if(canvas.width!==Math.round(rect.width*dpr)||canvas.height!==Math.round(rect.height*dpr)){canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);if($('start').getBoundingClientRect().bottom>0){particles.forEach((p,i)=>{const y=(p.y-time/1000*p.speed+10)%1,x=p.x+.02*Math.sin(time/1800+i);ctx.fillStyle=`rgba(255,85,74,${.15+(i%4)*.08})`;ctx.fillRect(x*rect.width,y*rect.height,p.size,p.size*4);});}}
    canvasFrame=requestAnimationFrame(draw);
  }
  if(motion&&!document.hidden)canvasFrame=requestAnimationFrame(draw);
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPlayback();$('demo-video').pause();cancelAnimationFrame(canvasFrame);}else if(motion)startCanvas();});
updateMotion();
