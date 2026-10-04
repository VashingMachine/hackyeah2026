// Browser QA for the live session browser. Uses an isolated in-memory SQLite fixture,
// a private Fastify port, deterministic judges, and real HTTP/SSE routes.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
import { buildApp } from '../../src/server/app.ts';
import { makeFixture, CountingJudge, StubGuardian, ROOT } from '../helpers.ts';

const ADMIN = 'session-browser-qa-admin';
const checks = [];
const check = (name, passed, detail = '') => {
  checks.push({ name, result: passed ? 'PASS' : 'FAIL', detail });
  assert.ok(passed, `${name}${detail ? `: ${detail}` : ''}`);
};
const norm = s => (s ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const progress = label => process.stderr.write(`[dashboard-session-qa] ${label}\n`);
const fx = makeFixture({ judge: new CountingJudge(), guardian: new StubGuardian() });
const app = buildApp(fx.core, { adminToken: ADMIN, gateway: {}, dashboardDir: join(ROOT, 'dashboard') });
const streamSockets = new Set();
app.addHook('onRequest', async request => {
  if (!request.url.startsWith('/v1/admin/stream')) return;
  const socket = request.raw.socket;
  streamSockets.add(socket);
  request.raw.on('close', () => streamSockets.delete(socket));
});
let browser;
let page;
let baseUrl;
const created = {};
const errors = [];
const transportFailures = [];
const expectedConsoleTransportErrors = [];
const serverErrors = [];
let expectedAuthFailure = false, expectedStreamDisconnect = false;
const sessionShort = id => id.replace(/^sess_/, '').slice(0, 8);

try {
  await fx.core.detector.init();
  progress('fixture ready');
  progress('starting private Fastify listener');
  await app.listen({ port: 0, host: '127.0.0.1' });
  progress('private Fastify listener ready');
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (url, token, body) => fetch(baseUrl + url, {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  // Session creation is exercised through the public user-authenticated HTTP route.
  for (const [key, user] of [['onboarding', 'onboarding-demo'], ['deal', 'deal-demo'], ['developer', 'developer-demo'], ['secondOnboarding', 'onboarding-demo']]) {
    progress(`creating ${key}`);
    const response = await post('/v1/sessions', `demo-token-${user.replace('-demo', '')}`, {});
    assert.equal(response.status, 200, `create session for ${user}`);
    created[key] = { ...await response.json(), user };
  }
  progress('sessions created');

  // Actual tool routes produce auditable decision/execution rows and policy attribution.
  const allow = await post('/v1/tool-decisions', created.developer.session_token, {
    request_id: 'qa-allowed-read', tool: 'read', arguments: { path: join(fx.ws, 'project/README.md') }, context: { cwd: created.developer.workdir }
  });
  const allowedDecision = await allow.json();
  assert.equal(allow.status, 200); assert.equal(allowedDecision.effect, 'allow');
  const exactArgs = { request_id: 'qa-allowed-read', tool: 'read', arguments: { path: join(fx.ws, 'project/README.md') }, context: { cwd: created.developer.workdir } };
  const consumed = await post(`/v1/tool-decisions/${allowedDecision.decision_id}/consume`, created.developer.session_token, exactArgs);
  assert.equal(consumed.status, 200);
  for (const phase of ['started', 'completed']) {
    const receipt = await post('/v1/execution-events', created.developer.session_token, { request_id: 'qa-allowed-read', decision_id: allowedDecision.decision_id, phase });
    assert.equal(receipt.status, 200);
  }

  // Seed enough genuine audit-store rows to cover pagination and stable chronology. Payloads
  // are deterministic and session-scoped; they never use or reset the running user's database.
  const seedStart = fx.core.store.listEvents({ limit: 1 })[0]?.id ?? 0;
  for (let i = 0; i < 245; i++) {
    const session = i % 2 ? created.secondOnboarding : created.onboarding;
    fx.core.store.appendEvent(session.session_id, i === 16 ? 'content.user_input' : i % 13 === 0 ? 'content.redacted' : 'model.completed', {
      qa_fixture: true, ordinal: i, text: i === 16 ? '<img src=x onerror=window.__qaXss=1>' : `fixture row ${i}`,
      policy_version: 1, provider_ms: i + 1, usage: { prompt_tokens: 2, completion_tokens: 1 }
    }, { user_name: session.user, request_id: `qa-history-${i}`, tool: null });
  }
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'OTHER-USER-SESSION-MARKER' }, { user_name: created.deal.user });
  const deny = await post('/v1/tool-decisions', created.onboarding.session_token, {
    request_id: 'qa-cross-client-read', tool: 'read', arguments: { path: join(fx.ws, 'clients/boreal/company.json') }, context: { cwd: created.onboarding.workdir }
  });
  const deniedDecision = await deny.json();
  assert.equal(deny.status, 200); assert.equal(deniedDecision.effect, 'deny');
  const seededLatest = fx.core.store.listEvents({ sessionId: created.onboarding.session_id, limit: 1 })[0].id;
  const seededEventCount = fx.core.store.listEvents({ sessionId: created.onboarding.session_id, limit: 1000 }).length;
  assert.ok(seededEventCount >= 122);

  // Walk the real session-history API at a small page size to prove its immutable snapshot
  // and exclusive cursor do not skip or duplicate rows under interleaved global event IDs.
  const adminGet = async url => fetch(baseUrl + url, { headers: { authorization: `Bearer ${ADMIN}` } });
  let cursor = null, snapshot = null, apiHistory = [], apiPages = 0, apiHasMore = true;
  while (apiHasMore) {
    const query = new URLSearchParams({ limit: '37' });
    if (cursor != null) query.set('before_id', String(cursor));
    if (snapshot != null) query.set('snapshot_id', String(snapshot));
    const response = await adminGet(`/v1/admin/sessions/${created.onboarding.session_id}/events?${query}`);
    assert.equal(response.status, 200);
    const pageData = await response.json();
    snapshot ??= pageData.snapshot_id;
    assert.equal(pageData.snapshot_id, snapshot);
    apiHistory.push(...pageData.events); apiPages++;
    cursor = pageData.next_cursor; apiHasMore = pageData.has_more;
    assert.ok(apiPages < 20, 'history pagination terminates');
  }
  const chronologicalHistory = [...apiHistory].sort((a, b) => a.seq - b.seq);
  check('HTTP history cursor returns every event exactly once in chronology', apiHistory.length === seededEventCount
    && new Set(apiHistory.map(event => event.id)).size === apiHistory.length
    && chronologicalHistory.every((event, index) => event.session_id === created.onboarding.session_id && event.seq === index + 1));
  const malformedCursor = await adminGet(`/v1/admin/sessions/${created.onboarding.session_id}/events?before_id=bad&snapshot_id=${snapshot}`);
  check('HTTP history rejects malformed pagination cursors', malformedCursor.status === 400);
  const snapshotEvent = fx.core.store.appendEvent(created.onboarding.session_id, 'content.user_input', { text: 'after immutable snapshot' }, { user_name: created.onboarding.user });
  const stablePage = await adminGet(`/v1/admin/sessions/${created.onboarding.session_id}/events?limit=200&snapshot_id=${snapshot}`);
  const stableData = await stablePage.json();
  check('pagination snapshot excludes rows created after its high-water mark', !stableData.events.some(event => event.id === snapshotEvent.id));
  progress('HTTP fixtures and pagination verified');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('401 (Unauthorized)') || (expectedStreamDisconnect && /ERR_CONNECTION_(RESET|ABORTED|CLOSED)|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(text)))
      expectedConsoleTransportErrors.push(text);
    else errors.push(text);
  });
  page.on('requestfailed', request => transportFailures.push({ url: request.url(), reason: request.failure()?.errorText || '' }));
  page.on('response', r => { if (r.url().startsWith(baseUrl) && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#token').fill(ADMIN);
  await page.locator('#save-token').click();
  await page.locator('[data-tab="sessions"]').click();
  progress('browser authenticated');
  try { await page.waitForSelector('#session-browser .sb-session', { timeout: 7000 }); }
  catch (error) {
    console.error('SESSION LIST DIAGNOSTIC', JSON.stringify({
      tab: await page.locator('#tab-sessions').getAttribute('hidden'), error: await page.locator('#error').textContent(),
      shell: await page.locator('#session-browser').textContent(), buttons: await page.locator('.tabs button').allTextContents(),
      errors, transportFailures, serverErrors, sessionsApi: await adminGet('/v1/admin/sessions').then(r => r.json())
    }, null, 2));
    throw error;
  }

  const visibleSessionIds = await page.locator('#session-browser .sb-session-id').allTextContents();
  const documentLang = await page.locator('html').getAttribute('lang');
  const tabLabels = (await page.locator('.tabs button').allTextContents()).map(norm);
  check('English dashboard lists sessions created over HTTP', documentLang === 'en'
    && tabLabels.includes('Live sessions') && tabLabels.includes('Overview') && tabLabels.includes('Events') && tabLabels.includes('Policies')
    && visibleSessionIds.includes(created.onboarding.session_id) && visibleSessionIds.includes(created.deal.session_id));
  const initialSessionText = await page.locator('#session-browser .sb-session').allTextContents();
  check('session cards do not expose null placeholders', !initialSessionText.some(text => /^null$|\nnull$/m.test(text)));

  const selectSession = async session => {
    const button = page.locator('#session-browser .sb-session').filter({ hasText: session.session_id });
    await button.click(); return button;
  };
  await selectSession(created.onboarding);
  await page.waitForSelector('#session-browser .sb-event');
  check('selected user session is isolated from other sessions', !(await page.locator('#session-browser .sb-event').allTextContents()).join(' ').includes('OTHER-USER-SESSION-MARKER'));
  const technicalToggle = page.locator('#session-browser .sb-technical-toggle input');
  check('technical events are hidden by default', !(await technicalToggle.isChecked())
    && !(await page.locator('#session-browser .sb-event-meta').allTextContents()).some(text => text.includes('model.completed')));
  await technicalToggle.check();

  // Exact intervention evidence must identify the denied cross-client read and current policy.
  const timelineText = norm((await page.locator('#session-browser .sb-event').allTextContents()).join(' '));
  check('timeline includes the actual policy-denied tool call', timelineText.includes('decision.denied') || timelineText.includes('read') || timelineText.includes('PATH_OUTSIDE_WORKSPACE'));
  const selectedEvents = await page.locator('#session-browser .sb-event').count();
  check('history initially renders a bounded recent page', selectedEvents > 0 && selectedEvents <= 120);

  // Pagination must be chronological, session scoped, and gap/duplicate free across pages.
  const pageSequences = async () => page.locator('#session-browser .sb-event-meta').evaluateAll(els => els.map(el => Number(el.textContent.match(/#(\d+)/)?.[1])).filter(Number.isFinite));
  let seqs = await pageSequences();
  const initialSeqs = [...seqs];
  const loadOlder = page.locator('#session-browser .sb-load-older, #session-browser .load-older, #session-browser [data-action="load-older"]');
  if (await loadOlder.count()) {
    while (await loadOlder.first().isVisible() && !(await loadOlder.first().isDisabled()) && seqs.length < seededEventCount) {
      await loadOlder.first().click(); await sleep(100);
      seqs = await pageSequences();
      if (seqs.length === initialSeqs.length) break;
    }
    check('older-history control is available for paged session history', initialSeqs.length < seededEventCount);
  check('all loaded session events remain unique and chronological', seqs.length === new Set(seqs).size && seqs.every((n, i) => i === 0 || seqs[i - 1] < n));
    check('pagination reaches the expected seeded session chronology', seqs.length >= Math.min(seededEventCount, 100));
  } else {
    check('older-history pagination control is present', false, 'No load-older selector matched');
  }
  progress('browser history pagination verified');

  // XSS safety: attacker-controlled event text is shown as text, with no executable elements.
  await selectSession(created.onboarding);
  fx.core.store.appendEvent(created.onboarding.session_id, 'content.user_input', { text: '<img src=x onerror=window.__qaXss=1>' }, { user_name: created.onboarding.user });
  await page.evaluate(() => { window.__qaXss = 0; });
  await page.waitForFunction(() => document.querySelector('#session-browser')?.textContent?.includes('<img src=x onerror=window.__qaXss=1>'), null, { timeout: 5000 });
  const injectionRendered = await page.locator('#session-browser').evaluate(root => ({
    images: root.querySelectorAll('img').length, scripts: root.querySelectorAll('script').length,
    literal: root.textContent.includes('<img src=x onerror=window.__qaXss=1>')
  }));
  check('untrusted event text is inert and rendered literally', injectionRendered.images === 0 && injectionRendered.scripts === 0 && injectionRendered.literal
    && await page.evaluate(() => window.__qaXss === 0));
  const deniedEvent = page.locator('#session-browser .sb-event.is-intervention').filter({ hasText: 'PATH_OUTSIDE_WORKSPACE' }).first();
  await deniedEvent.waitFor({ state: 'visible' });
  check('denial attribution includes the actual tool, reason, and policy version', norm(await deniedEvent.locator('.sb-intervention-title').textContent()).includes('read')
    && norm(await deniedEvent.locator('.sb-intervention-reasons').textContent()).includes('PATH_OUTSIDE_WORKSPACE')
    && norm(await deniedEvent.locator('.sb-policy-version').textContent()).includes('v1'));

  await selectSession(created.developer);
  await page.waitForFunction(() => document.querySelector('#session-browser')?.textContent?.includes('tool.completed'), null, { timeout: 5000 });
  const devTimeline = norm((await page.locator('#session-browser .sb-event').allTextContents()).join(' '));
  check('allowed tool decision is distinct from executor start and completion', devTimeline.includes('decision.allowed') && devTimeline.includes('tool.started') && devTimeline.includes('tool.completed'));
  progress('content, policy attribution, and tool execution verified');

  // Real SSE rows on two sessions prove selection stability, live updates, and chronological order.
  await selectSession(created.deal);
  const dealButton = page.locator(`#session-browser .sb-session[data-session-id="${created.deal.session_id}"]`);
  await dealButton.focus();
  fx.core.store.appendEvent(created.onboarding.session_id, 'content.user_input', { text: 'other-session update' }, { user_name: created.onboarding.user });
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'selected-session update' }, { user_name: created.deal.user });
  await page.waitForFunction(() => document.querySelector('#session-browser .sb-timeline')?.textContent?.includes('selected-session update'), null, { timeout: 7000 });
  check('new events do not steal the selected session', await page.locator('#session-browser .sb-session.is-selected').textContent().then(t => norm(t).includes(sessionShort(created.deal.session_id))));
  check('SSE appends new selected-session event while excluding other-session update', !(await page.locator('#session-browser .sb-event').allTextContents()).join(' ').includes('other-session'));
  check('session selection button keeps keyboard focus through live list refresh', await page.evaluate(id => document.activeElement?.getAttribute('data-session-id') === id, created.deal.session_id));
  const otherSessionButton = page.locator(`#session-browser .sb-session[data-session-id="${created.onboarding.session_id}"]`);
  check('other-session SSE update increments unread indicator', await otherSessionButton.locator('.sb-unread').isVisible());
  await otherSessionButton.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector(`#session-browser .sb-session[data-session-id="${id}"]`)?.classList.contains('is-selected'), created.onboarding.session_id);
  check('keyboard Enter selects a focused session', await page.locator('#session-browser .sb-session.is-selected').getAttribute('data-session-id') === created.onboarding.session_id);
  await page.evaluate(id => { location.hash = `sessions/${encodeURIComponent(id)}`; }, created.deal.session_id);
  await page.waitForFunction(id => document.querySelector(`#session-browser .sb-session[data-session-id="${id}"]`)?.classList.contains('is-selected'), created.deal.session_id);
  check('same-page deep-link hashchange selects the requested session', await page.locator('#session-browser .sb-session.is-selected').getAttribute('data-session-id') === created.deal.session_id);
  await selectSession(created.deal);

  // Pause freezes the visible transcript while still recording stream events and an unread count.
  await page.locator('#session-browser .sb-pause').click();
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'paused-update-marker' }, { user_name: created.deal.user });
  await page.waitForFunction(() => document.querySelector('#session-browser .sb-session.is-selected .sb-unread'), null, { timeout: 5000 });
  check('pause retains incoming event as unread without changing visible timeline', !(await page.locator('#session-browser .sb-timeline').textContent()).includes('paused-update-marker'));
  await page.locator('#session-browser .sb-pause').click();
  await page.waitForFunction(() => document.querySelector('#session-browser .sb-timeline')?.textContent?.includes('paused-update-marker'), null, { timeout: 5000 });
  check('resume reveals the event received while updates were paused', (await page.locator('#session-browser .sb-timeline').textContent()).includes('paused-update-marker'));
  progress('keyboard, unread, and pause verified');

  // Network gap: disconnect while the stream is live, append multiple rows, reconnect, and ensure none are lost.
  expectedStreamDisconnect = true;
  const liveSockets = [...streamSockets];
  assert.ok(liveSockets.length > 0, 'an authenticated live stream is open before disconnection');
  for (const socket of liveSockets) socket.destroy();
  await page.waitForFunction(() => document.querySelector('#live')?.getAttribute('aria-label') === 'Event stream disconnected', null, { timeout: 5000 });
  check('SSE transport confirms it disconnected before events are appended', true);
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'refresh-before-stream-marker' }, { user_name: created.deal.user });
  await page.evaluate(() => sessionBrowser.refresh());
  await page.waitForFunction(() => document.querySelector('#session-browser .sb-timeline')?.textContent?.includes('refresh-before-stream-marker'), null, { timeout: 5000 });
  check('HTTP refresh recovers an event during the disconnected-stream gap', await page.locator('#session-browser .sb-event').filter({ hasText: 'refresh-before-stream-marker' }).count() === 1);
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'gap-a' }, { user_name: created.deal.user });
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'gap-b' }, { user_name: created.deal.user });
  expectedStreamDisconnect = false;
  await page.waitForFunction(() => ['gap-a', 'gap-b'].every(x => document.querySelector('#session-browser .sb-timeline')?.textContent?.includes(x)), null, { timeout: 12000 });
  check('stream reconnect fills the event gap without duplicates', await page.locator('#session-browser .sb-event').filter({ hasText: 'gap-a' }).count() === 1
    && await page.locator('#session-browser .sb-event').filter({ hasText: 'gap-b' }).count() === 1
    && await page.locator('#session-browser .sb-event').filter({ hasText: 'refresh-before-stream-marker' }).count() === 1);
  progress('SSE disconnect and catch-up verified');

  // Token changes must replace the authenticated stream; invalid token must stop prior stream data.
  expectedAuthFailure = true; await page.locator('#token').fill('invalid-session-browser-token'); await page.locator('#save-token').click();
  await page.waitForFunction(() => document.querySelector('#error')?.textContent?.includes('No access'), null, { timeout: 5000 });
  const beforeInvalid = await page.locator('#session-browser .sb-event').count();
  fx.core.store.appendEvent(created.deal.session_id, 'content.user_input', { text: 'after-invalid-token' }, { user_name: created.deal.user });
  await sleep(2800);
  check('invalid-token stream stops receiving protected updates', await page.locator('#session-browser .sb-event').count() === beforeInvalid);
  progress('invalid-token transition verified');

  // Mobile layout is usable without widening the page; session list and timeline remain operable.
  await page.locator('#token').fill(ADMIN); await page.locator('#save-token').click(); expectedAuthFailure = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await selectSession(created.deal);
  await page.waitForSelector('#session-browser .sb-event');
  check('mobile dashboard has no horizontal page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('mobile session browser remains visible and selectable', await page.locator('#session-browser .sb-session').count() > 0
    && await page.locator('#session-browser .sb-main').isVisible());
  await page.screenshot({ path: join(ROOT, 'reports', 'dashboard-session-mobile.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(200);
  await page.screenshot({ path: join(ROOT, 'reports', 'dashboard-session-desktop.png'), fullPage: false });
  progress('mobile/desktop screenshots captured');

  check('no uncaught browser errors or unexpected HTTP 5xx responses', errors.length === 0 && serverErrors.length === 0,
    JSON.stringify({ errors, serverErrors }));
  const report = { generated_at: new Date().toISOString(), baseUrl, isolatedStore: true, seededEventCount,
    seedStart, seededLatest, sessions: Object.fromEntries(Object.entries(created).map(([k, v]) => [k, v.session_id])), checks, errors, serverErrors, transportFailures, expectedConsoleTransportErrors,
    screenshots: ['reports/dashboard-session-desktop.png', 'reports/dashboard-session-mobile.png'] };
  writeFileSync(join(ROOT, 'reports', 'dashboard-session-e2e.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser?.close();
  await app.close();
  fx.core.store.close();
}
