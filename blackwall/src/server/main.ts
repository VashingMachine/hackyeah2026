import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyFile } from '../config/load.ts';
import { buildApp } from './app.ts';
import { buildCore } from './build.ts';
import { loadEnv } from '../util/env.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

Object.assign(process.env, loadEnv([join(root, '.env'), join(root, '..', '.env')]));
const policyPath = process.env.BLACKWALL_POLICY ?? join(root, 'config', 'policy.yaml');
const policy = loadPolicyFile(policyPath);
if (process.env.BLACKWALL_DB) policy.audit.db_path = process.env.BLACKWALL_DB;
const core = buildCore(policy, process.env);

const adminToken = process.env.BLACKWALL_ADMIN_TOKEN ?? 'demo-admin-token';
if (!process.env.BLACKWALL_ADMIN_TOKEN) console.warn('[blackwall] BLACKWALL_ADMIN_TOKEN is not set: using the demo admin token. Do not expose this server.');

const app = buildApp(core, {
  adminToken,
  gateway: { openaiKey: process.env.OPENAI_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.BLACKWALL_OPENAI_RESPONSES_URL, evaluateToolCalls: process.env.BLACKWALL_GATEWAY_TOOLS === '1' },
  dashboardDir: join(root, 'dashboard'),
  logger: process.env.BLACKWALL_LOG === '1',
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

// Embed the topic catalog once at startup, before the first session event.
core.detector.init().then(
  () => console.log(`[blackwall] topic detector ready (${core.detector.embedderName})`),
  (e) => console.error('[blackwall] topic detector failed to start:', (e as Error).message),
);

setInterval(() => { try { core.sweepExpiredApprovals(); } catch (e) { console.error('[blackwall] approval sweep failed:', (e as Error).message); } }, 5000).unref();

await app.listen({ port, host });
console.log(`[blackwall] policy ${core.policy.policy_id} v${core.policy.version} · profile ${core.policy.profile} · mode ${core.policy.mode}`);
console.log(`[blackwall] http://${host}:${port}  (dashboard: /dashboard, health: /healthz)`);
