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
  $('motion-toggle').setAttribute('aria-label',motion?'Wyłącz animacje':'Włącz animacje');
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
  $('present-toggle').setAttribute('aria-pressed',String(on));$('present-toggle').firstChild.textContent=on?'Zakończ pokaz ':'Tryb pokazu ';
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
  allow:{effect:'allow',label:'Dopuszczenie',operation:'read("Atlas / company.json")',description:'Odczyt w przypisanej sprawie może przejść do wykonania po kontrolach. Dopuszczenie i raport wykonania są osobnymi zdarzeniami.'},
  approval:{effect:'require_approval',label:'Wymagana zgoda',operation:'write("Atlas / kyc-draft.md", nowa treść)',description:'Zastąpienie istniejącego szkicu czeka na jednorazową zgodę dla dokładnych argumentów i zasobu. Silnik ponownie sprawdza plik przed rozpoczęciem operacji.'},
  deny:{effect:'deny',label:'Odmowa',operation:'POST poufnej analizy bez zlecenia użytkownika',description:'Nadzorca ocenia propozycję publikacji według polityki M&A. Potwierdzone naruszenie kończy sesję. Odmowa zatrzymuje executor; odbiornik nie dostaje requestu.'}
};
let flowChoice='allow';
function runFlow(choice=flowChoice){
  flowChoice=choice;flowTimers.forEach(clearTimeout);flowTimers=[];
  const f=flowExamples[choice],lab=$('flow-lab');lab.dataset.effect=choice;
  all('[data-flow]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.flow===choice)));
  $('flow-operation').textContent=f.operation;$('flow-effect').textContent=f.effect;$('flow-short').textContent=f.label;$('flow-description').textContent=f.description;
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
const sourceLabels={Pi:'Agent Pi','Authenticated API harness replay':'Replay API','Core.decideTool harness replay':'Replay silnika'};
function shortKind(s){if(s.id==='uncertain-review-continuation')return'Replay + admin';return ['Pi','Rozmowa Pi'].includes(s.sourceType)?'Agent Pi':'Replay propozycji';}
function timeLabel(value){return new Date(value).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Warsaw',hour12:false});}
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
function stopPlayback(){clearTimeout(playTimer);playTimer=null;$('replay-play').textContent='▶';$('replay-play').setAttribute('aria-label','Odtwórz zdarzenia sesji');}
function schedulePlayback(){
  $('replay-play').textContent='Ⅱ';$('replay-play').setAttribute('aria-label','Wstrzymaj odtwarzanie');
  playTimer=setTimeout(()=>{if(eventIndex<selectedSession.events.length-1){renderEvent(eventIndex+1,true);schedulePlayback();}else stopPlayback();},Number($('replay-speed').value));
}
const featureLabels={file_scope:'Zakres plików',approval:'Zgoda użytkownika',execution_grant:'Jednorazowe uprawnienie',topic_assignment:'Zaufany temat',embeddings:'Embeddingi OpenAI',guardian:'Nadzorca sesji',session_state:'Stan sesji',network_scope:'Kontrola HTTP',budgets:'Budżety',threat_feed:'Feed zagrożeń',semantic_review:'Ocena Jeva',output_control:'Kontrola wejścia i odpowiedzi',policy_publication:'Publikacja polityki'};
window.BlackwallFeatures=featureLabels;
function renderFeatureChips(target,ids=[]){
  target.replaceChildren();
  ids.forEach(id=>{const b=node('button','feature-chip',featureLabels[id]||id);b.type='button';b.dataset.feature=id;b.title=contextFeatures[id]||'Zobacz pola polityki związane z tą funkcją';b.addEventListener('click',()=>window.BlackwallPolicyGuide?.selectFeature(id));target.append(b);});
}
function renderSessionContext(s){
  const c=s.context,p=c.prompt;
  const kinds={original_pi_user_prompt:'Prompt przekazany do Pi',harness_user_task:'Zadanie wejściowe replayu',originating_human_task:'Zadanie początkowe scenariusza'};
  $('session-prompt').textContent=p.text;$('session-prompt-kind').textContent=kinds[p.kind]||'Zapisane wejście scenariusza';
  $('session-prompt-note').textContent=[p.normalizationNote,`Źródło: ${p.source}`].filter(Boolean).join(' ');
  $('session-translation').hidden=!p.translationPL;$('session-translation').open=false;$('session-translation-text').textContent=p.translationPL||'';
  $('session-agent-action').textContent=c.agentAction;$('session-blackwall-action').textContent=c.blackwallAction;
  $('session-replay-proposal').hidden=!c.replayProposal;$('session-replay-text').textContent=c.replayProposal?.text||'';
  $('session-replay-note').textContent=c.replayProposal?[c.replayProposal.normalizationNote,`Źródło: ${c.replayProposal.source}`].filter(Boolean).join(' '):'';
  renderFeatureChips($('session-features'),c.featureIds);$('session-feature-summary').textContent=c.featureSummary;
}
function selectSession(s){
  stopPlayback();selectedSession=s;eventIndex=0;renderSessionContext(s);
  $('session-domain').textContent=`${s.domain} / ${s.sessionRef}`;$('session-title').textContent=s.title;$('session-subtitle').textContent=s.subtitle;
  $('session-kind').textContent=shortKind(s);$('session-kind').title=s.sourceType;
  $('session-proof').textContent=s.proof;$('session-note').textContent=s.note+' Wybrane zdarzenia audytu; numery seq i czas serwera zachowane. Zgody administratora i użytkownika są symulowane przez harness.';
  $('dash-source').textContent='AUDYT DEMO / POLICY v1';$('replay-scrub').max=String(s.events.length-1);
  const log=$('event-log');log.replaceChildren();
  s.events.forEach((e,i)=>{
    const b=node('button','event-row');b.type='button';b.dataset.index=String(i);b.setAttribute('aria-label',`Zdarzenie seq ${e.seq}: ${e.title}`);
    b.append(node('span','event-number',String(e.seq).padStart(2,'0')));
    const body=node('div');body.append(node('strong','',e.title));body.append(node('small','',`${timeLabel(e.time)} · ${e.type}`));
    if(e.reason)body.append(node('span','event-reason-short',e.reason));b.append(body);b.addEventListener('click',()=>{stopPlayback();renderEvent(i);});log.append(b);
  });
  renderSessions();renderEvent(0);
}
function renderSessions(){
  if(!evidence)return;
  const filter=$('session-filter').value;const sessions=evidence.sessions.filter(s=>filter==='all'||s.domain===filter);
  $('session-count').textContent=String(sessions.length);$('sessions-list').replaceChildren();
  sessions.forEach(s=>{
    const b=node('button','session-item');b.type='button';b.setAttribute('aria-pressed',String(selectedSession?.id===s.id));b.dataset.session=s.id;
    b.append(node('strong','',s.title));b.append(node('small','',`${s.domain} / ${s.events.length} wybranych zdarzeń`));
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
  $('event-title').textContent=e.title;$('event-type').textContent=e.type;$('event-description').textContent=e.description;$('event-reason').textContent=e.reason||e.topic||'Brak kodu powodu w tym zdarzeniu';
  const explanation=selectedSession.context.events[String(e.seq)];
  $('event-feature-explanation').textContent=explanation?.featureExplanation||'Zdarzenie informacyjne w audycie; nie jest samodzielnym dowodem wykonania ani blokady.';
  $('event-intervention').textContent=explanation?.interventionLabel||'Zapis audytowy';
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
const videoKinds={'runtime-publication':'Pi + admin / jawny replay','approval':'Pi / symulowana zgoda','policy-block':'Kontrola polityki','harness-replay':'Jawny replay propozycji','judge':'Pi / Jev','embedding':'Pi / detekcja tematu','authorized-action':'Pi / dozwolona operacja'};
function durationLabel(seconds){return`${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,'0')}`;}
function selectVideo(v,play=false){
  const player=$('demo-video');player.pause();player.poster=assetURL(v.poster);player.src=assetURL(v.file);player.load();
  $('video-title').textContent=v.title;$('video-description').textContent=v.description;$('video-kind').textContent=videoKinds[v.kind]||'Nagranie demo';
  $('video-placeholder').hidden=true;all('.video-choice').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.video===v.id)));
  if(play)player.play().catch(()=>{ /* Native controls remain available if autoplay policy blocks playback. */ });
}
function renderVideos(){
  const list=$('video-choices');list.replaceChildren();
  evidence.videos.forEach(v=>{
    const b=node('button','video-choice');b.type='button';b.dataset.video=v.id;b.setAttribute('aria-label',`Odtwórz: ${v.title}`);
    const thumb=node('div','video-thumb'),img=node('img');img.src=assetURL(v.poster);img.alt='';img.loading='lazy';img.width=640;img.height=360;thumb.append(img,node('span','video-duration',durationLabel(v.duration)));
    const copy=node('div');copy.append(node('strong','',v.title),node('small','',videoKinds[v.kind]||'Nagranie demo'));b.append(thumb,copy);b.addEventListener('click',()=>selectVideo(v,true));list.append(b);
  });if(evidence.videos.length)selectVideo(evidence.videos[0]);
}
$('demo-video').addEventListener('error',()=>{if($('demo-video').src){$('video-placeholder').hidden=false;$('video-placeholder').querySelector('p').textContent='Nie udało się otworzyć filmu. Wybierz go ponownie lub zmień nagranie.';}});
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
    evidence=d;const filter=$('session-filter');filter.replaceChildren(node('option','','Wszystkie domeny'));filter.firstChild.value='all';[...new Set(d.sessions.map(s=>s.domain))].forEach(domain=>{const option=node('option','',domain);option.value=domain;filter.append(option);});
    $('load-error').hidden=true;selectSession(d.sessions[0]);renderVideos();$('session-filter').disabled=false;
  }catch{ $('load-error').hidden=false;$('dash-source').textContent='Dane chwilowo niedostępne';$('sessions-list').replaceChildren(node('p','loading-copy','Nie udało się wczytać audytu. Użyj przycisku ponowienia poniżej.'));stopPlayback(); }
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
