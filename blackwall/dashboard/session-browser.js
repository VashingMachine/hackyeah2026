'use strict';

// Session browser for the admin dashboard. It renders only recorded evidence: content snapshots,
// explicitly released model messages, tool decisions and execution receipts. All untrusted values
// are passed through the dashboard's text-node helper (or textContent); never parsed as HTML.
(() => {
  const STATUS_OPTIONS = [
    ['', 'All statuses'], ['active', 'Active'], ['awaiting_approval', 'Awaiting approval'],
    ['reviewing', 'In review'], ['blocked', 'Blocked'], ['terminated', 'Terminated'],
  ];
  const STATUS_LABELS = {
    active: 'Active', awaiting_approval: 'Awaiting approval', reviewing: 'In review',
    blocked: 'Blocked', terminated: 'Terminated',
  };
  const NOISE = new Set();
  const TECHNICAL_DETAILS = new Set(['content.model_input', 'content.model_output', 'guardian.started', 'model.completed', 'execution.claimed', 'model.released', 'topic.checked']);
  const INTERVENTIONS = new Set([
    'decision.allowed', 'decision.denied', 'approval.requested', 'approval.approved', 'approval.rejected',
    'approval.expired', 'approval.invalidated', 'execution.claim_denied', 'content.redacted', 'content.blocked',
    'guardian.reviewed', 'guardian.unavailable', 'session.reviewing', 'session.terminated', 'session.blocked',
    'session.resumed', 'model.denied', 'budget.denied', 'topic.detection_failed',
  ]);

  const text = (value) => value == null ? '' : String(value);
  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const eventData = (event) => asObject(event && event.data);
  const eventId = (event) => Number.isSafeInteger(Number(event && event.id)) ? Number(event.id) : null;
  const sortEvents = (events) => [...events].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  const reasonsOf = (event) => {
    const data = eventData(event);
    const value = event && event.reason_codes;
    const reasons = Array.isArray(value) ? value : (Array.isArray(data.reason_codes) ? data.reason_codes : []);
    if (reasons.length) return [...new Set(reasons.map(text).filter(Boolean))];
    return data.reason_code ? [text(data.reason_code)] : [];
  };
  const policyOf = (event) => {
    const data = eventData(event);
    const attribution = asObject(event && event.policy_attribution);
    const version = attribution.policy_version ?? data.policy_version;
    const id = attribution.policy_id ?? data.policy_id;
    const profile = attribution.profile ?? data.profile;
    return {
      version: version == null ? '' : text(version),
      id: id == null ? '' : text(id),
      profile: profile == null ? '' : text(profile),
      source: attribution.source === 'event_time' ? 'event_time' : '',
    };
  };
  const timestamp = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Time unavailable';
    try { return new Date(n).toLocaleString('en-GB', { hour12: false }); }
    catch { return 'Time unavailable'; }
  };

  function decisionText(event) {
    const data = eventData(event);
    const tool = text(event.tool || data.tool || 'tool');
    switch (event.type) {
      case 'decision.allowed': return { title: `Blackwall allowed: ${tool}`, kind: 'allow' };
      case 'decision.denied': return { title: `Blackwall refused: ${tool}`, kind: 'deny' };
      case 'approval.requested': return { title: `Blackwall requires approval for: ${tool}`, kind: 'require_approval' };
      case 'approval.approved': return { title: 'User approved a single operation', kind: 'allow' };
      case 'approval.rejected': return { title: 'User rejected the operation', kind: 'deny' };
      case 'approval.expired': return { title: 'Approval expired', kind: 'deny' };
      case 'approval.invalidated': return { title: 'Pending approval was invalidated', kind: 'deny' };
      case 'execution.claim_denied': return { title: 'Blackwall refused to consume the grant', kind: 'deny' };
      case 'content.redacted': return { title: 'Blackwall redacted content', kind: 'require_approval' };
      case 'content.blocked': return { title: 'Blackwall blocked content', kind: 'deny' };
      case 'guardian.reviewed': {
        const verdict = text(data.verdict);
        const label = verdict === 'violation' ? 'violation' : verdict === 'uncertain' ? 'uncertain result' : 'no violation detected';
        return { title: `Guardian: ${label}`, kind: verdict === 'violation' ? 'deny' : verdict === 'uncertain' ? 'require_approval' : 'info' };
      }
      case 'guardian.unavailable': return { title: 'Guardian was unavailable; the control blocked the request', kind: 'deny' };
      case 'session.reviewing': return { title: 'Session held for administrator review', kind: 'require_approval' };
      case 'session.terminated': return { title: 'Session terminated by policy', kind: 'deny' };
      case 'session.blocked': return { title: 'Session blocked', kind: 'deny' };
      case 'session.resumed': return { title: 'Administrator resumed the session', kind: 'allow' };
      case 'model.denied': return { title: 'Blackwall blocked the model request', kind: 'deny' };
      case 'budget.denied': return { title: 'Blackwall stopped the operation at the budget limit', kind: 'deny' };
      case 'topic.detection_failed': return { title: 'Topic detection failed; supervision stopped the event', kind: 'deny' };
      case 'model.message_released':
        if (data.origin === 'blackwall_refusal') return { title: 'Blackwall released a refusal instead of a model response', kind: 'deny' };
        return null;
      default: return { title: text(event.type || 'Blackwall event'), kind: 'info' };
    }
  }

  function releasedText(data) {
    for (const key of ['content', 'text', 'message']) if (typeof data[key] === 'string') return data[key];
    return '';
  }

  // Keep every unique audit row. Never deduplicate content by text: identical prompts can be
  // separate user actions, and legacy model_output rows may contain tool-call arguments.
  function contentItems(events, showTechnical = false) {
    return sortEvents(events).filter((event) => showTechnical || (!NOISE.has(event.type) && !TECHNICAL_DETAILS.has(event.type)));
  }

  function explanationFor(event) {
    const data = eventData(event);
    const reasons = reasonsOf(event);
    const policy = policyOf(event);
    const effect = text(event.effect || data.effect || (event.type === 'decision.allowed' ? 'allow' : event.type === 'decision.denied' || data.origin === 'blackwall_refusal' ? 'deny' : ''));
    const ids = [];
    if (event.request_id) ids.push(`request ${event.request_id}`);
    if (event.decision_id || data.decision_id) ids.push(`decision ${event.decision_id || data.decision_id}`);
    if (data.approval_id) ids.push(`approval ${data.approval_id}`);
    if (data.review_id) ids.push(`review ${data.review_id}`);
    const metadata = [];
    if (effect) metadata.push(`effect: ${effect}`);
    if (reasons.length) metadata.push(`reasons: ${reasons.join(', ')}`);
    if (policy.version) metadata.push(`policy v${policy.version}${policy.id ? ` · ${policy.id}` : ''}${policy.source ? ' · policy at event time' : ''}`);
    else metadata.push('policy version: no attribution in this record');
    if (policy.profile) metadata.push(`profile: ${policy.profile}`);
    if (data.policy_id && text(data.policy_id) !== policy.id) metadata.push(`topic rule: ${text(data.policy_id)}`);
    if (ids.length) metadata.push(ids.join(' · '));
    return { ...decisionText(event), reasons, policy, effect, metadata };
  }

  function safeElement(factory, tag, props = {}, ...children) {
    if (factory) return factory(tag, props, ...children);
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child != null) node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
    return node;
  }

  function create(options = {}) {
    const root = options.root;
    const api = options.api;
    const make = options.el;
    if (!root || typeof api !== 'function') throw new TypeError('BlackwallSessions.create requires root and api.');

    const state = {
      sessions: [], selectedId: null, paused: false, following: true, visible: true, unread: new Map(),
      events: new Map(), seen: new Set(), snapshotId: null, nextCursor: null, hasMore: false,
      selectionNonce: 0, refreshNonce: 0, controller: null, loading: false, olderLoading: false, destroyed: false,
    };
    const isVisible = () => state.visible && (typeof options.isActive !== 'function' || Boolean(options.isActive()));
    const clear = (node) => { node.replaceChildren(); return node; };
    const write = (node, value) => { node.textContent = text(value); };
    const panel = safeElement(make, 'div', { class: 'sb-shell' });
    const sidebar = safeElement(make, 'aside', { class: 'sb-sidebar', 'aria-label': 'Sessions' });
    const filterbar = safeElement(make, 'div', { class: 'sb-toolbar' });
    const search = safeElement(make, 'input', { class: 'sb-search', type: 'search', placeholder: 'Search sessions or users', 'aria-label': 'Search sessions or users' });
    const statusFilter = safeElement(make, 'select', { class: 'sb-status-filter', 'aria-label': 'Filter sessions by status' });
    for (const [value, label] of STATUS_OPTIONS) statusFilter.append(safeElement(make, 'option', { value }, label));
    filterbar.append(search, statusFilter);
    const sessionList = safeElement(make, 'div', { class: 'sb-session-list', role: 'listbox', 'aria-label': 'Session list' });
    sidebar.append(filterbar, sessionList);

    const main = safeElement(make, 'section', { class: 'sb-main', 'aria-label': 'Session activity' });
    const mainToolbar = safeElement(make, 'div', { class: 'sb-main-toolbar' });
    const heading = safeElement(make, 'h2', { class: 'sb-heading' }, 'Select a session');
    const loadOlderButton = safeElement(make, 'button', { class: 'sb-load-older', type: 'button', disabled: true }, 'Load older events');
    const pauseButton = safeElement(make, 'button', { class: 'sb-pause', type: 'button', 'aria-pressed': 'false' }, 'Pause updates');
    const followButton = safeElement(make, 'button', { class: 'sb-follow', type: 'button', 'aria-pressed': 'true' }, 'Follow latest');
    const technicalLabel = safeElement(make, 'label', { class: 'sb-technical-toggle' });
    const technicalToggle = safeElement(make, 'input', { type: 'checkbox', 'aria-label': 'Show technical details' });
    technicalLabel.append(technicalToggle, ' Technical details');
    const notice = safeElement(make, 'p', { class: 'sb-notice', role: 'status', 'aria-live': 'polite' });
    mainToolbar.append(heading, loadOlderButton, pauseButton, followButton, technicalLabel);
    const timeline = safeElement(make, 'div', { class: 'sb-timeline', role: 'log', 'aria-live': 'off', 'aria-label': 'Events and recorded conversation excerpts' });
    main.append(mainToolbar, notice, timeline);
    panel.append(sidebar, main);
    clear(root).append(panel);

    let searchValue = '';
    function notifyUnread() {
      if (typeof options.onUnreadChange !== 'function') return;
      options.onUnreadChange(Object.fromEntries(state.unread));
    }
    function setUnread(sessionId, amount) {
      if (!sessionId) return;
      if (amount > 0) state.unread.set(sessionId, amount);
      else state.unread.delete(sessionId);
      notifyUnread();
    }
    function markRead(sessionId) { setUnread(sessionId, 0); }
    function eventsFor(sessionId) { return sortEvents([...(state.events.get(sessionId)?.values() || [])]); }
    function pruneCaches() {
      for (const [sessionId, rows] of state.events) {
        if (sessionId === state.selectedId || rows.size <= 200) continue;
        const orderedIds = [...rows.keys()].sort((a, b) => a - b);
        for (const id of orderedIds.slice(0, rows.size - 200)) {
          rows.delete(id);
          state.seen.delete(id);
        }
      }
      const unselected = [...state.events.entries()]
        .filter(([sessionId]) => sessionId !== state.selectedId)
        .sort((a, b) => {
          const newestA = Math.max(0, ...a[1].keys());
          const newestB = Math.max(0, ...b[1].keys());
          return newestB - newestA;
        });
      for (const [sessionId, rows] of unselected.slice(200)) {
        for (const id of rows.keys()) state.seen.delete(id);
        state.events.delete(sessionId);
        state.unread.delete(sessionId);
      }
    }
    function mergeEvent(event) {
      const sessionId = event && event.session_id;
      const id = eventId(event);
      if (!sessionId || id === null || state.seen.has(id)) return false;
      state.seen.add(id);
      if (!state.events.has(sessionId)) state.events.set(sessionId, new Map());
      state.events.get(sessionId).set(id, event);
      pruneCaches();
      return true;
    }
    function appendMetadata(event) {
      const sessionId = event.session_id;
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session && Number(event.ts) > Number(session.last_event_at || 0)) session.last_event_at = Number(event.ts);
    }
    function renderSessions() {
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      const focusedSessionId = activeElement && sessionList.contains(activeElement)
        ? activeElement.closest('[data-session-id]')?.getAttribute('data-session-id') : null;
      const term = searchValue.trim().toLocaleLowerCase('en-GB');
      const status = statusFilter.value;
      const filtered = state.sessions.filter((session) => {
        if (status && session.status !== status) return false;
        if (!term) return true;
        return `${session.id} ${session.user} ${session.status} ${session.status_reason || ''}`.toLocaleLowerCase('en-GB').includes(term);
      }).sort((a, b) => sessionActivity(b) - sessionActivity(a));
      clear(sessionList);
      if (!filtered.length) {
        sessionList.append(safeElement(make, 'p', { class: 'sb-empty' }, 'No sessions match this filter.'));
        return;
      }
      for (const session of filtered) {
        const unread = state.unread.get(session.id) || 0;
        const button = safeElement(make, 'button', {
          class: `sb-session${session.id === state.selectedId ? ' is-selected' : ''}${unread ? ' has-unread' : ''}`,
          type: 'button', role: 'option', 'aria-selected': session.id === state.selectedId ? 'true' : 'false',
          'data-session-id': session.id,
          'aria-label': `${session.user || 'user'} · ${session.status || 'unknown status'}${unread ? ` · ${unread} unread events` : ''}`,
          onclick: () => selectSession(session.id),
        });
        button.append(
          safeElement(make, 'span', { class: 'sb-session-head' },
            safeElement(make, 'strong', { class: 'sb-session-user' }, session.user || 'Unknown user'),
          safeElement(make, 'span', { class: `sb-session-status status-${/^[a-z_]+$/.test(text(session.status)) ? session.status : 'unknown'}` }, STATUS_LABELS[session.status] || 'Unknown status')),
          safeElement(make, 'span', { class: 'sb-session-id' }, session.id),
          safeElement(make, 'span', { class: 'sb-session-activity' }, `Activity: ${timestamp(sessionActivity(session))}`),
        );
        if (unread) button.append(safeElement(make, 'span', { class: 'sb-unread', 'aria-label': `${unread} unread events` }, unread > 99 ? '99+' : unread));
        sessionList.append(button);
      }
      if (focusedSessionId) {
        const replacement = [...sessionList.querySelectorAll('[data-session-id]')]
          .find((button) => button.getAttribute('data-session-id') === focusedSessionId);
        if (replacement && typeof replacement.focus === 'function') replacement.focus({ preventScroll: true });
      }
    }

    function fragmentIsTruncated(event) {
      const data = eventData(event);
      return typeof data.text === 'string' && Number(data.chars) > data.text.length;
    }
    function renderIntervention(event) {
      const releasedRefusal = event.type === 'model.message_released' && eventData(event).origin === 'blackwall_refusal';
      if (!INTERVENTIONS.has(event.type) && !releasedRefusal) return null;
      const info = explanationFor(event);
      const props = { class: `sb-intervention tone-${info.kind}`, 'aria-label': 'Blackwall action' };
      if (['allow', 'deny', 'require_approval'].includes(info.kind)) props['data-effect'] = info.kind;
      const card = safeElement(make, 'aside', props);
      card.append(safeElement(make, 'strong', { class: 'sb-intervention-title' }, info.title));
      if (info.reasons.length) card.append(safeElement(make, 'span', { class: 'sb-intervention-reasons' }, `Reasons: ${info.reasons.join(', ')}`));
      else if (info.kind === 'deny' || info.kind === 'require_approval') card.append(safeElement(make, 'span', { class: 'sb-intervention-reasons' }, 'Reason codes are not recorded in this event.'));
      const meta = info.metadata.filter((value) => !value.startsWith('reasons:'));
      if (meta.length) card.append(safeElement(make, 'small', { class: 'sb-policy-version' }, meta.join(' · ')));
      return card;
    }
    function itemDescription(event) {
      const data = eventData(event);
      switch (event.type) {
        case 'content.user_input': return { role: 'user', actor: 'User · recorded input', body: typeof data.text === 'string' ? data.text : '', userSnapshot: true };
        case 'content.tool_output': return { role: 'tool', actor: 'Tool output · excerpt submitted for inspection', body: typeof data.text === 'string' ? data.text : '', snapshot: true };
        case 'content.model_input': return { role: 'system', actor: 'Model input · inspection record', body: typeof data.text === 'string' ? data.text : '', snapshot: true };
        case 'content.model_output': return { role: 'system', actor: 'Model output · inspection record, not confirmation of delivery', body: typeof data.text === 'string' ? data.text : '', snapshot: true };
        case 'model.message_released': {
          const content = releasedText(data);
          const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
          const callText = calls.map((call) => {
            const fn = asObject(asObject(call).function);
            return `${text(fn.name || call.name || 'tool')}(${text(fn.arguments || call.arguments || '')})`;
          });
          return { role: 'assistant', actor: data.origin === 'blackwall_refusal' ? 'Blackwall · refusal released to client' : 'Assistant · message released by Blackwall', body: content, extra: callText.length ? `Tool proposals: ${callText.join('\n')}` : '' };
        }
        case 'decision.allowed': case 'decision.denied': case 'approval.requested': {
          const tool = text(event.tool || data.tool || 'tool');
          let args = '';
          try { args = data.args == null ? '' : JSON.stringify(data.args, null, 2); } catch { args = '[arguments unavailable]'; }
          return { role: 'tool', actor: `Tool operation · ${tool}`, body: args };
        }
        case 'tool.started': case 'tool.completed': case 'tool.failed': return { role: 'tool', actor: `Executor · ${text(event.tool || data.tool || 'tool')} · ${event.type.slice('tool.'.length)}`, body: data.error || data.exit_code != null ? `Details: ${text(data.error || `exit code ${data.exit_code}`)}` : '' };
        case 'execution.claimed': return { role: 'tool', actor: `Grant consumed · ${text(event.tool || data.tool || 'tool')}`, body: 'The one-time grant was claimed before the executor started.' };
        case 'topic.candidate_detected': return { role: 'system', actor: `Topic candidate · ${text(data.topic_id)}`, body: `Similarity ${text(data.score)}. A candidate alone is not a violation verdict.` };
        case 'topic.confirmed': case 'topic.assigned': return { role: 'system', actor: `Topic label · ${text(data.topic_id)}`, body: event.type === 'topic.assigned' ? 'Trusted assignment from user configuration.' : 'Guardian confirmed the topic.' };
        case 'guardian.started': return { role: 'system', actor: 'Guardian · supervision started', body: Array.isArray(data.topics) ? data.topics.join(', ') : '' };
        case 'judge.evaluated': return { role: 'system', actor: `Jev · ${text(data.verdict)} · ${text(data.tool)}`, body: reasonsOf(event).join(', ') };
        case 'model.completed': return { role: 'system', actor: 'Model call completed', body: `${text(data.provider_model || data.alias || '')}${data.provider_ms != null ? ` · ${text(data.provider_ms)} ms` : ''}` };
        case 'model.released': return { role: 'system', actor: 'Gateway finished releasing the response', body: event.request_id ? `request ${text(event.request_id)} · details are in message model.message_released.` : 'Gateway audit marker; it does not contain message content.' };
        case 'topic.checked': return { role: 'system', actor: 'Topic detector check', body: `${text(data.input_kind || '')}${data.embedder ? ` · ${text(data.embedder)}` : ''}${data.latency_ms != null ? ` · ${text(data.latency_ms)} ms` : ''}` };
        case 'topic.dismissed': return { role: 'system', actor: `Guardian dismissed topic label · ${text(data.topic_id)}`, body: 'This is the supervision decision for this session.' };
        default: return null;
      }
    }
    function renderEvent(event, correlatedRelease) {
      const desc = itemDescription(event);
      if (!desc && !INTERVENTIONS.has(event.type)) return null;
      const item = safeElement(make, 'article', { class: `sb-event is-${desc ? desc.role : 'system'}${INTERVENTIONS.has(event.type) ? ' is-intervention' : ''}`, 'data-event-id': event.id });
      const metaParts = [timestamp(event.ts), event.seq != null ? `#${event.seq}` : '', event.type, event.request_id ? `request ${event.request_id}` : ''].filter(Boolean);
      item.append(safeElement(make, 'div', { class: 'sb-event-meta' }, metaParts.join(' · ')));
      if (desc) {
        item.append(safeElement(make, 'strong', { class: 'sb-event-actor' }, desc.actor));
        if (desc.body && desc.snapshot) {
          const details = safeElement(make, 'details', { class: 'sb-event-snapshot' });
          details.append(safeElement(make, 'summary', {}, 'Show redacted excerpt from audit'));
          details.append(safeElement(make, 'pre', { class: 'sb-event-text' }, desc.body));
          item.append(details);
        } else if (desc.body) item.append(safeElement(make, 'pre', { class: 'sb-event-text' }, desc.body));
        if (desc.extra) item.append(safeElement(make, 'pre', { class: 'sb-event-text sb-event-extra' }, desc.extra));
        if (fragmentIsTruncated(event)) item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, `Input content: ${text(eventData(event).chars)} characters. The recorded length differs due to redaction or truncation.`));
        if (event.type === 'model.message_released') {
          const data = eventData(event);
          item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, "Released message as recorded after redaction; it may differ from the model's raw response."));
          if (data.content_truncated) item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, 'The message content was truncated in the audit record.'));
          if (data.tool_calls_truncated) item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, 'The tool-call list was truncated in the audit record.'));
          if (Array.isArray(data.tool_calls) && data.tool_calls.some((call) => asObject(call).truncated)) item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, 'At least one tool argument set was truncated in the audit record.'));
        }
        if (correlatedRelease) item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, `Excerpt checked before releasing message #${text(correlatedRelease.seq)}.`));
        if (desc.userSnapshot) {
          item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, 'Redacted user input record; it may be truncated.'));
        } else if (desc.snapshot) {
          item.append(safeElement(make, 'small', { class: 'sb-event-caveat' }, 'Excerpt submitted for inspection; it may be redacted, truncated, or blocked before being shown to its recipient.'));
        }
      }
      const intervention = renderIntervention(event);
      if (intervention) item.append(intervention);
      return item;
    }
    function renderTimeline({ preserveScroll = false, prepend = false } = {}) {
      const previousHeight = timeline.scrollHeight;
      const previousTop = timeline.scrollTop;
      const openDetails = new Set([...timeline.querySelectorAll('details[open]')]
        .map((details) => details.closest('[data-event-id]')?.getAttribute('data-event-id')).filter(Boolean));
      clear(timeline);
      if (!state.selectedId) {
        timeline.append(safeElement(make, 'p', { class: 'sb-empty' }, 'Select a session to view its timeline.'));
        return;
      }
      if (state.loading) timeline.append(safeElement(make, 'p', { class: 'sb-loading' }, 'Loading latest events…'));
      const events = eventsFor(state.selectedId);
      const displayEvents = contentItems(events, technicalToggle.checked);
      const releaseBySeq = new Map();
      for (const event of events) {
        if (event.type !== 'model.message_released') continue;
        const seqs = eventData(event).inspection_event_seqs;
        if (Array.isArray(seqs)) for (const seq of seqs) releaseBySeq.set(Number(seq), event);
      }
      if (!displayEvents.length && !state.loading) timeline.append(safeElement(make, 'p', { class: 'sb-empty' }, 'No recorded events in this range.'));
      for (const event of displayEvents) {
        const row = renderEvent(event, releaseBySeq.get(Number(event.seq)));
        if (row) {
          if (openDetails.has(text(event.id))) {
            const details = row.querySelector('details');
            if (details) details.open = true;
          }
          timeline.append(row);
        }
      }
      loadOlderButton.hidden = !state.hasMore;
      loadOlderButton.disabled = !state.hasMore || state.olderLoading;
      loadOlderButton.textContent = state.olderLoading ? 'Loading…' : 'Load older events';
      if (preserveScroll) timeline.scrollTop = previousTop + (prepend ? Math.max(0, timeline.scrollHeight - previousHeight) : 0);
      else if (isVisible() && state.following && !state.paused) timeline.scrollTop = timeline.scrollHeight;
    }
    function updateToolbar() {
      pauseButton.setAttribute('aria-pressed', String(state.paused));
      pauseButton.textContent = state.paused ? 'Resume updates' : 'Pause updates';
      followButton.setAttribute('aria-pressed', String(state.following));
      write(notice, state.paused ? 'Updates are paused. New events are retained and will appear when updates resume.' : state.following ? 'Following the latest events.' : 'The view is paused at older activity. Select “Follow latest” to return to the bottom.');
    }
    function capturePage(response) {
      const rows = Array.isArray(response && response.events) ? response.events : [];
      const previousSnapshot = state.snapshotId;
      for (const event of rows) {
        const inserted = mergeEvent(event);
        // HTTP refresh may beat SSE. Count only newly arrived rows beyond the previous
        // snapshot; loading older history must not manufacture unread notifications.
        if (inserted && previousSnapshot != null && eventId(event) > previousSnapshot &&
          (state.paused || !state.following || !isVisible())) {
          setUnread(event.session_id, (state.unread.get(event.session_id) || 0) + 1);
        }
      }
      renderSessions();
      if (response && response.snapshot_id != null) state.snapshotId = Number(response.snapshot_id);
      else if (state.snapshotId == null) state.snapshotId = rows.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0);
      state.nextCursor = response && response.next_cursor != null ? Number(response.next_cursor) : null;
      state.hasMore = Boolean(response && response.has_more && state.nextCursor != null);
    }
    function sessionEventsUrl(sessionId, beforeId = null, freshSnapshot = false) {
      const params = new URLSearchParams({ limit: '100' });
      if (beforeId != null) params.set('before_id', String(beforeId));
      if (!freshSnapshot && state.snapshotId != null) params.set('snapshot_id', String(state.snapshotId));
      return `/v1/admin/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`;
    }
    async function selectSession(sessionId) {
      if (state.destroyed || !sessionId) return;
      state.selectionNonce += 1;
      state.refreshNonce += 1;
      const nonce = state.selectionNonce;
      if (state.controller) state.controller.abort();
      state.controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      state.selectedId = sessionId;
      pruneCaches();
      state.snapshotId = null; state.nextCursor = null; state.hasMore = false; state.loading = true; state.olderLoading = false;
      state.following = true;
      const session = state.sessions.find((item) => item.id === sessionId);
      write(heading, session ? `${session.user || 'Session'} · ${session.id}` : sessionId);
      if (typeof options.onSessionSelect === 'function') options.onSessionSelect(sessionId);
      renderSessions(); updateToolbar(); renderTimeline();
      try {
        const response = await api(sessionEventsUrl(sessionId), state.controller ? { signal: state.controller.signal } : {}).then((res) => res.json());
        if (state.destroyed || nonce !== state.selectionNonce || state.selectedId !== sessionId) return;
        capturePage(response);
        state.loading = false;
        if (isVisible() && state.following && !state.paused) markRead(sessionId);
        renderTimeline();
      } catch (error) {
        if (state.destroyed || nonce !== state.selectionNonce || (error && error.name === 'AbortError')) return;
        state.loading = false;
        clear(timeline).append(safeElement(make, 'p', { class: 'sb-error', role: 'alert' }, `Could not load session: ${error && error.message ? error.message : 'request failed'}`));
      }
    }
    async function loadOlder() {
      if (state.destroyed || !state.selectedId || !state.hasMore || state.olderLoading || state.nextCursor == null) return;
      const sessionId = state.selectedId, nonce = state.selectionNonce, controller = state.controller, snapshot = state.snapshotId;
      state.following = false; updateToolbar();
      state.olderLoading = true; renderTimeline({ preserveScroll: true });
      try {
        const response = await api(sessionEventsUrl(sessionId, state.nextCursor), controller ? { signal: controller.signal } : {}).then((res) => res.json());
        if (state.destroyed || nonce !== state.selectionNonce || sessionId !== state.selectedId) return;
        if (snapshot !== state.snapshotId) { state.olderLoading = false; renderTimeline({ preserveScroll: true }); return; }
        capturePage(response);
        state.olderLoading = false;
        renderTimeline({ preserveScroll: true, prepend: true });
      } catch (error) {
        if (state.destroyed || nonce !== state.selectionNonce || (error && error.name === 'AbortError')) return;
        state.olderLoading = false;
        updateToolbar();
        write(notice, `Could not load older events: ${error && error.message ? error.message : 'request failed'}`);
        renderTimeline({ preserveScroll: true, prepend: true });
      }
    }
    async function refreshSelected() {
      if (!state.selectedId) return;
      const id = state.selectedId;
      // Capture a fresh snapshot while preserving already loaded pages; the global live stream fills
      // the small interval between this snapshot and the latest SSE event.
      const nonce = state.selectionNonce;
      const refreshNonce = ++state.refreshNonce;
      try {
        const response = await api(sessionEventsUrl(id, null, true), {}).then((res) => res.json());
        if (state.destroyed || nonce !== state.selectionNonce || refreshNonce !== state.refreshNonce || state.selectedId !== id) return;
        capturePage(response);
        renderTimeline({ preserveScroll: !state.following });
      } catch (error) {
        if (state.destroyed || nonce !== state.selectionNonce || refreshNonce !== state.refreshNonce || (error && error.name === 'AbortError')) return;
        write(notice, `Could not refresh session: ${error && error.message ? error.message : 'request failed'}`);
      }
    }
    function ingestEvent(event) {
      if (state.destroyed || !mergeEvent(event)) return;
      const sessionId = event.session_id;
      appendMetadata(event);
      if (sessionId !== state.selectedId || state.loading || state.paused || !state.following || !isVisible()) {
        setUnread(sessionId, (state.unread.get(sessionId) || 0) + 1);
      } else {
        markRead(sessionId);
      }
      renderSessions();
      if (sessionId === state.selectedId && !state.paused && isVisible()) renderTimeline({ preserveScroll: !state.following });
    }
    function updateSessions(sessions = []) {
      if (state.destroyed) return;
      const previous = new Map(state.sessions.map((session) => [session.id, session]));
      state.sessions = Array.isArray(sessions) ? sessions.map((session) => {
        const prior = previous.get(session.id) || {};
        const merged = { ...prior, ...session };
        const activity = Math.max(Number(prior.last_event_at) || 0, Number(session.last_event_at) || 0);
        merged.last_event_at = activity || null;
        return merged;
      }) : [];
      renderSessions();
      const active = state.sessions.find((session) => session.id === state.selectedId);
      if (active) write(heading, `${active.user || 'Session'} · ${active.id} · ${STATUS_LABELS[active.status] || 'Unknown status'}`);
      else if (state.selectedId) write(heading, `${state.selectedId} · session is not in the list`);
    }
    function sessionActivity(session) {
      return Math.max(Number(session.last_event_at) || 0, Number(session.updated_at) || 0, Number(session.created_at) || 0);
    }
    function setPaused(paused) {
      state.paused = Boolean(paused);
      updateToolbar();
      if (!state.paused) {
        if (state.selectedId && state.following && isVisible()) markRead(state.selectedId);
        if (isVisible()) renderTimeline();
      }
    }
    function followLatest() {
      state.following = true;
      if (state.selectedId && isVisible()) markRead(state.selectedId);
      updateToolbar();
      if (isVisible() && !state.paused) { renderTimeline(); timeline.scrollTop = timeline.scrollHeight; }
    }
    function setVisible(visible) {
      state.visible = Boolean(visible);
      if (isVisible()) {
        if (state.selectedId && state.following && !state.paused) markRead(state.selectedId);
        renderSessions(); updateToolbar(); renderTimeline();
      }
    }
    function reset() {
      state.selectionNonce += 1;
      state.refreshNonce += 1;
      if (state.controller) state.controller.abort();
      state.controller = null; state.sessions = []; state.selectedId = null; state.snapshotId = null;
      state.nextCursor = null; state.hasMore = false; state.events.clear(); state.seen.clear(); state.unread.clear();
      state.loading = false; state.olderLoading = false; state.paused = false; state.following = true; state.visible = true;
      write(heading, 'Select a session'); updateToolbar(); renderSessions(); renderTimeline();
      notifyUnread();
    }
    function onScroll() {
      if (!isVisible()) return;
      const distance = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
      if (distance < 48 && !state.paused) {
        state.following = true;
        if (state.selectedId) markRead(state.selectedId);
        updateToolbar();
      } else if (distance >= 48 && state.selectedId) {
        state.following = false; updateToolbar();
      }
    }
    search.addEventListener('input', () => { searchValue = search.value; renderSessions(); });
    statusFilter.addEventListener('change', renderSessions);
    technicalToggle.addEventListener('change', () => renderTimeline());
    loadOlderButton.addEventListener('click', loadOlder);
    pauseButton.addEventListener('click', () => setPaused(!state.paused));
    followButton.addEventListener('click', followLatest);
    timeline.addEventListener('scroll', onScroll, { passive: true });

    for (const event of Array.isArray(options.events) ? options.events : []) mergeEvent(event);
    updateSessions(options.sessions || []);
    updateToolbar();

    return {
      updateSessions,
      ingestEvent,
      selectSession,
      setPaused,
      setVisible,
      loadOlder,
      refreshSelected,
      refresh: refreshSelected,
      reset,
      destroy() {
        if (state.destroyed) return;
        state.destroyed = true; state.selectionNonce += 1; state.refreshNonce += 1;
        if (state.controller) state.controller.abort();
        clear(root);
      },
    };
  }

  const api = { create, helpers: { reasonsOf, policyOf, contentItems, explanationFor } };
  if (typeof window !== 'undefined') window.BlackwallSessions = api;
  else if (typeof globalThis !== 'undefined') globalThis.BlackwallSessions = api;
})();
