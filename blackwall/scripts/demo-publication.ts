// Records runtime policy/feed publication using a disposable workspace and SQLite database.
// Run only after an explicit go-ahead: node scripts/demo-publication.ts
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.ts';
import { Store } from '../src/store/store.ts';
import { dotenv, makeFixture, ROOT } from '../test/helpers.ts';
import { PiSession } from '../test/e2e/pi-rpc.ts';

const require = createRequire(import.meta.url);
const keys = dotenv();
if (!keys.OPENAI_API_KEY || !keys.JEV_API_KEY) throw new Error('Required provider credentials are missing.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(ROOT, 'demo-recordings', `runtime-publication-${stamp}`);
mkdirSync(out, { recursive: false });
const videoDir = join(out, 'video');
mkdirSync(videoDir);
const dbPath = join(out, 'runtime-publication.sqlite');
const fx = makeFixture({ store: new Store(dbPath) });
const adminToken = 'runtime-demo-admin-token';
const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
const privateValues = [keys.OPENAI_API_KEY, keys.JEV_API_KEY, keys.ANTHROPIC_API_KEY].filter((x): x is string => Boolean(x));
const privateWorkspaceValues = readFileSync(join(fx.ws, 'project/.env'), 'utf8').split(/\r?\n/).map((x) => x.slice(x.indexOf('=') + 1)).filter(Boolean);
const scrub = (value: string): string => {
  let text = value.replace(/(?:sk-(?:proj-)?|sk-ant-)[A-Za-z0-9_-]{20,}/g, '[REDACTED SECRET]')
    .replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, '[REDACTED SECRET]')
    .replace(/bw_sess_[A-Za-z0-9_-]+/g, '[REDACTED SESSION TOKEN]')
    .replace(/(?:OPENAI|JEV|ANTHROPIC)_API_KEY\s*[:=]\s*[^\s,;]+/gi, '[REDACTED SECRET]');
  for (const secret of [...privateValues, ...privateWorkspaceValues]) text = text.replaceAll(secret, '[REDACTED SECRET]');
  return text;
};
type Check = { ok: boolean; name: string; detail: string };
const checks: Check[] = [];
const transcript: { ts: string; source: string; role: string; text: string }[] = [];
const adminActions: { ts: string; action: string; status: number; detail: string }[] = [];
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let browser: any;
let context: any;
let page: any;
let pi: PiSession | undefined;

function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail: scrub(detail) });
  console.log(`${ok ? 'OK' : 'FAIL'} ${name}: ${scrub(detail)}`);
}

async function api<T = any>(path: string, init: RequestInit = {}, token = adminToken): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({})) as T;
  return { status: response.status, body };
}

function loadPlaywright(): any {
  const candidates = [process.env.PLAYWRIGHT_MODULE,
    '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js',
    'playwright', 'playwright-core'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try next runtime path */ }
  }
  throw new Error('Playwright not found; set PLAYWRIGHT_MODULE to its module path.');
}

const coreEvents = () => fx.core.store.listEvents({ limit: 1000 }).reverse();
const eventData = (e: { data: string }) => JSON.parse(e.data) as Record<string, any>;
const allEvents = () => coreEvents().map((e) => ({ ...e, data: eventData(e) }));

let baseUrl = '';
let sessionId = '';
let sessionToken = '';
let workdir = '';
let initialPolicyVersion = 1;
let initialFeedVersion = 1;
let finalPolicyVersion = 0;
let finalFeedVersion = 0;
let videoWebm = '';
let screenshots: string[] = [];
let caughtError: string | undefined;

