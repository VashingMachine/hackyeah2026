import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyFile } from '../config/load.ts';
import { buildApp } from './app.ts';
import { buildCore, requireEnv } from './build.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read KEY=VALUE pairs from the repo-level .env without overriding variables that are already set. */
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

loadDotenv(join(root, '..', '.env'));
const policyPath = process.env.BLACKWALL_POLICY ?? join(root, 'config', 'policy.yaml');
const policy = loadPolicyFile(policyPath);
if (process.env.BLACKWALL_DB) policy.audit.db_path = process.env.BLACKWALL_DB;
const core = buildCore(policy, process.env);

const adminToken = process.env.BLACKWALL_ADMIN_TOKEN ?? 'demo-admin-token';
if (!process.env.BLACKWALL_ADMIN_TOKEN) console.warn('[blackwall] BLACKWALL_ADMIN_TOKEN is not set: using the demo admin token. Do not expose this server.');

const app = buildApp(core, {
  adminToken,
  gateway: { anthropicKey: requireEnv(process.env, 'ANTHROPIC_API_KEY'), evaluateToolCalls: process.env.BLACKWALL_GATEWAY_TOOLS === '1' },
  dashboardDir: join(root, 'dashboard'),
  logger: process.env.BLACKWALL_LOG === '1',
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

// Warm the local embedding model so the first event is not slow.
core.detector.init().then(
  () => console.log(`[blackwall] topic detector ready (${core.detector.embedderName})`),
  (e) => console.error('[blackwall] topic detector failed to start:', (e as Error).message),
);

setInterval(() => { try { core.sweepExpiredApprovals(); } catch (e) { console.error('[blackwall] approval sweep failed:', (e as Error).message); } }, 5000).unref();

await app.listen({ port, host });
console.log(`[blackwall] policy ${policy.policy_id} v${policy.version} · profile ${policy.profile} · mode ${policy.mode}`);
console.log(`[blackwall] http://${host}:${port}  (dashboard: /dashboard, health: /healthz)`);
