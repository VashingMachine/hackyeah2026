'use strict';
// Dashboard for the Blackwall audit stream. All values are inserted as text (never as HTML): prompts and tool
// arguments in the log are untrusted data.

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

let token = '';
try { token = sessionStorage.getItem('bw-admin') || ''; } catch { /* storage may be unavailable */ }
const state = { events: [], sessions: [], selected: null, tab: 'overview', lastId: 0 };
const seen = new Set();

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(res.status === 401 ? 'Brak dostępu: podaj token administratora.' : `HTTP ${res.status}`);
  return res;
}
const showError = (m) => { const e = $('#error'); e.hidden = !m; e.textContent = m || ''; };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pl-PL', { hour12: false });
const short = (id) => (id ? id.replace(/^sess_/, '').slice(0, 8) : '—');
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('pl-PL'));
const pill = (v) => el('span', { class: `pill ${v}` }, v);

// ---------------------------------------------------------------- overview
async function loadOverview() {
  const [m, s] = await Promise.all([api('/v1/admin/metrics').then((r) => r.json()), api('/v1/admin/sessions').then((r) => r.json())]);
  state.sessions = s.sessions;
  $('#policy-line').textContent = `${m.policy.id} v${m.policy.version} · poziom: ${m.policy.profile} · tryb: ${m.policy.mode} · embeddingi: ${m.policy.embedder}`;
  const d = m.decisions, ev = m.events, ss = m.sessions;
  const kpis = [
    ['Decyzje: allow', d.allow ?? 0, 'good'], ['Decyzje: deny', d.deny ?? 0, d.deny ? 'bad' : ''], ['Wymagane zgody', d.require_approval ?? 0, 'warn'],
    ['Sesje aktywne', ss.active ?? 0, 'good'], ['Sesje zamknięte (terminated)', ss.terminated ?? 0, ss.terminated ? 'bad' : ''], ['Sesje zablokowane', ss.blocked ?? 0, ss.blocked ? 'bad' : ''],
    ['W przeglądzie / czekają na zgodę', (ss.reviewing ?? 0) + (ss.awaiting_approval ?? 0), 'warn'],
    ['Zredagowano / zablokowano treść', `${ev['content.redacted'] ?? 0} / ${ev['content.blocked'] ?? 0}`, ''],
    ['Trafienia feedu zagrożeń', m.threat_feed_blocks, m.threat_feed_blocks ? 'bad' : ''],
    ['Tematy wykryte / potwierdzone', `${ev['topic.candidate_detected'] ?? 0} / ${ev['topic.confirmed'] ?? 0}`, ''],
    ['Tokeny zużyte', num(m.spend.tokens_spent), ''], ['Koszt', m.spend.cost_usd_micros ? `$${(m.spend.cost_usd_micros / 1e6).toFixed(4)}` : 'nie wyceniono', ''],
    ['Wywołania modelu / odmowy bramki', `${ev['model.completed'] ?? 0} / ${(ev['model.denied'] ?? 0) + (ev['budget.denied'] ?? 0)}`, ''],
    ['Narzędzia: start / koniec / błąd', `${ev['tool.started'] ?? 0} / ${ev['tool.completed'] ?? 0} / ${ev['tool.failed'] ?? 0}`, ''],
  ];
  const k = clear($('#kpis'));
  for (const [label, val, tone] of kpis) k.append(el('div', { class: `kpi ${tone}` }, el('b', {}, val), el('span', {}, label)));

  const names = { decision_total: 'Decyzja narzędzia (łącznie)', deterministic: 'Kontrole deterministyczne', topic_detection: 'Wykrywanie tematu (embedding)', judge_jev: 'Jev (ocena semantyczna)', guardian: 'Nadzorca sesji (Haiku)', model_provider: 'Dostawca modelu' };
  const tb = clear($('#latency tbody'));
  for (const [key, label] of Object.entries(names)) { const x = m.latency_ms[key]; tb.append(el('tr', {}, el('td', {}, label), el('td', { class: 'num' }, x.count), el('td', { class: 'num' }, num(x.p50)), el('td', { class: 'num' }, num(x.p95)), el('td', { class: 'num' }, num(x.max)))); }
  const rt = clear($('#reasons tbody'));
  if (!m.deny_reasons.length) rt.append(el('tr', {}, el('td', { class: 'empty' }, 'brak odmów')));
  for (const r of m.deny_reasons) rt.append(el('tr', {}, el('td', {}, el('span', { class: 'tag' }, r.reasons)), el('td', { class: 'num' }, r.count)));

  const st = clear($('#sessions tbody'));
  for (const x of s.sessions) {
    st.append(el('tr', {},
      el('td', { class: 'mono' }, short(x.id)), el('td', {}, x.user), el('td', {}, pill(x.status), x.status_reason ? el('small', { class: 'note' }, ` ${x.status_reason}`) : null),
      el('td', {}, x.topics.filter((t) => t.state !== 'dismissed').map((t) => el('span', { class: 'tag', title: `${t.state} · score ${t.score.toFixed(2)}` }, `${t.topic_id}${t.state === 'confirmed' ? ' ✓' : '?'}`)), x.guardian ? el('span', { class: 'tag' }, 'nadzorca') : null),
      el('td', { class: 'num' }, `${num(x.budget.tokens_spent)}${x.budget.token_limit ? ' / ' + num(x.budget.token_limit) : ''}`),
      el('td', { class: 'num' }, `${x.budget.tool_attempts}${x.budget.tool_attempt_limit ? ' / ' + x.budget.tool_attempt_limit : ''}`),
      el('td', { class: 'row-actions' },
        el('button', { onclick: () => openSession(x.id) }, 'zdarzenia'),
        x.status !== 'terminated' && x.status !== 'blocked' ? el('button', { class: 'danger', onclick: () => act(`/v1/admin/sessions/${x.id}/revoke`) }, 'zablokuj') : null,
        x.status === 'blocked' ? el('button', { class: 'ok', onclick: () => act(`/v1/admin/sessions/${x.id}/resume`) }, 'wznów') : null)));
  }
  const ap = clear($('#approvals'));
  if (!s.pending_approvals.length) ap.append(el('p', { class: 'empty' }, 'brak'));
  for (const a of s.pending_approvals) ap.append(el('div', {}, el('span', { class: 'tag' }, a.tool), ` sesja ${short(a.session_id)} · ${a.reason_codes} · wygasa ${fmtTime(a.expires_at)}`, el('p', { class: 'note' }, 'Zgodę wydaje użytkownik w interfejsie Pi, nie administrator.')));
  const rv = clear($('#reviews'));
  if (!s.open_reviews.length) rv.append(el('p', { class: 'empty' }, 'brak'));
  for (const r of s.open_reviews) rv.append(el('div', { class: 'row-actions' }, `sesja ${short(r.session_id)} · zdarzenie #${r.seq} `, el('button', { class: 'ok', onclick: () => review(r.id, 'no_violation') }, 'brak naruszenia'), el('button', { class: 'danger', onclick: () => review(r.id, 'violation') }, 'naruszenie')));

  const sel = $('#f-session'); const cur = sel.value;
  clear(sel).append(el('option', { value: '' }, 'wszystkie'));
  for (const x of s.sessions) sel.append(el('option', { value: x.id }, `${short(x.id)} · ${x.user}`));
  sel.value = cur;
}

