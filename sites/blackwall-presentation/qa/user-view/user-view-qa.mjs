import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const root = process.env.SITE_QA_ROOT || path.resolve(import.meta.dirname, '../../source/dist');
const output = process.env.SITE_QA_OUTPUT || import.meta.dirname;
const base = process.env.SITE_QA_URL || 'http://127.0.0.1:8790/presentation.html';
fs.mkdirSync(output, { recursive: true });

const cases = [
  { id: 'hr', image: 'hr-blocked.png', mobileImage: 'hr-blocked-mobile.png', code: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION' },
  { id: 'client', image: 'client-blocked.png', mobileImage: 'client-blocked-mobile.png', code: 'CLIENT_SCOPE_VIOLATION' }
];
const checks = [], findings = [], pageErrors = [], apiRequests = [], failedResponses = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, result: pass ? 'PASS' : 'FAIL', detail });
  if (!pass) findings.push({ severity: 'failure', topic: name, detail });
};
const norm = value => (value ?? '').replace(/\s+/g, ' ').trim();
const visibleWordCount = value => (value.match(/\b[\p{L}\p{N}’'-]+\b/gu) || []).length;
const caseRecord = (evidence, id) => {
  const collections = [evidence.cases, evidence.sessions, evidence.gallery, evidence.records];
  for (const collection of collections) {
    if (Array.isArray(collection)) {
      const record = collection.find(item => [item?.id, item?.case_id, item?.caseId, item?.slug].some(value => value === id || value === id.replace('-blocked', '')));
      if (record) return record;
    } else if (collection && typeof collection === 'object') {
      const record = collection[id] || collection[id.replace('-blocked', '')];
      if (record) return record;
    }
  }
  return null;
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
context.on('page', opened => opened.on('pageerror', error => pageErrors.push(error.message)));
context.on('request', request => {
  const url = new URL(request.url());
  const siteOrigin = new URL(base).origin;
  const apiPath = /^\/(?:api|v\d+)\b/i.test(url.pathname);
  const dynamicOffsite = ['fetch', 'xhr'].includes(request.resourceType()) && url.origin !== siteOrigin;
  const expectedFontAsset = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(url.origin)
    && ['stylesheet', 'font'].includes(request.resourceType());
  const offsite = url.origin !== siteOrigin && !['data:', 'blob:'].includes(url.protocol) && !expectedFontAsset;
  if (apiPath || dynamicOffsite || offsite) apiRequests.push({ url: request.url(), type: request.resourceType() });
});
context.on('response', response => {
  if (response.status() >= 400 && new URL(response.url()).origin === new URL(base).origin) failedResponses.push({ url: response.url(), status: response.status() });
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('.user-view-card');
const gallery = page.locator('.user-view-card');
check('gallery has exactly two Pi session cards', await gallery.count() === 2);

const evidenceHref = await page.locator('.user-view-source a[href$="evidence.json"]').getAttribute('href');
check('gallery links to its capture evidence JSON', typeof evidenceHref === 'string' && evidenceHref.startsWith('assets/user-view/') && evidenceHref.endsWith('evidence.json'));
const evidence = evidenceHref ? JSON.parse(fs.readFileSync(path.join(root, evidenceHref), 'utf8')) : {};

for (let i = 0; i < cases.length; i++) {
  const expected = cases[i];
  const card = gallery.nth(i);
  const cardText = norm(await card.innerText());
  const caption = norm(await card.locator('.user-view-caption').innerText());
  const image = card.locator('.user-view-image img');
  const imageHref = await card.locator('.user-view-image').getAttribute('href');
  const conversationHref = await card.locator('.user-view-caption a[href$="-conversation.html"]').getAttribute('href');
  await card.scrollIntoViewIfNeeded();
  await image.evaluate(el => el.decode());
  const imageState = await image.evaluate(el => ({ complete: el.complete, width: el.naturalWidth, currentSrc: el.currentSrc }));
  check(`${expected.id}: desktop capture loads`, imageState.complete && imageState.width > 0, JSON.stringify(imageState));
  check(`${expected.id}: screenshot link targets the same real capture`, Boolean(imageHref && imageHref.endsWith(`/${expected.image}`)));

  const record = caseRecord(evidence, expected.id);
  check(`${expected.id}: evidence JSON contains a matching capture record`, Boolean(record), record ? '' : `available keys: ${Object.keys(evidence).join(', ')}`);
  check(`${expected.id}: evidence records the original block reason and terminated state`, record?.reason_code === expected.code && record?.status === 'terminated', JSON.stringify({ reason_code: record?.reason_code, status: record?.status }));
  const desktopCapture = record?.captures?.find(item => item.kind === 'desktop');
  check(`${expected.id}: displayed desktop capture matches the source manifest`, Boolean(desktopCapture && imageHref === desktopCapture.image && desktopCapture.sourceExport === record.export), JSON.stringify(desktopCapture));
  check(`${expected.id}: desktop image dimensions match the source manifest`, Boolean(desktopCapture && imageState.width === desktopCapture.cssDimensions.width * desktopCapture.deviceScaleFactor && await image.evaluate(el => el.naturalHeight) === desktopCapture.cssDimensions.height * desktopCapture.deviceScaleFactor), JSON.stringify({ desktopCapture, width: imageState.width }));
  check(`${expected.id}: gallery caption describes a blocked user action`, /stopped|blocked|cannot answer/i.test(caption), caption);

  check(`${expected.id}: full conversation HTML link is local`, Boolean(conversationHref && conversationHref.startsWith('assets/user-view/') && conversationHref.endsWith('.html')));
  check(`${expected.id}: card links to the export named by its evidence record`, Boolean(record && conversationHref === record.export));
  const exportBytes = record?.export ? fs.readFileSync(path.join(root, record.export)) : Buffer.alloc(0);
  const exportHash = crypto.createHash('sha256').update(exportBytes).digest('hex');
  check(`${expected.id}: public HTML export hash matches its evidence record`, Boolean(record?.public_export_sha256 && exportHash === record.public_export_sha256), exportHash);
  const conversationPagePromise = context.waitForEvent('page');
  await card.locator(`a[href="${conversationHref}"]`).click();
  const conversationPage = await conversationPagePromise;
  await conversationPage.waitForLoadState('domcontentloaded');
  const conversationText = norm(await conversationPage.locator('body').innerText());
  const conversationUrl = new URL(conversationPage.url());
  check(`${expected.id}: full conversation opens from the card`, conversationUrl.pathname.endsWith(conversationHref.replace(/^\.\//, '').replace(/^\//, '')) && conversationText.length > 100);
  await conversationPage.waitForSelector('#session-data', { state: 'attached' });
  const exported = await conversationPage.evaluate(() => {
    const encoded = document.querySelector('#session-data')?.textContent?.trim();
    const session = JSON.parse(atob(encoded || ''));
    const messages = (session.entries || []).filter(entry => entry.type === 'message').map(entry => entry.message || {});
    const prompts = messages.filter(message => message.role === 'user').flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text) : []);
    const errors = messages.map(message => message.errorMessage).filter(Boolean);
    const toolCalls = messages.reduce((count, message) => count + (Array.isArray(message.content) ? message.content.filter(part => part.type === 'toolCall').length : 0), 0);
    return { prompts, errors, toolCalls, roles: messages.map(message => message.role) };
  });
  check(`${expected.id}: export preserves every original user prompt`, Array.isArray(record?.prompts) && record.prompts.length > 0 && JSON.stringify(exported.prompts) === JSON.stringify(record.prompts), JSON.stringify({ evidencePrompts: record?.prompts, exportPrompts: exported.prompts }));
  check(`${expected.id}: rendered conversation visibly shows the blocked user prompt`, Boolean(record?.blocked_prompt && conversationText.includes(norm(record.blocked_prompt))));
  check(`${expected.id}: embedded Pi session data preserves the exact gateway error`, Array.isArray(exported.errors) && exported.errors.includes(record?.error), JSON.stringify(exported.errors));
  check(`${expected.id}: rendered conversation shows the matching 403 reason`, conversationText.includes(expected.code) && conversationText.includes('403'));
  check(`${expected.id}: zero model requests were made for the blocked prompt`, record?.agent_model_requests_for_blocked_prompt === 0);
  if (expected.id === 'hr') {
    check('HR caption claim is backed by the recorded request count', /never reaches the agent model/i.test(caption) && record.agent_model_requests_for_blocked_prompt === 0);
    check('HR earlier benign conversation remains reflected in evidence', record.agent_model_requests_by_prompt?.[0] > 0 && record.agent_model_requests_by_prompt?.[1] === 0);
  } else {
    check('client-file caption claim is backed by zero tool calls', /before any file is read/i.test(caption) && record.tool_calls === 0 && exported.toolCalls === 0);
  }
  await conversationPage.close();
}

const visibleCopy = await page.locator('body').innerText();
check('visible site copy is within the 650-word jury budget', visibleWordCount(visibleCopy) <= 650, `words=${visibleWordCount(visibleCopy)}`);
check('no console page errors or failed local requests', pageErrors.length === 0 && failedResponses.length === 0, JSON.stringify({ pageErrors, failedResponses }));
check('no API, XHR, or unexpected remote requests (Google Fonts assets are presentation styling)', apiRequests.length === 0, JSON.stringify(apiRequests));
await page.locator('#user-view').scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(output, 'user-view-desktop.png'), fullPage: false });

await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#user-view').scrollIntoViewIfNeeded();
for (let i = 0; i < cases.length; i++) {
  const expected = cases[i];
  const image = page.locator('.user-view-card').nth(i).locator('.user-view-image img');
  await image.evaluate(el => el.decode());
  const state = await image.evaluate(el => ({ complete: el.complete, width: el.naturalWidth, currentSrc: el.currentSrc }));
  check(`${expected.id}: mobile capture loads its responsive image`, state.complete && state.width > 0 && state.currentSrc.endsWith(`/${expected.mobileImage}`), JSON.stringify(state));
  const capture = caseRecord(evidence, expected.id)?.captures?.find(item => item.kind === 'mobile');
  check(`${expected.id}: mobile capture size matches its evidence record`, Boolean(capture && capture.image.endsWith(expected.mobileImage) && state.width === capture.cssDimensions.width * capture.deviceScaleFactor && await image.evaluate(el => el.naturalHeight) === capture.cssDimensions.height * capture.deviceScaleFactor), JSON.stringify({ capture, width: state.width }));
}
check('mobile gallery has no horizontal page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await page.screenshot({ path: path.join(output, 'user-view-mobile.png'), fullPage: false });

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Read-only verification of authentic Pi session-export gallery, screenshots, conversation pages and static presentation behavior. No live API or LLM calls.',
  checks,
  findings,
  pageErrors,
  apiRequests,
  failedResponses,
  evidenceHref,
  viewports: ['1440x1000', '390x844']
};
fs.writeFileSync(path.join(output, 'user-view-qa.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.filter(row => row.result === 'PASS').length, total: checks.length, findings, report: path.join(output, 'user-view-qa.json') }, null, 2));
await browser.close();
process.exitCode = findings.length ? 1 : 0;
