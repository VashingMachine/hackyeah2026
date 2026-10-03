#!/usr/bin/env node
// Managed Pi launcher: creates a Blackwall session, then starts Pi with only the Blackwall extension,
// the Blackwall provider, a fixed tool set and an isolated agent directory.
//   node scripts/pi-launch.mjs --user onboarding-demo [--workspace DIR] [--server URL] -- [pi args...]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const mine = split === -1 ? argv : argv.slice(0, split);
const piArgs = split === -1 ? [] : argv.slice(split + 1);
const opt = (name, def) => {
  const i = mine.indexOf(`--${name}`);
  return i >= 0 ? mine[i + 1] : def;
};
const user = opt('user', 'onboarding-demo');
const server = opt('server', process.env.BLACKWALL_URL ?? 'http://127.0.0.1:8787');
const workspaceOpt = opt('workspace', undefined);
const userToken = process.env.BLACKWALL_USER_TOKEN ?? `demo-token-${user.replace(/-demo$/, '')}`;

const res = await fetch(`${server}/v1/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${userToken}` } });
if (!res.ok) {
  console.error(`Could not start a Blackwall session (HTTP ${res.status}). Is the server running at ${server}?`);
  process.exit(2);
}
const session = await res.json();
console.error(`[blackwall] session ${session.session_id} · user ${session.user} · profile ${session.profile}`);

// The working directory is assigned by the server's policy (trusted); --workspace only overrides it for tests.
const workspace = resolve(workspaceOpt ?? session.workdir ?? join(root, 'demo-workspace'));
const cli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const args = [
  cli, '-ne', '-ns', '-np', '--no-themes', '-nc', '--no-session',
  '-e', join(root, 'plugin', 'blackwall.ts'),
  '--provider', 'blackwall', '--model', process.env.BLACKWALL_MODEL ?? 'demo-agent',
  '--tools', 'read,write,edit,ls,find,grep,bash,http_request',
  ...piArgs,
];
const child = spawn(process.execPath, args, {
  cwd: workspace,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TERM: process.env.TERM, LANG: process.env.LANG,
    PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), 'bw-pi-agent-')),
    PI_OFFLINE: '1',
    BLACKWALL_URL: server, BLACKWALL_SESSION_TOKEN: session.session_token,
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