async function act(path) { try { await api(path, { method: 'POST' }); await loadOverview(); } catch (e) { showError(e.message); } }
async function review(id, outcome) {
  const note = prompt('Uzasadnienie względem obowiązującej polityki (wymagane):');
  if (!note || note.length < 3) return;
  try { await api(`/v1/admin/topic-reviews/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome, note }) }); await loadOverview(); } catch (e) { showError(e.message); }
}

// ---------------------------------------------------------------- events
const NOISE = /^(content\.|budget\.|model\.released|topic\.dismissed)/;
function describe(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'decision.allowed': return [`Dozwolono: ${e.tool}`, summarizeArgs(d.args)];
    case 'decision.denied': return [`Odmowa: ${e.tool}`, `${e.reason_codes.join(', ')} · ${d.session_action}`];
    case 'approval.requested': return [`Wymagana zgoda: ${e.tool}`, e.reason_codes.join(', ')];
    case 'approval.approved': return ['Użytkownik zatwierdził', ''];
    case 'approval.rejected': return ['Użytkownik odrzucił', ''];
    case 'topic.candidate_detected': return [`Wykryto temat: ${d.topic_id}`, `podobieństwo ${d.score} · ${d.embedder}`];
    case 'topic.confirmed': return [`Temat potwierdzony: ${d.topic_id}`, ''];
    case 'guardian.started': return ['Uruchomiono nadzorcę sesji', (d.topics || []).join(', ')];
    case 'guardian.reviewed': return [`Nadzorca: ${d.verdict}`, `${d.event_kind} · ${d.latency_ms} ms${d.reason_code ? ' · ' + d.reason_code : ''}`];
    case 'session.terminated': return ['Sesja zamknięta (terminated)', e.reason_codes.join(', ')];
    case 'session.reviewing': return ['Sesja wstrzymana do przeglądu', ''];
    case 'judge.evaluated': return [`Jev: ${d.verdict}`, `${d.tool} · ${d.latency_ms} ms · ${d.source}`];
    case 'model.completed': return ['Wywołanie modelu', `${(d.usage && (d.usage.prompt_tokens + d.usage.completion_tokens)) || '?'} tokenów · ${d.provider_ms} ms`];
    case 'model.denied': case 'budget.denied': return [`Odmowa bramki modelu`, e.reason_codes.join(', ')];
    case 'content.redacted': case 'content.blocked': return [e.type === 'content.blocked' ? 'Treść zablokowana' : 'Treść zredagowana', (d.findings || []).map((f) => f.type).join(', ')];
    case 'tool.started': case 'tool.completed': case 'tool.failed': return [`Wykonanie: ${e.type.slice(5)}`, e.request_id || ''];
    default: return [e.type, ''];
  }
}
const summarizeArgs = (a) => (a ? JSON.stringify(a).slice(0, 110) : '');
const tone = (e) => (e.effect === 'deny' || e.type === 'session.terminated' ? 'deny' : e.effect === 'require_approval' ? 'require_approval' : e.effect === 'allow' ? 'allow' : 'info');

function renderTimeline() {
  const hide = $('#f-hide').checked; const sid = $('#f-session').value; const ty = $('#f-type').value.trim();
  const re = ty ? new RegExp('^' + ty.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
  const rows = state.events.filter((e) => (!sid || e.session_id === sid) && (!hide || !NOISE.test(e.type)) && (!re || re.test(e.type)));
  const ol = clear($('#timeline'));
  for (const e of rows.slice(0, 400)) {
    const [t, sub] = describe(e);
    ol.append(el('li', { class: state.selected === e.id ? 'sel' : '', tabindex: 0, onclick: () => { state.selected = e.id; renderTimeline(); renderDetail(e); }, onkeydown: (k) => { if (k.key === 'Enter') k.target.click(); } },
      el('time', {}, fmtTime(e.ts)), el('span', { class: `dot ${tone(e)}` }), el('div', {}, el('strong', {}, t), el('small', {}, `${short(e.session_id)} ${sub || ''}`))));
  }
  if (!rows.length) ol.append(el('li', {}, el('span', {}), el('span', {}), el('small', {}, 'Brak zdarzeń dla filtra.')));
}
function renderDetail(e) {
  const d = clear($('#detail'));
  const [t] = describe(e);
  const dd = e.data || {};
  const facts = [['Zdarzenie', e.type], ['Sesja', e.session_id], ['Użytkownik', e.user], ['Czas serwera', new Date(e.ts).toISOString()], ['Narzędzie', e.tool], ['Efekt', e.effect], ['Powody', e.reason_codes.join(', ')], ['request_id', e.request_id], ['decision_id', e.decision_id], ['Wersja polityki', dd.policy_version], ['Poziom', dd.profile], ['Stan sesji po decyzji', dd.session_action], ['Dowód nadzorcy', dd.evidence], ['Nie wykonano zdarzenia?', e.type === 'decision.denied' ? 'tak — narzędzie nie zostało uruchomione' : null]].filter(([, v]) => v);
  d.append(el('h2', {}, t), el('dl', {}, facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])));
  d.append(el('pre', {}, JSON.stringify(dd, null, 2)));
}
async function loadEvents() {
  const r = await api('/v1/admin/events?limit=600').then((x) => x.json());
  state.events = r.events; state.lastId = r.events[0]?.id ?? 0;
  seen.clear(); for (const e of r.events) seen.add(e.id);
  renderTimeline();
}
function openSession(id) { selectTab('events'); $('#f-session').value = id; renderTimeline(); }

// live stream over fetch (EventSource cannot send an Authorization header)
async function stream() {
  for (;;) {
    try {
      const res = await fetch(`/v1/admin/stream?since=${state.lastId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('stream');
      $('#live').classList.add('on'); $('#live').textContent = '●';
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) { const e = JSON.parse(chunk.slice(6)); if (!seen.has(e.id)) { seen.add(e.id); state.events.unshift(e); } state.lastId = Math.max(state.lastId, e.id); schedule(); }
        }
      }
    } catch { /* retry below */ }
    $('#live').classList.remove('on'); $('#live').textContent = '○';
    await new Promise((r) => setTimeout(r, 2000));
  }
}
let timer;
function schedule() { clearTimeout(timer); timer = setTimeout(() => { if (state.tab === 'events') renderTimeline(); if (state.tab === 'overview') loadOverview().catch(() => {}); }, 400); }