try {
  // Real provider calls use the configured OpenAI executor, Jev judge, and embedding model.
  await fx.core.detector.init();
  app = buildApp(fx.core, { adminToken, gateway: { openaiKey: keys.OPENAI_API_KEY }, dashboardDir: join(ROOT, 'dashboard') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1600, height: 900 } } });
  page = await context.newPage();
  await page.addInitScript((token: string) => sessionStorage.setItem('bw-admin', token), adminToken);
  await page.goto(`${baseUrl}/dashboard#policies`, { waitUntil: 'domcontentloaded' });
  await page.locator('#policy-edit').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('#policy-publish-result')?.textContent?.includes('Edytujesz wersję'));
  const takeScreenshot = async (name: string, fullPage = true) => {
    const path = join(out, `${name}.png`);
    await page.screenshot({ path, fullPage });
    screenshots.push(path);
  };

  const initial = await api<{ expected_version: number; changes: { profiles: Record<string, any> } }>('/v1/admin/policies/editable');
  initialPolicyVersion = initial.body.expected_version;
  const feedBefore = await api<{ expected_policy_version: number; expected_feed_version: number; feed: any }>('/v1/admin/threat-feed');
  initialFeedVersion = feedBefore.body.expected_feed_version;
  finalPolicyVersion = initialPolicyVersion;
  finalFeedVersion = initialFeedVersion;
  check('Initial active configuration loaded in authenticated dashboard', initial.status === 200 && feedBefore.status === 200 && initialPolicyVersion === 1 && initialFeedVersion === 1,
    `policy v${initialPolicyVersion}, feed v${initialFeedVersion}; admin API HTTP ${initial.status}/${feedBefore.status}.`);
  await takeScreenshot('01-admin-policy-before');

  const sessionResponse = await api<{ session_id: string; session_token: string; workdir: string }>('/v1/sessions', { method: 'POST', body: '{}' }, 'demo-token-developer');
  if (sessionResponse.status !== 200) throw new Error(`Session creation failed with HTTP ${sessionResponse.status}.`);
  sessionId = sessionResponse.body.session_id;
  sessionToken = sessionResponse.body.session_token;
  workdir = sessionResponse.body.workdir;
  const userTask = 'Read README.md using the read tool. Then run exactly this harmless local command using bash: python3 -c "print(\'BLACKWALL_RUNTIME_PROGRAM_OK\')". Do not change files or access the network. Tell me what happened.';
  transcript.push({ ts: new Date().toISOString(), source: 'Pi RPC user input', role: 'user', text: userTask });
  pi = new PiSession({ baseUrl, sessionToken, cwd: workdir, onConfirm: () => true, timeoutMs: 240_000 });
  const piStarted = Date.now();
  await pi.prompt(userTask);
  const piRunSeconds = Math.round((Date.now() - piStarted) / 1000);
  for (const entry of pi.run.assistant) {
    transcript.push({ ts: new Date().toISOString(), source: 'Pi RPC', role: entry.error ? 'provider error' : 'assistant', text: entry.error ? entry.error : entry.text });
  }
  for (const call of pi.run.toolCalls) {
    transcript.push({ ts: new Date().toISOString(), source: 'Pi RPC', role: `tool ${call.name} arguments`, text: JSON.stringify(call.args) });
    transcript.push({ ts: new Date().toISOString(), source: 'Pi RPC', role: `tool ${call.name} result`, text: call.text ?? (call.isError ? 'Tool reported an error.' : '') });
  }
  for (const confirm of pi.run.confirms) {
    transcript.push({ ts: new Date().toISOString(), source: 'Pi RPC harness callback', role: 'simulated user approval', text: `${confirm.title}: ${confirm.message}` });
  }
  pi.close();
  pi = undefined;
  for (const event of fx.core.store.listEvents({ sessionId, limit: 500 }).reverse()) {
    const data = eventData(event);
    if (event.type === 'content.user_input') continue;
    if (event.type === 'model.completed') transcript.push({ ts: new Date(event.ts).toISOString(), source: 'Blackwall audit', role: 'provider receipt', text: `alias=${data.alias}; provider_model=${data.provider_model}; usage=${JSON.stringify(data.usage)}` });
  }
  const firstAudit = fx.core.store.listEvents({ sessionId, limit: 500 }).reverse();
  const judgeReceipts = firstAudit.filter((e) => e.type === 'judge.evaluated').map((e) => eventData(e));
  const providerReceipts = firstAudit.filter((e) => e.type === 'model.completed').map((e) => eventData(e));
  const actualToolReceipts = firstAudit.filter((e) => ['tool.started', 'tool.completed', 'tool.failed'].includes(e.type));
  check('Real Pi read and harmless program completed before publication', actualToolReceipts.some((e) => e.type === 'tool.completed' && e.tool === 'read') && actualToolReceipts.some((e) => e.type === 'tool.completed' && e.tool === 'bash'),
    `Pi run took ${piRunSeconds}s; executor receipts: ${actualToolReceipts.map((e) => `${e.type}:${e.tool}`).join(', ') || 'none'}.`);
  check('Real Jev evaluated the program operation', judgeReceipts.some((r) => r.source === 'real'),
    `judge.evaluated receipts=${judgeReceipts.length}; sources=${[...new Set(judgeReceipts.map((r) => r.source))].join(', ') || 'none'}.`);
  check('Real OpenAI gpt-6-luna completed Pi gateway calls', providerReceipts.length > 0 && providerReceipts.every((r) => r.provider_model === 'gpt-6-luna'),
    `model.completed receipts=${providerReceipts.length}; models=${[...new Set(providerReceipts.map((r) => r.provider_model))].join(', ') || 'none'}.`);

  const beforeControls = initial.body.changes;
  const currentThreshold = Number(beforeControls.profiles.standard.min_allow_probability);
  const nextThreshold = Math.min(0.99, Math.round((currentThreshold + 0.01) * 100) / 100);
  if (nextThreshold === currentThreshold) throw new Error('Could not prepare a strictly higher profile threshold.');
  const policyPatch = { profiles: { standard: { min_allow_probability: nextThreshold } } };
  await page.locator('#policy-edit').fill(JSON.stringify(policyPatch, null, 2));
  const policyPublishResponsePromise = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/v1/admin/policies' && response.request().method() === 'POST');
  await page.locator('#policy-publish').click();
  const policyPublishResponse = await policyPublishResponsePromise;
  const policyPublishBody = await policyPublishResponse.json();
  if (!policyPublishResponse.ok()) throw new Error(`Policy publication returned HTTP ${policyPublishResponse.status()}: ${policyPublishBody?.error?.code ?? 'publication failed'}.`);
  await page.waitForFunction((version: number) => document.querySelector('#policy-publish-result')?.textContent?.includes(`polityka v${version}`), initialPolicyVersion + 1, { timeout: 15_000 });
  const policyAfter = await api<{ expected_version: number; changes: { profiles: Record<string, any> } }>('/v1/admin/policies/editable');
  finalPolicyVersion = policyAfter.body.expected_version;
  check('Admin UI publishes a profile threshold change', policyAfter.status === 200 && finalPolicyVersion === initialPolicyVersion + 1 && policyAfter.body.changes.profiles.standard.min_allow_probability === nextThreshold,
    `standard.min_allow_probability ${currentThreshold} → ${nextThreshold}; active policy v${finalPolicyVersion}.`);
  adminActions.push({ ts: new Date().toISOString(), action: 'Authenticated dashboard policy editor published standard.min_allow_probability update.', status: policyPublishResponse.status(), detail: `version ${initialPolicyVersion} → ${finalPolicyVersion}` });
  await takeScreenshot('02-admin-policy-published');

  const badFeed = { ...feedBefore.body.feed, version: initialFeedVersion + 1, signatures: 'malformed-canary' };
  const malformed = await api('/v1/admin/threat-feed', { method: 'POST', body: JSON.stringify({ expected_policy_version: finalPolicyVersion, expected_feed_version: initialFeedVersion, feed: badFeed }) });
  const afterMalformed = await api<{ expected_policy_version: number; expected_feed_version: number; feed: any }>('/v1/admin/threat-feed');
  finalPolicyVersion = afterMalformed.body.expected_policy_version;
  finalFeedVersion = afterMalformed.body.expected_feed_version;
  check('Malformed feed is rejected without changing the active feed', malformed.status === 400 && afterMalformed.body.expected_feed_version === initialFeedVersion && JSON.stringify(afterMalformed.body.feed) === JSON.stringify(feedBefore.body.feed),
    `malformed publication HTTP ${malformed.status}; active feed remains v${afterMalformed.body.expected_feed_version}.`);
  adminActions.push({ ts: new Date().toISOString(), action: 'Authenticated admin API submitted malformed feed; publication was rejected.', status: malformed.status, detail: `active feed remains v${afterMalformed.body.expected_feed_version}` });

  const stale = await api('/v1/admin/threat-feed', { method: 'POST', body: JSON.stringify({ expected_policy_version: initialPolicyVersion, expected_feed_version: initialFeedVersion, feed: { ...feedBefore.body.feed, version: initialFeedVersion + 1 } }) });
  const afterStale = await api<{ expected_policy_version: number; expected_feed_version: number }>('/v1/admin/threat-feed');
  finalPolicyVersion = afterStale.body.expected_policy_version;
  finalFeedVersion = afterStale.body.expected_feed_version;
  check('Stale compare-and-swap publication returns HTTP 409', stale.status === 409 && afterStale.body.expected_policy_version === finalPolicyVersion && afterStale.body.expected_feed_version === initialFeedVersion,
    `stale publication HTTP ${stale.status}; active versions stay policy v${afterStale.body.expected_policy_version}/feed v${afterStale.body.expected_feed_version}.`);
  adminActions.push({ ts: new Date().toISOString(), action: 'Authenticated admin API retried with stale policy/feed versions.', status: stale.status, detail: `active versions remain policy v${finalPolicyVersion}/feed v${initialFeedVersion}` });

  const feedAfter = await api<{ expected_policy_version: number; expected_feed_version: number; feed: any }>('/v1/admin/threat-feed');
  const canaryId = 'BW-RUNTIME-CANARY-001';
  const publishedFeed = { ...feedAfter.body.feed, version: initialFeedVersion + 1, signatures: [
    ...feedAfter.body.feed.signatures,
    { id: canaryId, title: 'Runtime publication canary', category: 'runtime_publication', source: 'local demonstration', risk: 'high', targets: ['bash'], pattern: 'BW_RUNTIME_CANARY' },
  ] };
  const reloadResponsePromise = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/v1/admin/threat-feed' && response.request().method() === 'GET');
  await page.locator('#feed-reload').click();
  const reloadResponse = await reloadResponsePromise;
  if (!reloadResponse.ok()) throw new Error(`Feed reload returned HTTP ${reloadResponse.status()}.`);
  const reloaded = await reloadResponse.json();
  const reloadedEditorValue = JSON.stringify(reloaded.feed, null, 2);
  await page.waitForFunction((value: string) => (document.querySelector('#feed-edit') as HTMLTextAreaElement | null)?.value === value, reloadedEditorValue, { timeout: 10_000 });
  await page.waitForFunction(() => {
    const editor = document.querySelector('#feed-edit') as HTMLTextAreaElement | null;
    return Boolean(editor && !editor.disabled && !editor.readOnly);
  }, undefined, { timeout: 10_000 });
  await page.locator('#feed-edit').fill(JSON.stringify(publishedFeed, null, 2));
  const feedPublishResponsePromise = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/v1/admin/threat-feed' && response.request().method() === 'POST');
  await page.locator('#feed-publish').click();
  const feedPublishResponse = await feedPublishResponsePromise;
  const feedPublishBody = await feedPublishResponse.json();
  if (!feedPublishResponse.ok()) throw new Error(`Feed publication returned HTTP ${feedPublishResponse.status()}: ${feedPublishBody?.error?.code ?? 'publication failed'}.`);
  await page.waitForFunction((version: number) => document.querySelector('#feed-publish-result')?.textContent?.includes(`feed v${version}`), initialFeedVersion + 1, { timeout: 20_000 });
  const feedPublished = await api<{ expected_policy_version: number; expected_feed_version: number; feed: any }>('/v1/admin/threat-feed');
  finalPolicyVersion = feedPublished.body.expected_policy_version;
  finalFeedVersion = feedPublished.body.expected_feed_version;
  check('Admin UI publishes feed v2 while retaining the catalog identity', feedPublished.status === 200 && finalFeedVersion === initialFeedVersion + 1 && feedPublished.body.feed.catalog_id === feedBefore.body.feed.catalog_id && feedPublished.body.feed.signatures.some((s: any) => s.id === canaryId),
    `catalog=${feedPublished.body.feed.catalog_id}; active policy v${finalPolicyVersion}/feed v${finalFeedVersion}; canary=${canaryId}.`);
  adminActions.push({ ts: new Date().toISOString(), action: 'Authenticated dashboard feed editor published the unique runtime canary signature.', status: feedPublishResponse.status(), detail: `policy v${finalPolicyVersion}, feed v${finalFeedVersion}` });
  await takeScreenshot('03-admin-feed-published');

  const command = `python3 -c "from pathlib import Path; Path('runtime-canary.txt').write_text('BW_RUNTIME_CANARY')"`;
  const canaryMarker = join(workdir, 'runtime-canary.txt');
  const replay = await api<any>('/v1/tool-decisions', { method: 'POST', body: JSON.stringify({
    request_id: 'runtime-publication-canary-replay', tool: 'bash', arguments: { command }, context: { cwd: workdir },
  }) }, sessionToken);
  const decision = replay.body;
  let consumeStatus: number | null = null;
  let startedStatus: number | null = null;
  let executorStatus: number | null = null;
  let executorStdout = '';
  // This is a clearly labelled harness replay. If a future regression allows it,
  // the only permitted executor path consumes the exact grant and writes one file
  // inside this run's disposable workspace using a minimal child environment.
  if (replay.status === 200 && decision.effect === 'allow') {
    const request = { request_id: 'runtime-publication-canary-replay', tool: 'bash', arguments: decision.sanitized_arguments ?? { command }, context: { cwd: workdir } };
    const consume = await api(`/v1/tool-decisions/${encodeURIComponent(decision.decision_id)}/consume`, { method: 'POST', body: JSON.stringify(request) }, sessionToken);
    consumeStatus = consume.status;
    if (consume.status === 200) {
      const started = await api('/v1/execution-events', { method: 'POST', body: JSON.stringify({ request_id: request.request_id, decision_id: decision.decision_id, phase: 'started' }) }, sessionToken);
      startedStatus = started.status;
      if (started.status === 200) {
        const child = spawnSync('/bin/sh', ['-c', command], { cwd: workdir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 });
        executorStatus = child.status;
        executorStdout = child.stdout ?? '';
        await api('/v1/execution-events', { method: 'POST', body: JSON.stringify({ request_id: request.request_id, decision_id: decision.decision_id, phase: child.status === 0 ? 'completed' : 'failed', exit_code: child.status ?? undefined, error: child.error?.message.slice(0, 300) }) }, sessionToken);
      }
    }
  }
  const canaryEvent = fx.core.store.listEvents({ sessionId, limit: 500 }).reverse().find((e) => e.request_id === 'runtime-publication-canary-replay' && e.type === 'decision.denied');
  const canaryData = canaryEvent ? eventData(canaryEvent) : {};
  const noExecutionReceipt = !fx.core.store.listEvents({ sessionId, limit: 500 }).some((e) => e.request_id === 'runtime-publication-canary-replay' && ['tool.started', 'tool.completed', 'tool.failed'].includes(e.type));
  check('Same active session uses feed v2 on its next decision', replay.status === 200 && decision.effect === 'deny' && decision.policy_version === finalPolicyVersion && decision.reason_codes?.includes('THREAT_FEED_MATCH') && canaryData.details?.feed_version === finalFeedVersion,
    `session=${sessionId}; effect=${decision.effect}; policy v${decision.policy_version}; matched feed v${canaryData.details?.feed_version}.`);
  check('Consume-gated executor stayed idle after the canary denial', noExecutionReceipt && !existsSync(canaryMarker) && decision.effect === 'deny' && consumeStatus === null && startedStatus === null && executorStatus === null,
    `Harness replay decision=${decision.effect}; consume HTTP=${consumeStatus ?? 'not called'}; executor start HTTP=${startedStatus ?? 'not called'}; marker exists=${existsSync(canaryMarker)}; stdout=${JSON.stringify(executorStdout)}.`);
  transcript.push({ ts: new Date().toISOString(), source: 'Authenticated session API replay', role: 'harness disclosure', text: `A separately labelled, consume-gated tool proposal submitted the harmless temporary-workspace marker command through the same active session after feed publication. Blackwall denied it as THREAT_FEED_MATCH under feed v${canaryData.details?.feed_version}; consume HTTP=${consumeStatus ?? 'not called'}, executor-start HTTP=${startedStatus ?? 'not called'}, marker exists=${existsSync(canaryMarker)}.` });

  const policyTab = page.locator('.tabs button[data-tab="policies"]');
  if (await policyTab.count()) await policyTab.click();
  await page.waitForTimeout(400);
  await takeScreenshot('04-admin-policy-final');
  await page.locator('.tabs button[data-tab="events"]').click();
  await page.waitForFunction((id: string) => [...document.querySelector('#f-session')!.querySelectorAll('option')].some((option) => (option as HTMLOptionElement).value === id), sessionId, { timeout: 15_000 });
  await page.locator('#f-session').selectOption(sessionId);
  await page.waitForTimeout(1000);
  await takeScreenshot('05-session-audit');

  const allAudit = allEvents();
  const realJev = allAudit.filter((e) => e.type === 'judge.evaluated' && e.data?.source === 'real');
  const realOpenAi = allAudit.filter((e) => e.type === 'model.completed' && e.data?.provider_model === 'gpt-6-luna');
  const publishAudit = allAudit.filter((e) => ['policy.published', 'feed.published'].includes(e.type));
  check('Audit stores real Jev/OpenAI receipts and both publication events', realJev.length > 0 && realOpenAi.length > 0 && publishAudit.some((e) => e.type === 'policy.published') && publishAudit.some((e) => e.type === 'feed.published'),
    `real Jev=${realJev.length}, gpt-6-luna=${realOpenAi.length}, policy.published=${publishAudit.some((e) => e.type === 'policy.published')}, feed.published=${publishAudit.some((e) => e.type === 'feed.published')}.`);

  await context.close();
  context = undefined;
  const video = await page.video().path();
  videoWebm = join(videoDir, 'runtime-publication-ui.webm');
  renameSync(video, videoWebm);
  const mp4 = join(videoDir, 'runtime-publication-ui.mp4');
  const converted = spawnSync(process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoWebm, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  if (converted.error || converted.status !== 0) throw converted.error ?? new Error(`ffmpeg exited with ${converted.status}`);
  unlinkSync(videoWebm);
} catch (error) {
  caughtError = scrub(error instanceof Error ? error.message : String(error));
  console.error(caughtError);
} finally {
  pi?.close();
  if (context) {
    try { await context.close(); } catch { /* keep available artifacts */ }
  }
  if (browser) {
    try { await browser.close(); } catch { /* keep available artifacts */ }
  }
  if (app) {
    try { await app.close(); } catch { /* keep available artifacts */ }
  }
  const events = allEvents();
  const actualTranscriptEvents = sessionId ? fx.core.store.listEvents({ sessionId, limit: 1000 }).reverse() : [];
  writeFileSync(join(out, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  writeFileSync(join(out, 'admin-actions.jsonl'), adminActions.map((e) => JSON.stringify(e)).join('\n') + (adminActions.length ? '\n' : ''));
  const piTranscript = transcript.map((e) => ({ ...e, text: scrub(e.text) }));
  if (actualTranscriptEvents.some((e) => e.type === 'model.completed')) {
    for (const e of actualTranscriptEvents.filter((x) => x.type === 'model.completed')) {
      const data = eventData(e);
      if (!piTranscript.some((x) => x.role === 'provider receipt' && x.text.includes(String(data.request_id)))) piTranscript.push({ ts: new Date(e.ts).toISOString(), source: 'Blackwall audit', role: 'provider receipt', text: `request=${data.request_id}; alias=${data.alias}; provider_model=${data.provider_model}; usage=${JSON.stringify(data.usage)}` });
    }
  }
  writeFileSync(join(out, 'transcript.jsonl'), piTranscript.map((e) => JSON.stringify(e)).join('\n') + (piTranscript.length ? '\n' : ''));
  const auditProof = events.filter((e: any) => ['judge.evaluated', 'model.completed', 'policy.published', 'feed.published'].includes(e.type));
  const verifiedPolicyVersion = finalPolicyVersion > 0 ? finalPolicyVersion : null;
  const verifiedFeedVersion = finalFeedVersion > 0 ? finalFeedVersion : null;
  const finalPublicationVerified = checks.some((c) => c.name === 'Admin UI publishes feed v2 while retaining the catalog identity' && c.ok);
  writeFileSync(join(out, 'source-proof.json'), JSON.stringify({
    provider: 'Blackwall gateway to OpenAI', model: 'gpt-6-luna', reasoning_effort: 'low', judge: 'Jev',
    policy_id: fx.policy.policy_id, final_policy_version: verifiedPolicyVersion, final_feed_version: verifiedFeedVersion,
    version_evidence: finalPublicationVerified ? 'final authenticated runtime GET responses' : 'last verified authenticated runtime GET; full publication state unknown',
    session_id: sessionId || null, database_path: dbPath, workspace_path: fx.ws,
    receipts: auditProof.map((e: any) => ({ id: e.id, type: e.type, session_id: e.session_id, request_id: e.request_id, data: e.data })),
  }, null, 2));
  const summary = {
    generated_at: new Date().toISOString(), provider: 'OpenAI', model: 'gpt-6-luna', reasoning_effort: 'low', judge: 'Jev', embedder: 'OpenAI text-embedding-3-small',
    session_id: sessionId || null, initial_policy_version: initialPolicyVersion, final_policy_version: verifiedPolicyVersion,
    initial_feed_version: initialFeedVersion, final_feed_version: verifiedFeedVersion,
    version_evidence: finalPublicationVerified ? 'final authenticated runtime GET responses' : 'last verified authenticated runtime GET; full publication state unknown',
    database_path: dbPath, workspace_path: fx.ws,
    screenshots: screenshots.map((file) => file.replace(`${out}/`, '')), video: existsSync(join(videoDir, 'runtime-publication-ui.mp4')) ? 'video/runtime-publication-ui.mp4' : null,
    checks, all_checks_passed: !caughtError && checks.length >= 6 && checks.every((c) => c.ok), error: caughtError,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(out, 'checks.json'), JSON.stringify({ all_checks_passed: summary.all_checks_passed, checks }, null, 2));
  const report = [
    '# Runtime policy and feed publication', '',
    `Generated ${summary.generated_at}. Provider: OpenAI ${summary.model} (reasoning ${summary.reasoning_effort}); semantic judge: ${summary.judge}.`,
    `Disposable database: \`${dbPath}\`; temporary workspace: \`${fx.ws}\`; session: \`${sessionId || 'not created'}\`.`, '',
    'The transcript contains the real Pi user prompt and captured provider receipts. The canary is a separately labelled authenticated API replay; the denied request was not consumed, and no command executor ran.', '',
    '## Checks', '', ...checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} **${c.name}:** ${c.detail}`), '',
    `All checks passed: **${summary.all_checks_passed}**.`, '',
    '## Artifacts', '',
    ...screenshots.map((file) => `- Screenshot: \`${file.replace(`${out}/`, '')}\``),
    ...(summary.video ? [`- H.264 recording: \`${summary.video}\``] : []),
    '- Actual transcript: `transcript.jsonl`', '- Audit evidence: `events.jsonl` and `source-proof.json`', '',
  ].join('\n');
  writeFileSync(join(out, 'report.md'), report);
  fx.core.store.close();
  console.log(`Output: ${out}`);
  console.log(`Checks passed: ${checks.filter((c) => c.ok).length}/${checks.length}`);
  if (caughtError || !summary.all_checks_passed) process.exitCode = 1;
}
