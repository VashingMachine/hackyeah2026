// Full reproducible verification; fail rather than silently skipping real-provider tests.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { loadEnv } from '../src/util/env.ts';
const root = resolve(import.meta.dirname, '..');
const env = loadEnv([join(root, '.env'), join(root, '..', '.env')]);
if (!env.OPENAI_API_KEY || !env.JEV_API_KEY) throw new Error('Full verification requires OPENAI_API_KEY and JEV_API_KEY in blackwall/.env or the environment. No values are logged.');
mkdirSync(join(root, 'reports'), {recursive: true});
const suffixArg = process.argv.slice(2).find(arg => arg.startsWith('--report-suffix='));
const suffix = suffixArg?.slice('--report-suffix='.length) ?? 'final';
if (!/^[a-z0-9-]+$/.test(suffix)) throw new Error('Report suffix must contain lowercase letters, digits or hyphens.');
for (const args of [
  ['run', 'typecheck'],
  ['test', '--', '--reporter=json', `--outputFile=reports/unit-${suffix}.json`],
  ['run', 'test:live', '--', '--reporter=json', `--outputFile=reports/live-${suffix}.json`],
  ['run', 'test:e2e', '--', '--reporter=json', `--outputFile=reports/e2e-${suffix}.json`],
  ['run', 'eval', '--', '--strict'],
]) {
  console.log(`\n[verify] npm ${args.join(' ')}`);
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn('npm', args, {cwd: root, env: {...process.env, ...env}, stdio: 'inherit'});
    child.on('error', reject);
    child.on('exit', code => resolveExit(code ?? 1));
  });
  if (code) {process.exitCode = code; break;}
  const output = args.find(arg => arg.startsWith('--outputFile='))?.slice('--outputFile='.length);
  if (output) {
    const report = JSON.parse(readFileSync(join(root, output), 'utf8'));
    if (!report.numTotalTests || report.numPendingTests || report.numPassedTests !== report.numTotalTests)
      throw new Error(`Incomplete verification in ${output}: skipped or failed tests are not accepted.`);
  }
}