// ---------------------------------------------------------------- policies
async function loadPolicies() {
  const p = await api(`/v1/admin/policies/effective${$('#eff-user').value ? '?user=' + $('#eff-user').value : ''}`).then((r) => r.json());
  const f = clear($('#policy-facts'));
  for (const [k, v] of [['Polityka', `${p.policy_id} v${p.version}`], ['Tryb', p.mode], ['Poziom', p.profile], ['Feed zagrożeń', `${p.feed.catalog_id} v${p.feed.version} · ${p.feed.signatures} sygnatur`], ['Detektor tematów', p.embedder], ['Zgody użytkownika', `${p.approvals.enabled ? 'włączone' : 'wyłączone'} · TTL ${p.approvals.ttl_seconds}s · ${p.approvals.eligible_reason_codes.join(', ')}`], ['Korekty po odmowie', `do ${p.denials.max_correction_attempts} dla ${p.denials.allow_correction_for.join(', ')}`]]) f.append(el('dt', {}, k), el('dd', {}, v));
  const sel = $('#eff-user'); if (!sel.options.length) { for (const u of p.users) sel.append(el('option', { value: u }, u)); sel.value = p.users[0]; return loadPolicies(); }
  $('#effective').textContent = JSON.stringify(p.effective, null, 2);
  const t = clear($('#topics')); t.append(el('tr', {}, el('th', {}, 'Temat'), el('th', {}, 'Polityka'), el('th', {}, 'Przykłady')));
  for (const x of p.topics) t.append(el('tr', {}, el('td', {}, el('span', { class: 'tag' }, x.id)), el('td', {}, x.policy_id), el('td', { class: 'num' }, x.examples)));
  $('#policy-line').textContent = `${p.policy_id} v${p.version} · poziom: ${p.profile} · tryb: ${p.mode} · embeddingi: ${p.embedder}`;
  const names = Object.keys(p.profiles);
  const pr = clear($('#profiles'));
  pr.append(el('tr', {}, el('th', {}, 'Ustawienie'), names.map((n) => el('th', {}, n === p.profile ? `${n} (aktywny)` : n))));
  for (const key of Object.keys(p.profiles[names[0]])) pr.append(el('tr', {}, el('td', {}, key), names.map((n) => el('td', { class: n === p.profile ? 'cur' : '' }, String(p.profiles[n][key])))));
}

