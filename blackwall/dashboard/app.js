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
const state = { events: [], sessions: [], selected: null, tab: 'sessions', lastId: 0 };
const seen = new Set();
let authEpoch = 0;
let authAbort = new AbortController();
let streamAbort, streamGeneration = 0, sessionListLoad;
let sessionBrowser;

function createSessionBrowser() {
  sessionBrowser?.destroy();
  sessionBrowser = window.BlackwallSessions.create({
    root: $('#session-browser'), api, el, sessions: state.sessions, events: state.events,
    isActive: () => state.tab === 'sessions',
    onSessionSelect: id => { if (state.tab === 'sessions') history.replaceState(null, '', '#sessions/' + encodeURIComponent(id)); },
  });
}

async function api(path, opts = {}) {
  const epoch = authEpoch;
  const signal = opts.signal ? AbortSignal.any([authAbort.signal, opts.signal]) : authAbort.signal;
  const res = await fetch(path, { ...opts, signal, headers: { ...opts.headers, Authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  if (epoch !== authEpoch) throw new DOMException('Authentication changed', 'AbortError');
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(res.status === 401 ? 'No access: enter the administrator token.' : (body?.error?.message || `HTTP ${res.status}`));
  }
  return res;
}
async function loadSessionList() {
  if (sessionListLoad) return sessionListLoad;
  const epoch = authEpoch;
  const pending = (async () => {
    const result = await api('/v1/admin/sessions').then(r => r.json());
    if (epoch !== authEpoch) return;
    state.sessions = result.sessions;
    sessionBrowser?.updateSessions(result.sessions);
  })();
  sessionListLoad = pending;
  try { await pending; } finally { if (sessionListLoad === pending) sessionListLoad = null; }
}
async function loadPolicySummary() {
  const epoch = authEpoch;
  const p = await api('/v1/admin/policies/effective').then(r => r.json());
  if (epoch !== authEpoch) return;
  $('#policy-line').textContent = `${p.policy_id} v${p.version} · profile: ${p.profile} · mode: ${p.mode} · embeddings: ${p.embedder}`;
}
const showError = (m) => { const e = $('#error'); e.hidden = !m; e.textContent = m || ''; };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
const short = (id) => (id ? id.replace(/^sess_/, '').slice(0, 8) : '—');
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
const pill = (v) => el('span', { class: `pill ${v}` }, v);

// ---------------------------------------------------------------- overview
async function loadOverview() {
  const epoch = authEpoch;
  const [m, s] = await Promise.all([api('/v1/admin/metrics').then((r) => r.json()), api('/v1/admin/sessions').then((r) => r.json())]);
  if (epoch !== authEpoch) return;
  state.sessions = s.sessions;
  sessionBrowser?.updateSessions(s.sessions);
  $('#policy-line').textContent = `${m.policy.id} v${m.policy.version} · profile: ${m.policy.profile} · mode: ${m.policy.mode} · embeddings: ${m.policy.embedder}`;
  const d = m.decisions, ev = m.events, ss = m.sessions;
  const kpis = [
    ['Decisions: allow', d.allow ?? 0, 'good'], ['Decisions: deny', d.deny ?? 0, d.deny ? 'bad' : ''], ['Approvals required', d.require_approval ?? 0, 'warn'],
    ['Active sessions', ss.active ?? 0, 'good'], ['Closed sessions (terminated)', ss.terminated ?? 0, ss.terminated ? 'bad' : ''], ['Blocked sessions', ss.blocked ?? 0, ss.blocked ? 'bad' : ''],
    ['In review / awaiting approval', (ss.reviewing ?? 0) + (ss.awaiting_approval ?? 0), 'warn'],
    ['Content redacted / blocked', `${ev['content.redacted'] ?? 0} / ${ev['content.blocked'] ?? 0}`, ''],
    ['Threat feed hits', m.threat_feed_blocks, m.threat_feed_blocks ? 'bad' : ''],
    ['Topics detected / assigned', `${ev['topic.candidate_detected'] ?? 0} / ${ev['topic.assigned'] ?? 0}`, ''],
    ['Tokens spent', num(m.spend.tokens_spent), ''], ['Cost', m.spend.cost_usd_micros ? `$${(m.spend.cost_usd_micros / 1e6).toFixed(4)}` : 'unpriced', ''],
    ['Model calls / gateway refusals', `${ev['model.completed'] ?? 0} / ${(ev['model.denied'] ?? 0) + (ev['budget.denied'] ?? 0)}`, ''],
    ['Tools: start / end / failure', `${ev['tool.started'] ?? 0} / ${ev['tool.completed'] ?? 0} / ${ev['tool.failed'] ?? 0}`, ''],
  ];
  const k = clear($('#kpis'));
  for (const [label, val, tone] of kpis) k.append(el('div', { class: `kpi ${tone}` }, el('b', {}, val), el('span', {}, label)));

  const names = { decision_total: 'Tool decision (total)', deterministic: 'Deterministic checks', topic_detection: 'Topic detection (embedding)', judge_jev: 'Jev (semantic assessment)', guardian: 'Session supervisor (OpenAI Luna Low)', model_provider: 'Model provider' };
  const tb = clear($('#latency tbody'));
  for (const [key, label] of Object.entries(names)) { const x = m.latency_ms[key]; tb.append(el('tr', {}, el('td', {}, label), el('td', { class: 'num' }, x.count), el('td', { class: 'num' }, num(x.p50)), el('td', { class: 'num' }, num(x.p95)), el('td', { class: 'num' }, num(x.max)))); }
  const rt = clear($('#reasons tbody'));
  if (!m.deny_reasons.length) rt.append(el('tr', {}, el('td', { class: 'empty' }, 'no refusals')));
  for (const r of m.deny_reasons) rt.append(el('tr', {}, el('td', {}, el('span', { class: 'tag' }, r.reasons)), el('td', { class: 'num' }, r.count)));

  const st = clear($('#sessions tbody'));
  for (const x of s.sessions) {
    st.append(el('tr', {},
      el('td', { class: 'mono' }, short(x.id)), el('td', {}, x.user), el('td', {}, pill(x.status), x.status_reason ? el('small', { class: 'note' }, ` ${x.status_reason}`) : null),
      el('td', {}, x.topics.filter((t) => t.state !== 'dismissed').map((t) => el('span', { class: 'tag', title: `${t.state} · score ${t.score.toFixed(2)}` }, `${t.topic_id}${t.state === 'confirmed' ? ' ✓' : '?'}`)), x.guardian ? el('span', { class: 'tag' }, 'supervisor') : null),
      el('td', { class: 'num' }, `${num(x.budget.tokens_spent)}${x.budget.token_limit ? ' / ' + num(x.budget.token_limit) : ''}`),
      el('td', { class: 'num' }, `${x.budget.tool_attempts}${x.budget.tool_attempt_limit ? ' / ' + x.budget.tool_attempt_limit : ''}`),
      el('td', { class: 'row-actions' },
        el('button', { onclick: () => openSession(x.id) }, 'conversation'),
        el('button', { onclick: () => { selectTab('events'); $('#f-session').value = x.id; renderTimeline(); } }, 'audit'),
        x.status !== 'terminated' && x.status !== 'blocked' ? el('button', { class: 'danger', onclick: () => act(`/v1/admin/sessions/${x.id}/revoke`) }, 'block') : null,
        x.status === 'blocked' ? el('button', { class: 'ok', onclick: () => act(`/v1/admin/sessions/${x.id}/resume`) }, 'resume') : null)));
  }
  const ap = clear($('#approvals'));
  if (!s.pending_approvals.length) ap.append(el('p', { class: 'empty' }, 'none'));
  for (const a of s.pending_approvals) ap.append(el('div', {}, el('span', { class: 'tag' }, a.tool), ` session ${short(a.session_id)} · ${a.reason_codes} · expires ${fmtTime(a.expires_at)}`, el('p', { class: 'note' }, 'The user grants approval in the Pi interface, not the administrator.')));
  const rv = clear($('#reviews'));
  if (!s.open_reviews.length) rv.append(el('p', { class: 'empty' }, 'none'));
  for (const r of s.open_reviews) rv.append(el('div', { class: 'row-actions' }, `session ${short(r.session_id)} · event #${r.seq} `, el('button', { class: 'ok', onclick: () => review(r.id, 'no_violation') }, 'no violation'), el('button', { class: 'danger', onclick: () => review(r.id, 'violation') }, 'violation')));

  const sel = $('#f-session'); const cur = sel.value;
  clear(sel).append(el('option', { value: '' }, 'all'));
  for (const x of s.sessions) sel.append(el('option', { value: x.id }, `${short(x.id)} · ${x.user}`));
  sel.value = cur;
}

async function act(path) { try { await api(path, { method: 'POST' }); await loadOverview(); } catch (e) { showError(e.message); } }
async function review(id, outcome) {
  const note = prompt('Justification against the policy in force (required):');
  if (!note || note.length < 3) return;
  try { await api(`/v1/admin/topic-reviews/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome, note }) }); await loadOverview(); } catch (e) { showError(e.message); }
}

// ---------------------------------------------------------------- events
const NOISE = /^(content\.|budget\.|model\.released|topic\.(dismissed|checked))/;
function describe(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'decision.allowed': return [`Allowed: ${e.tool}`, summarizeArgs(d.args)];
    case 'decision.denied': return [`Refused: ${e.tool}`, `${e.reason_codes.join(', ')} · ${d.session_action}`];
    case 'approval.requested': return [`Approval required: ${e.tool}`, e.reason_codes.join(', ')];
    case 'approval.approved': return ['The user approved', ''];
    case 'approval.rejected': return ['The user rejected', ''];
    case 'topic.candidate_detected': return [`Topic detected: ${d.topic_id}`, `similarity ${d.score} · ${d.embedder}`];
    case 'topic.confirmed': return [`Topic confirmed: ${d.topic_id}`, ''];
    case 'topic.assigned': return [`Assigned topic policy: ${d.topic_id}`, 'trusted user configuration'];
    case 'execution.claimed': return ['Execution grant consumed', `one-time · ${d.tool}`];
    case 'guardian.started': return ['Session supervisor started', (d.topics || []).join(', ')];
    case 'guardian.reviewed': return [`Supervisor: ${d.verdict}`, `${d.event_kind} · ${d.latency_ms} ms${d.reason_code ? ' · ' + d.reason_code : ''}`];
    case 'session.terminated': return ['Session closed (terminated)', e.reason_codes.join(', ')];
    case 'session.reviewing': return ['Session held for review', ''];
    case 'judge.evaluated': return [`Jev: ${d.verdict}`, `${d.tool} · ${d.latency_ms} ms · ${d.source}`];
    case 'model.completed': return ['Model call', `${(d.usage && (d.usage.prompt_tokens + d.usage.completion_tokens)) || '?'} tokens · ${d.provider_ms} ms`];
    case 'model.denied': case 'budget.denied': return [`Model gateway refusal`, e.reason_codes.join(', ')];
    case 'content.redacted': case 'content.blocked': return [e.type === 'content.blocked' ? 'Content blocked' : 'Content redacted', (d.findings || []).map((f) => f.type).join(', ')];
    case 'tool.started': case 'tool.completed': case 'tool.failed': return [`Execution: ${e.type.slice(5)}`, e.request_id || ''];
    default: return [e.type, ''];
  }
}
const summarizeArgs = (a) => (a ? JSON.stringify(a).slice(0, 110) : '');
const tone = (e) => (e.effect === 'deny' || e.type === 'session.terminated' ? 'deny' : e.effect === 'require_approval' ? 'require_approval' : e.effect === 'allow' ? 'allow' : 'info');

const FAILED = new Set(['blocked', 'terminated', 'reviewing']);
function renderTimeline() {
  const hide = $('#f-hide').checked; const sid = $('#f-session').value; const ty = $('#f-type').value.trim();
  const status = $('#f-status').value; const reason = $('#f-reason').value; const effect = $('#f-effect').value;
  const re = ty ? new RegExp('^' + ty.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
  const statusOf = new Map(state.sessions.map((x) => [x.id, x.status]));
  // the reason list is built from what the log actually contains, so it never offers an empty choice
  const reasons = [...new Set(state.events.flatMap((e) => e.reason_codes))].sort();
  const rsel = $('#f-reason');
  if (rsel.options.length - 1 !== reasons.length) { const cur = rsel.value; clear(rsel).append(el('option', { value: '' }, 'all')); for (const r of reasons) rsel.append(el('option', { value: r }, r)); rsel.value = cur; }
  const ok = (e) => {
    if (sid && e.session_id !== sid) return false;
    if (hide && NOISE.test(e.type)) return false;
    if (re && !re.test(e.type)) return false;
    if (reason && !e.reason_codes.includes(reason)) return false;
    if (effect && e.effect !== effect) return false;
    if (status) {
      const st = statusOf.get(e.session_id);
      if (!st) return false;
      if (status === 'failed' ? !FAILED.has(st) : st !== status) return false;
    }
    return true;
  };
  const rows = state.events.filter(ok);
  if (state.selected && !rows.some(e => e.id === state.selected)) {
    state.selected = null; clear($('#detail')).append(el('p', {class: 'empty'}, 'Select an event to view its reason, versions, and evidence.'));
  }
  $('#f-count').textContent = `${rows.length} of ${state.events.length} events`;
  const ol = clear($('#timeline'));
  for (const e of rows.slice(0, 400)) {
    const [t, sub] = describe(e);
    ol.append(el('li', { class: state.selected === e.id ? 'sel' : '', tabindex: 0, onclick: () => { state.selected = e.id; renderTimeline(); renderDetail(e); }, onkeydown: (k) => { if (k.key === 'Enter') k.target.click(); } },
      el('time', {}, fmtTime(e.ts)), el('span', { class: `dot ${tone(e)}` }), el('div', {}, el('strong', {}, t), el('small', {}, `${short(e.session_id)} ${statusOf.get(e.session_id) ? '· ' + statusOf.get(e.session_id) : ''} ${sub || ''}`))));
  }
  if (!rows.length) ol.append(el('li', {}, el('span', {}), el('span', {}), el('small', {}, 'No events match this filter.')));
}
function renderDetail(e) {
  const d = clear($('#detail'));
  const [t] = describe(e);
  const dd = e.data || {};
  const facts = [['Event', e.type], ['Session', e.session_id], ['User', e.user], ['Server time', new Date(e.ts).toISOString()], ['Tool', e.tool], ['Effect', e.effect], ['Reasons', e.reason_codes.join(', ')], ['request_id', e.request_id], ['decision_id', e.decision_id], ['Policy version', dd.policy_version], ['Profile', dd.profile], ['Session state after decision', dd.session_action], ['Supervisor evidence', dd.evidence], ['Was the event executed?', e.type === 'decision.denied' ? 'execution denied — separate tool.* events show executor status' : null]].filter(([, v]) => v);
  d.append(el('h2', {}, t), el('dl', {}, facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])));
  d.append(el('pre', {}, JSON.stringify(dd, null, 2)));
}
async function loadEvents() {
  const epoch = authEpoch;
  const r = await api('/v1/admin/events?limit=600').then((x) => x.json());
  if (epoch !== authEpoch) return;
  state.events = r.events; state.lastId = Math.max(0, ...r.events.map(e => e.id));
  seen.clear(); for (const e of r.events) seen.add(e.id);
  if (state.tab === 'events') renderTimeline();
}
function openSession(id) {
  selectTab('sessions');
  sessionBrowser?.selectSession(id);
}
function setLive(connected) {
  $('#live').classList.toggle('on', connected);
  $('#live').textContent = connected ? '●' : '○';
  $('#live').setAttribute('aria-label', connected ? 'Event stream connected' : 'Event stream disconnected');
  $('#live').title = connected ? 'Sessions are updating live' : 'Live connection unavailable';
}
function ingestLiveEvent(e) {
  if (!e || !Number.isInteger(e.id)) return;
  if (!seen.has(e.id)) {
    seen.add(e.id); state.events.unshift(e);
    if (state.events.length > 2000) { const old = state.events.pop(); seen.delete(old.id); }
    sessionBrowser?.ingestEvent(e);
  }
  state.lastId = Math.max(state.lastId, e.id);
  schedule();
}
const retryDelay = signal => new Promise(resolve => {
  const done = () => { clearTimeout(handle); signal.removeEventListener('abort', done); resolve(); };
  const handle = setTimeout(done, 2000);
  signal.addEventListener('abort', done, {once: true});
  if (signal.aborted) done();
});
// One authenticated stream is shared by the session rail and audit view. A credential change aborts it.
async function startLive() {
  const generation = ++streamGeneration;
  streamAbort?.abort();
  const controller = new AbortController(); streamAbort = controller;
  try { await loadEvents(); }
  catch (error) {
    if (generation !== streamGeneration || controller.signal.aborted) return;
    showError(error.message);
    if (error.message.startsWith('No access')) { setLive(false); return; }
  }
  while (!controller.signal.aborted && generation === streamGeneration) {
    try {
      const res = await fetch(`/v1/admin/stream?since=${state.lastId}`, {
        headers: {Authorization: `Bearer ${token}`}, signal: controller.signal,
      });
      if (generation !== streamGeneration || controller.signal.aborted) return;
      if (res.status === 401 || res.status === 403) { setLive(false); showError('No access: enter the administrator token.'); return; }
      if (!res.ok || !res.body) throw new Error('Stream unavailable');
      setLive(true);
      const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        for (;;) {
          const {value, done} = await reader.read();
          if (done || generation !== streamGeneration || controller.signal.aborted) break;
          buffer = (buffer + decoder.decode(value, {stream: true})).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (payload) ingestLiveEvent(JSON.parse(payload));
          }
        }
      } finally { reader.releaseLock(); }
    } catch (error) {
      if (generation !== streamGeneration || controller.signal.aborted) return;
    }
    if (generation !== streamGeneration || controller.signal.aborted) return;
    setLive(false); await retryDelay(controller.signal);
  }
}
let timer;
function schedule() {
  clearTimeout(timer);
  const epoch = authEpoch;
  timer = setTimeout(async () => {
    try {
      if (state.tab === 'overview' || state.tab === 'events') await loadOverview();
      else await loadSessionList();
      if (epoch === authEpoch && state.tab === 'events') renderTimeline();
    } catch (error) { if (epoch === authEpoch && error.name !== 'AbortError') showError(error.message); }
  }, 350);
}

// ---------------------------------------------------------------- policies
let editVersion, feedPolicyVersion, feedVersion;
const editorLoads = {}, editorBusy = { policy: 0, feed: 0 };
function setEditorBusy(kind, delta) {
  editorBusy[kind] += delta;
  for (const suffix of ['edit', 'publish', 'reload']) $(`#${kind}-${suffix}`).disabled = editorBusy[kind] > 0;
}
function loadEditor(kind) {
  if (editorLoads[kind]) return editorLoads[kind];
  const epoch = authEpoch;
  setEditorBusy(kind, 1);
  const status = $(`#${kind}-publish-result`);
  status.textContent = 'Wczytywanie aktualnej wersji…';
  editorLoads[kind] = (async () => {
    try {
      const p = await api(kind === 'policy' ? '/v1/admin/policies/editable' : '/v1/admin/threat-feed').then(r => r.json());
      if (epoch !== authEpoch) return;
      if (kind === 'policy') {
        editVersion = p.expected_version;
        $('#policy-edit').value = JSON.stringify(p.changes, null, 2);
        status.textContent = `Editing version ${editVersion}.`;
      } else {
        feedPolicyVersion = p.expected_policy_version; feedVersion = p.expected_feed_version;
        $('#feed-edit').value = JSON.stringify(p.feed, null, 2);
        status.textContent = `Feed v${feedVersion}, policy v${feedPolicyVersion}.`;
      }
    } catch (e) {
      if (epoch === authEpoch && e.name !== 'AbortError') status.textContent = 'Could not load the current version. Try again.';
      throw e;
    } finally {
      setEditorBusy(kind, -1);
      if (epoch === authEpoch) delete editorLoads[kind];
    }
  })();
  return editorLoads[kind];
}
const loadPolicyEditor = () => loadEditor('policy');
const loadFeedEditor = () => loadEditor('feed');
async function publishConfiguration(kind) {
  const epoch = authEpoch;
  const status = $(`#${kind}-publish-result`);
  setEditorBusy(kind, 1); showError('');
  try {
    const value = JSON.parse($(`#${kind}-edit`).value);
    const payload = kind === 'policy' ? { expected_version: editVersion, changes: value } :
      { expected_policy_version: feedPolicyVersion, expected_feed_version: feedVersion, feed: value };
    const p = await api(kind === 'policy' ? '/v1/admin/policies' : '/v1/admin/threat-feed', { method: 'POST', body: JSON.stringify(payload) }).then(r => r.json());
    if (epoch !== authEpoch) return;
    await Promise.all([loadPolicyEditor(), loadFeedEditor()]);
    await loadPolicies();
    status.textContent = `Published: policy v${p.policy_version}, feed v${p.feed_version}.`;
  } catch (e) { if (epoch === authEpoch && e.name !== 'AbortError') { status.textContent = 'Not published. Load the current version or correct the document.'; showError(e.message); } }
  finally { setEditorBusy(kind, -1); }
}
$('#policy-publish').addEventListener('click', () => publishConfiguration('policy'));
$('#feed-publish').addEventListener('click', () => publishConfiguration('feed'));
$('#policy-reload').addEventListener('click', () => loadPolicyEditor().catch(e => showError(e.message)));
$('#feed-reload').addEventListener('click', () => loadFeedEditor().catch(e => showError(e.message)));
async function loadPolicies() {
  const epoch = authEpoch;
  const p = await api(`/v1/admin/policies/effective${$('#eff-user').value ? '?user=' + $('#eff-user').value : ''}`).then((r) => r.json());
  if (epoch !== authEpoch) return;
  const f = clear($('#policy-facts'));
  for (const [k, v] of [['Policy', `${p.policy_id} v${p.version}`], ['Mode', p.mode], ['Profile', p.profile], ['Threat feed', `${p.feed.catalog_id} v${p.feed.version} · ${p.feed.signatures} signatures`], ['Topic detector', p.embedder], ['User approvals', `${p.approvals.enabled ? 'enabled' : 'disabled'} · TTL ${p.approvals.ttl_seconds}s · ${p.approvals.eligible_reason_codes.join(', ')}`], ['Corrections after refusal', `up to ${p.denials.max_correction_attempts} for ${p.denials.allow_correction_for.join(', ')}`]]) f.append(el('dt', {}, k), el('dd', {}, v));
  const sel = $('#eff-user'); if (!sel.options.length) { for (const u of p.users) sel.append(el('option', { value: u }, u)); sel.value = p.users[0]; return loadPolicies(); }
  $('#effective').textContent = JSON.stringify(p.effective, null, 2);
  const t = clear($('#topics')); t.append(el('tr', {}, el('th', {}, 'Topic'), el('th', {}, 'Policy'), el('th', {}, 'Examples')));
  for (const x of p.topics) t.append(el('tr', {}, el('td', {}, el('span', { class: 'tag' }, x.id)), el('td', {}, x.policy_id), el('td', { class: 'num' }, x.examples)));
  $('#policy-line').textContent = `${p.policy_id} v${p.version} · profile: ${p.profile} · mode: ${p.mode} · embeddings: ${p.embedder}`;
  const names = Object.keys(p.profiles);
  const pr = clear($('#profiles'));
  pr.append(el('tr', {}, el('th', {}, 'Setting'), names.map((n) => el('th', {}, n === p.profile ? `${n} (active)` : n))));
  for (const key of Object.keys(p.profiles[names[0]])) pr.append(el('tr', {}, el('td', {}, key), names.map((n) => el('td', { class: n === p.profile ? 'cur' : '' }, String(p.profiles[n][key])))));
  if (editVersion === undefined) await loadPolicyEditor();
  if (feedVersion === undefined) await loadFeedEditor();
}

// ---------------------------------------------------------------- shell
function selectTab(name) {
  if (!['sessions', 'overview', 'events', 'policies'].includes(name)) return;
  state.tab = name;
  sessionBrowser?.setVisible?.(name === 'sessions');
  $('#dashboard-heading').textContent = {sessions:'User sessions', overview:'Agent activity controls', events:'Event log', policies:'Policies and configuration'}[name];
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const n of ['sessions', 'overview', 'events', 'policies']) $(`#tab-${n}`).hidden = n !== name;
  refresh();
}
async function refresh() {
  try {
    showError('');
    if (state.tab === 'sessions') { await Promise.all([loadSessionList(), loadPolicySummary()]); await sessionBrowser?.refresh?.(); }
    if (state.tab === 'overview') await loadOverview();
    if (state.tab === 'events') { if (!state.events.length) await loadEvents(); await loadOverview().catch(() => {}); renderTimeline(); }
    if (state.tab === 'policies') await loadPolicies();
  } catch (e) { if (e.name !== 'AbortError') showError(e.message); }
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
$('#token').value = token;
$('#save-token').addEventListener('click', () => {
  authEpoch++; authAbort.abort(); authAbort = new AbortController();
  streamAbort?.abort(); clearTimeout(timer); sessionListLoad = null;
  token = $('#token').value.trim();
  try { sessionStorage.setItem('bw-admin', token); } catch { /* ignore */ }
  state.events = []; state.sessions = []; state.selected = null; state.lastId = 0; seen.clear();
  editVersion = undefined; feedVersion = undefined; feedPolicyVersion = undefined;
  for (const key of Object.keys(editorLoads)) delete editorLoads[key];
  clear($('#timeline')); clear($('#sessions tbody')); clear($('#detail')).append(el('p', {class:'empty'}, 'Select an event.'));
  for (const id of ['#kpis', '#policy-facts', '#effective', '#profiles', '#topics', '#reasons tbody', '#latency tbody', '#approvals', '#reviews']) clear($(id));
  $('#policy-edit').value = ''; $('#feed-edit').value = ''; $('#policy-line').textContent = 'Loading configuration…';
  $('#eff-user').replaceChildren(); $('#f-session').replaceChildren(el('option', {value:''}, 'all'));
  setLive(false); createSessionBrowser(); refresh(); startLive();
});
for (const id of ['#f-session', '#f-type', '#f-hide', '#f-status', '#f-reason', '#f-effect']) $(id).addEventListener('input', renderTimeline);
$('#f-reset').addEventListener('click', () => { for (const id of ['#f-session', '#f-type', '#f-status', '#f-reason', '#f-effect']) $(id).value = ''; $('#f-hide').checked = false; renderTimeline(); });
$('#eff-user').addEventListener('change', loadPolicies);
$('#export').addEventListener('click', async () => {
  try { const r = await api('/v1/admin/export'); const url = URL.createObjectURL(await r.blob()); const a = el('a', { href: url, download: 'blackwall-audit.jsonl' }); a.click(); URL.revokeObjectURL(url); } catch (e) { showError(e.message); }
});
if (!token) { token = 'demo-admin-token'; $('#token').value = token; }
createSessionBrowser();
// Deep links include #sessions/<session id> for the live conversation and the existing audit views.
const [hashPath, hashQuery] = location.hash.slice(1).split('?');
const [initialTab, initialSession] = hashPath.split('/');
const hq = new URLSearchParams(hashQuery || '');
if (['sessions', 'overview', 'events', 'policies'].includes(initialTab)) {
  selectTab(initialTab);
  if (hq.size) setTimeout(() => { if (hq.get('status')) $('#f-status').value = hq.get('status'); if (hq.get('effect')) $('#f-effect').value = hq.get('effect'); if (hq.get('reason')) { const r = $('#f-reason'); if (![...r.options].some((o) => o.value === hq.get('reason'))) r.append(el('option', { value: hq.get('reason') }, hq.get('reason'))); r.value = hq.get('reason'); } renderTimeline(); }, 1800);
  if (initialSession && initialTab === 'sessions') sessionBrowser.selectSession(decodeURIComponent(initialSession));
  if (initialSession && initialTab === 'events') setTimeout(() => { const sel = $('#f-session'); if (![...sel.options].some((o) => o.value === initialSession)) sel.append(el('option', { value: initialSession }, initialSession)); sel.value = initialSession; renderTimeline(); }, 1500);
} else refresh();
window.addEventListener('hashchange', () => {
  const [path] = location.hash.slice(1).split('?');
  const [name, id] = path.split('/');
  if (!['sessions', 'overview', 'events', 'policies'].includes(name)) return;
  selectTab(name);
  if (name === 'sessions' && id) sessionBrowser?.selectSession(decodeURIComponent(id));
});
startLive();
setInterval(() => {
  if (state.tab === 'overview') loadOverview().catch(() => {});
  else loadSessionList().catch(() => {});
}, 5000);
window.addEventListener('pagehide', () => { authAbort.abort(); streamAbort?.abort(); clearTimeout(timer); sessionBrowser?.destroy(); });
