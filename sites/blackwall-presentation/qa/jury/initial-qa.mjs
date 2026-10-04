import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const output = process.env.SITE_QA_OUTPUT || import.meta.dirname;
fs.mkdirSync(output, { recursive: true });
const base = 'http://127.0.0.1:8790/presentation.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, result: pass ? 'PASS' : 'FAIL', detail });
  assert.ok(pass, `${name}${detail ? `: ${detail}` : ''}`);
};

await page.goto(base, { waitUntil: 'networkidle' });
const initial = await page.evaluate(() => {
  const detailIds = ['audit-details', 'sequence-details', 'policy-details'];
  const wordCount = (document.body.innerText.trim().match(/\b[\p{L}\p{N}’'-]+\b/gu) || []).length;
  const openingCopy = ['start', 'kontrola'].map(id => document.getElementById(id)?.innerText || '').join(' ');
  return {
    detailStates: Object.fromEntries(detailIds.map(id => [id, document.getElementById(id)?.open ?? null])),
    wordCount,
    openingWordCount: (openingCopy.match(/\b[\p{L}\p{N}’'-]+\b/gu) || []).length,
    flows: [...document.querySelectorAll('[data-flow]')].map(el => el.dataset.flow),
    demos: [...document.querySelectorAll('.proof-card button[data-demo-session]')].map(el => el.dataset.demoSession),
    presets: [...document.querySelectorAll('button[data-policy-preset]')].map(el => el.dataset.policyPreset),
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    visibleText: document.body.innerText.trim()
  };
});
check('technical audit, sequence and policy details start closed', Object.values(initial.detailStates).length === 3 && Object.values(initial.detailStates).every(value => value === false), JSON.stringify(initial.detailStates));
check('all initially visible page copy stays within the jury reading budget', initial.wordCount <= 650, `visible words=${initial.wordCount}`);
check('hero and interactive example stay under 150 words', initial.openingWordCount < 150, `opening words=${initial.openingWordCount}`);
check('three interactive flow choices are available', JSON.stringify(initial.flows) === JSON.stringify(['allow', 'approval', 'deny']), JSON.stringify(initial.flows));
check('three evidence cards target the selected recorded sessions', JSON.stringify([...initial.demos].sort()) === JSON.stringify(['client-path-gate', 'hr-polish-violation', 'kyc-approval'].sort()), JSON.stringify(initial.demos));
check('three policy presets are available', initial.presets.length === 3 && new Set(initial.presets).size === 3, JSON.stringify(initial.presets));
check('desktop page has no horizontal overflow while details are closed', !initial.overflow);

const deepLinks = [
  { hash: '#replay', detail: 'audit-details' },
  { hash: '#process-workbench', detail: 'sequence-details' },
  { hash: '#policy-explorer', detail: 'policy-details' }
];
for (const item of deepLinks) {
  await page.goto(base + item.hash, { waitUntil: 'networkidle' });
  await page.waitForFunction(id => document.querySelector(location.hash) && document.getElementById(id)?.open, item.detail, { timeout: 2500 }).catch(() => {});
  const result = await page.evaluate(id => {
    const target = document.querySelector(location.hash);
    const detail = document.getElementById(id);
    return { targetExists: Boolean(target), detailOpen: detail?.open ?? false };
  }, item.detail);
  check(`deep link ${item.hash} opens ${item.detail}`, result.targetExists && result.detailOpen, JSON.stringify(result));
}

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base, { waitUntil: 'networkidle' });
const mobile = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > innerWidth + 1,
  detailsClosed: ['audit-details', 'sequence-details', 'policy-details'].every(id => document.getElementById(id)?.open === false)
}));
check('mobile starts with details closed and no horizontal page overflow', mobile.detailsClosed && !mobile.overflow, JSON.stringify(mobile));
await page.screenshot({ path: path.join(output, 'jury-mobile-initial.png'), fullPage: false });

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Initial jury-facing information density, progressive disclosure, shortcuts, and closed-state layout. Run only after the source revision is ready.',
  initialVisibleWordCount: initial.wordCount,
  heroAndExampleWordCount: initial.openingWordCount,
  initialVisibleText: initial.visibleText,
  checks
};
fs.writeFileSync(path.join(output, 'initial-qa.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.filter(row => row.result === 'PASS').length, total: checks.length, initialVisibleWordCount: initial.wordCount, report: path.join(output, 'initial-qa.json') }, null, 2));
await browser.close();
