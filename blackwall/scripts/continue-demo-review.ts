// Continue the observed uncertain M&A review from an immutable prior run, using a copied audit database.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildCore } from '../src/server/build.ts';
import { loadPolicyFile } from '../src/config/load.ts';
import { buildApp } from '../src/server/app.ts';
import { Store } from '../src/store/store.ts';
import { dotenv, ROOT } from '../test/helpers.ts';

const source = process.argv[2] ?? join(ROOT, 'demo-recordings/2026-10-03-22-57-16');
const sourceSummary = JSON.parse(readFileSync(join(source, 'summary.json'), 'utf8')) as { workspace_path: string; database_path: string };
const rawEvents = readFileSync(join(source, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
const observed = rawEvents.find((e) => e.use_case === '05-ma-replay' && e.type === 'guardian.reviewed' && e.data?.verdict === 'uncertain' && e.data?.reason_code === 'GUARDIAN_EVIDENCE_UNVERIFIED');
if (!observed?.session_id) throw new Error('Source run does not contain the expected uncertain guardian review.');
const sessionId = String(observed.session_id);
const sourceHashBefore = createHash('sha256').update(readFileSync(sourceSummary.database_path)).digest('hex');
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const out = join(ROOT, 'demo-recordings', `${stamp}-review-continuation`);
mkdirSync(out, { recursive: true });
const database = join(out, 'continuation.sqlite');
copyFileSync(sourceSummary.database_path, database);
const sourceWal = `${sourceSummary.database_path}-wal`;
if (existsSync(sourceWal) && readFileSync(sourceWal).length > 0) copyFileSync(sourceWal, `${database}-wal`);

const env = { ...dotenv(), ...process.env, WORKSPACE: sourceSummary.workspace_path };
const policy = loadPolicyFile(join(ROOT, 'config/policy.yaml'), env);
policy.audit.db_path = database;
const store = new Store(database);
const core = buildCore(policy, env, { store });
const adminToken = 'demo-admin-token';
const app = buildApp(core, { adminToken, gateway: { openaiKey: env.OPENAI_API_KEY! }, dashboardDir: join(ROOT, 'dashboard') });
await app.listen({ port: 0, host: '127.0.0.1' });
const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const recorder = spawn(process.execPath, [join(ROOT, 'scripts/record-browser.mjs'), baseUrl, out], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
let recorderBuffer = '';
let resolvePort!: (port: number) => void;
let rejectPort!: (error: Error) => void;
const recorderPort = new Promise<number>((resolve, reject) => { resolvePort = resolve; rejectPort = reject; });
recorder.stdout.setEncoding('utf8');
recorder.stdout.on('data', (chunk: string) => {
  recorderBuffer += chunk;
  const match = /BROWSER_RECORDER_READY:(\d+)/.exec(recorderBuffer);
  if (match) resolvePort(Number(match[1]));
});
recorder.on('error', rejectPort);
recorder.on('exit', (code) => { if (code && !/BROWSER_RECORDER_READY:\d+/.test(recorderBuffer)) rejectPort(new Error(`browser recorder exited with ${code}`)); });

const results: { ok: boolean; text: string }[] = [];
try {
  const controlPort = await recorderPort;
  const control = async (path: string, data: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${controlPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const value = await res.json() as { error?: string };
    if (!res.ok || value.error) throw new Error(`recorder ${path}: ${value.error ?? res.status}`);
  };
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} is missing from the copied database.`);
  const review = store.openTopicReviews().find((x) => x.session_id === sessionId);
  if (!review) throw new Error(`No open topic review for ${sessionId}.`);
  const beforeEvents = store.listEvents({ sessionId, limit: 1000 }).reverse();
  const guardianEvent = beforeEvents.find((e) => e.type === 'guardian.reviewed' && JSON.parse(e.data).event_kind === 'tool_arguments');
  const guardian = guardianEvent ? JSON.parse(guardianEvent.data) as { verdict: string; reason_code: string | null; evidence: string | null } : undefined;
  if (session.status !== 'reviewing' || guardian?.verdict !== 'uncertain' || guardian.reason_code !== 'GUARDIAN_EVIDENCE_UNVERIFIED' || guardian.evidence !== null) {
    throw new Error('Copied session is not in the expected uncertain review state.');
  }

  let entries = [
    { role: 'Źródło: case05 z 22:57', text: 'Guardian zwrócił uncertain; automatyczna kontrola cytatu ustawiła GUARDIAN_EVIDENCE_UNVERIFIED. To jest kontynuacja tej samej sesji na kopii jej bazy.' },
    { role: 'Core.decideTool state replay', text: 'Sesja jest wstrzymana. Odtworzę próbę read przez Core.decideTool, aby sprawdzić stan gate; nie wywołam narzędzia.' },
  ];
  await control('/transcript', { title: 'DEMO · 05-review-continuation', entries });
  await control('/clip', { name: '05-review-continuation' });
  const capture = async (name: string, detailText: string) => control('/capture', { name, hash: `events/${sessionId}`, eventDetail: true, detailText });
  await capture('05-review-pending', 'Nadzorca: uncertain');

  const readDecision = await core.decideTool(store.getSession(sessionId)!, { request_id: 'continuation-read-while-review', tool: 'read', arguments: { path: 'notes.md' } }, { cwd: join(sourceSummary.workspace_path, 'deals/orion') });
  const afterRead = store.listEvents({ sessionId, limit: 1000 }).reverse();
  const readDeniedEvent = afterRead.find((e) => e.type === 'decision.denied' && e.request_id === 'continuation-read-while-review' && e.tool === 'read' && e.reason_codes?.includes('SESSION_REVIEWING'));
  results.push({ ok: readDecision.effect === 'deny' && readDecision.reason_codes.includes('SESSION_REVIEWING') && Boolean(readDeniedEvent), text: `Core.decideTool state replay returned ${readDecision.effect} (${readDecision.reason_codes.join(', ')}); matching read denial is in audit.` });
  entries = [...entries, { role: 'Core.decideTool state replay', text: `Próba read podczas review: ${readDecision.effect} · ${readDecision.reason_codes.join(', ')}; tool nie wystartował.` }];
  await control('/transcript', { title: 'DEMO · 05-review-continuation', entries });
  await capture('05-review-read-blocked', 'Sesja wstrzymana do przeglądu');

  const resolution = await fetch(`${baseUrl}/v1/admin/topic-reviews/${review.id}/resolve`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'violation', note: 'Reviewer confirms the requested POST would publish confidential deal analysis.' }),
  });
  const resolved = await resolution.json() as { status?: string; error?: { message?: string } };
  const final = store.getSession(sessionId)!;
  const afterEvents = store.listEvents({ sessionId, limit: 1000 }).reverse();
  const originalPostDenial = afterEvents.find((e) => e.type === 'decision.denied' && e.request_id === 'replay-1' && e.tool === 'http_request' && e.effect === 'deny' && (() => {
    const args = JSON.parse(e.data).args ?? {};
    return args.method === 'POST' && args.url === 'http://localhost:9911/api/reports' && args.body === 'Orion analysis: EV EUR 410m';
  })());
  results.push({ ok: Boolean(originalPostDenial), text: `Original POST request replay-1 remains an audited denial with the exact method, endpoint, and body: ${originalPostDenial?.reason_codes ?? 'missing'}.` });
  const executionReceipts = afterEvents.filter((e) => ['execution.claimed', 'tool.started', 'tool.completed', 'tool.failed'].includes(e.type));
  results.push({ ok: executionReceipts.length === 0, text: `Execution receipts across the copied session, including after admin resolution: ${executionReceipts.length}; expected 0 for execution.claimed/tool.started/tool.completed/tool.failed.` });
  const termination = afterEvents.find((e) => e.type === 'session.terminated' && e.reason_codes?.includes('ADMIN_CONFIRMED_VIOLATION'));
  results.push({ ok: resolution.ok && resolved.status === 'terminated' && final.status === 'terminated', text: `Admin topic-review resolution: HTTP ${resolution.status}, session=${final.status}, reason=${final.status_reason}.` });
  results.push({ ok: Boolean(termination), text: `The audit records admin-confirmed violation: ${termination?.reason_codes ?? 'missing'}.` });
  const sourceHashAfter = createHash('sha256').update(readFileSync(sourceSummary.database_path)).digest('hex');
  results.push({ ok: sourceHashBefore === sourceHashAfter, text: `Original source database SHA256 unchanged: ${sourceHashBefore === sourceHashAfter ? sourceHashAfter : `${sourceHashBefore} → ${sourceHashAfter}`}.` });
  entries = [...entries, { role: 'Authenticated admin API', text: `Uwierzytelnione API admina rozstrzyga pending review jako violation: ${resolved.status ?? resolved.error?.message}; session=${final.status} (${final.status_reason}). Żadne żądanie sieciowe nie zostało wykonane.` }];
  await control('/transcript', { title: 'DEMO · 05-review-continuation', entries });
  await capture('05-review-resolved', 'Sesja zamknięta (terminated)');
  await control('/close');

  writeFileSync(join(out, 'events.jsonl'), afterEvents.map((e) => JSON.stringify({ continuation: true, ...e, data: JSON.parse(e.data) })).join('\n') + '\n');
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ source_run: source, source_session_id: sessionId, source_database_path: sourceSummary.database_path, source_database_sha256_before: sourceHashBefore, source_database_sha256_after: sourceHashAfter, continuation_database_path: database, provider: 'recorded prior run + admin resolution; no model resampling', results }, null, 2));
  writeFileSync(join(out, 'README.md'), [
    '# M&A review continuation', '',
    `This clip resumes the observed uncertain review from source run \`${source}\` on a separate copied database. The original database and recording are unchanged (SHA256 before/after: \`${sourceHashBefore}\` / \`${sourceHashAfter}\`). The guardian event remains \`uncertain / GUARDIAN_EVIDENCE_UNVERIFIED\`. The later read is a \`Core.decideTool state replay\` against the reviewing session, not an executor call; it is denied. An authenticated admin API explicitly resolves the topic review as a violation. No HTTP executor is invoked.`, '',
    `Copied database: \`${database}\`; source database: \`${sourceSummary.database_path}\`; session: \`${sessionId}\`.`, '',
    ...results.map((x) => `- ${x.ok ? '✅' : '❌'} ${x.text}`), '',
    `Videos: \`${join(out, 'video')}\`.`, '',
  ].join('\n'));
  console.log(`Review continuation written to ${out}`);
  console.log(results.map((x) => `  ${x.ok ? 'OK ' : 'FAIL'} ${x.text}`).join('\n'));
  process.exitCode = results.some((x) => !x.ok) ? 1 : 0;
} finally {
  try { await app.close(); } catch {}
  try { store.close(); } catch {}
  if (!recorder.killed) recorder.kill('SIGTERM');
}
