// Reopen a recorded demo dashboard without changing its frozen evidence database.
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = process.argv[2];
if (!arg) throw new Error('Usage: npm run demo:dashboard -- demo-recordings/<recording-directory>');
const demoDir = resolve(arg);
const summary = JSON.parse(readFileSync(join(demoDir, 'summary.json'), 'utf8'));
if (typeof summary.workspace_path !== 'string' || !existsSync(summary.workspace_path))
  throw new Error('The recorded synthetic workspace is missing. Videos, screenshots and audit remain usable; start a new demo for interactive sessions.');
const evidenceDb = join(demoDir, 'demo.sqlite');
if (!existsSync(evidenceDb)) throw new Error('The recording has no persistent demo.sqlite database.');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const dashboardDb = join(dataDir, `dashboard-${basename(demoDir)}.sqlite`);
if (!existsSync(dashboardDb)) copyFileSync(evidenceDb, dashboardDb, constants.COPYFILE_EXCL);
process.env.WORKSPACE = summary.workspace_path;
process.env.BLACKWALL_DB = dashboardDb;
process.env.HOST = '127.0.0.1';
process.env.PORT ??= '8787';
console.log(`[demo] frozen recording: ${demoDir}`);
console.log(`[demo] interactive database: ${dashboardDb}`);
await import('../src/server/main.ts');