// ---------------------------------------------------------------- shell
function selectTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const n of ['overview', 'events', 'policies']) $(`#tab-${n}`).hidden = n !== name;
  refresh();
}
async function refresh() {
  try {
    showError('');
    if (state.tab === 'overview') await loadOverview();
    if (state.tab === 'events') { if (!state.events.length) await loadEvents(); else renderTimeline(); await loadOverview().catch(() => {}); }
    if (state.tab === 'policies') await loadPolicies();
  } catch (e) { showError(e.message); }
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
$('#token').value = token;
$('#save-token').addEventListener('click', () => { token = $('#token').value.trim(); try { sessionStorage.setItem('bw-admin', token); } catch { /* ignore */ } state.events = []; refresh(); });
for (const id of ['#f-session', '#f-type', '#f-hide']) $(id).addEventListener('input', renderTimeline);
$('#eff-user').addEventListener('change', loadPolicies);
$('#export').addEventListener('click', async () => {
  try { const r = await api('/v1/admin/export'); const url = URL.createObjectURL(await r.blob()); const a = el('a', { href: url, download: 'blackwall-audit.jsonl' }); a.click(); URL.revokeObjectURL(url); } catch (e) { showError(e.message); }
});
if (!token) { token = 'demo-admin-token'; $('#token').value = token; }
// Deep links: #events, #policies, #events/<session id> (filters the timeline to one session)
const [initialTab, initialSession] = location.hash.slice(1).split('/');
if (['events', 'policies'].includes(initialTab)) {
  selectTab(initialTab);
  if (initialSession) setTimeout(() => { const sel = $('#f-session'); if (![...sel.options].some((o) => o.value === initialSession)) sel.append(el('option', { value: initialSession }, initialSession)); sel.value = initialSession; $('#f-hide').checked = true; renderTimeline(); }, 1500);
} else refresh();
loadEvents().catch(() => {}).finally(() => stream());
setInterval(() => { if (state.tab === 'overview') loadOverview().catch(() => {}); }, 10000);
