import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const root = process.env.SITE_QA_ROOT || path.resolve(import.meta.dirname, fs.existsSync(path.resolve(import.meta.dirname, '../../source/dist')) ? '../../source/dist' : '../../published/dist');
const out = process.env.SITE_QA_OUTPUT || import.meta.dirname;
fs.mkdirSync(out, {recursive:true});
const base = 'http://127.0.0.1:8790/presentation.html';
const openDetails = async page => page.evaluate(() => { ['audit-details','sequence-details','policy-details'].forEach(id => { const d=document.getElementById(id); if(d) d.open=true; }); const picker=document.querySelector('.recording-picker'); if(picker) picker.open=true; });

const checks = [];
const findings = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail });
  if (!ok) findings.push({ severity: 'failure', topic: name, detail });
};
const norm = value => (value ?? '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.emulateMedia({ reducedMotion: 'reduce' });
const errors = [];
const failedResponses = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.status() >= 400 && new URL(response.url()).host === '127.0.0.1:8790') {
    failedResponses.push({ url: response.url(), status: response.status() });
  }
});

await page.goto(base, { waitUntil: 'networkidle' });
await openDetails(page);
await page.waitForSelector('.session-item');
await page.waitForSelector('#policy-fields [data-policy-field]');

const sessionData = JSON.parse(fs.readFileSync(path.join(root, 'assets/session-contexts.json'), 'utf8'));
const policyData = JSON.parse(fs.readFileSync(path.join(root, 'assets/policy-guide.json'), 'utf8'));
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'assets/evidence.json'), 'utf8'));
const fieldById = new Map(policyData.fields.map(field => [field.id, field]));

// Existing core presentation contract, plus the ninth chapter introduced by the guide.
check('six source sessions remain available', await page.locator('.session-item').count() === 6);
check('eight genuine clips remain available', await page.locator('.video-choice').count() === 8);
check('nine presentation chapters are available', await page.locator('[data-slide]').count() === 9);
check('all generated policy fields are represented', await page.locator('#policy-field-count').innerText().then(text => Number(text.split('/')[0]) === policyData.fields.length && Number(text.split('/')[1]) === policyData.fields.length));

// Verify the per-session prompt/context panel follows each session and does not collapse
// recorded agent context into Blackwall's decision or into a generic replay label.
const sessionButtons = page.locator('.session-item');
const sessions = await sessionButtons.evaluateAll(buttons => buttons.map(button => ({
  id: button.dataset.session,
  title: button.innerText
})));
const promptSamples = [];
for (const session of sessions) {
  await page.locator(`[data-session="${session.id}"]`).click();
  const prompt = norm(await page.locator('#session-prompt').innerText());
  const promptKind = norm(await page.locator('#session-prompt-kind').innerText());
  const agentAction = norm(await page.locator('#session-agent-action').innerText());
  const blackwallAction = norm(await page.locator('#session-blackwall-action').innerText());
  const features = norm(await page.locator('#session-features').innerText());
  const featureSummary = norm(await page.locator('#session-feature-summary').innerText());
  const provenance = norm(await page.locator('#session-prompt-note').innerText());
  check(`session context is populated for ${session.id}`, prompt.length > 15 && promptKind.length > 4 && agentAction.length > 5 && blackwallAction.length > 5 && features.length > 5 && featureSummary.length > 10);
  const expected = sessionData.sessions.find(item => item.id === session.id);
  check(`session copy matches source context for ${session.id}`, Boolean(expected && prompt === norm(expected.prompt.text) && agentAction === norm(expected.agentAction) && blackwallAction === norm(expected.blackwallAction)));
  check(`session source is disclosed for ${session.id}`, Boolean(expected && provenance.includes(expected.prompt.source)));
  check(`feature summary matches source context for ${session.id}`, Boolean(expected && featureSummary === norm(expected.featureSummary)));
  if (expected?.replayProposal) {
    check(`replay proposal is separately labeled for ${session.id}`, await page.locator('#session-replay-proposal').isVisible() && norm(await page.locator('#session-replay-text').innerText()) === norm(expected.replayProposal.text) && norm(await page.locator('#session-replay-note').innerText()).includes(expected.replayProposal.source));
  } else {
    check(`no fabricated replay is shown for ${session.id}`, await page.locator('#session-replay-proposal').isHidden());
  }
  if (expected?.prompt.kind === 'harness_user_task') {
    check(`harness-originated task is labeled as replay for ${session.id}`, /replay|harness|odtwor/i.test(promptKind) && /harness/i.test(agentAction));
  }
  if (expected?.prompt.kind === 'originating_human_task') {
    check(`originating task kind is explained for ${session.id}`, /recorded|scenario|original|task/i.test(promptKind) && provenance.includes(expected.prompt.source));
  }
  promptSamples.push({ id: session.id, prompt, promptKind, provenance, agentAction, blackwallAction, features });
}
check('distinct source tasks remain distinguishable', new Set(promptSamples.map(s => s.prompt)).size >= 5);
check('only the continuation reuses its originating task prompt', promptSamples.find(s => s.id === 'ma-publication-block')?.prompt === promptSamples.find(s => s.id === 'uncertain-review-continuation')?.prompt);
check('context kind is explicit for each session', promptSamples.every(s => s.promptKind.length > 4));
check('prompt/context panel has session-specific details', new Set(promptSamples.map(s => `${s.agentAction}|${s.blackwallAction}`)).size >= 5);

// The event feature explanation should be tied to actual event attributes and chips.
const eventRows = page.locator('#event-log .event-row');
await eventRows.first().click();
const explanation = norm(await page.locator('#event-feature-explanation').innerText());
const featureChips = await page.locator('#event-feature-chips').innerText();
check('selected event explains its features', explanation.length > 20 && norm(featureChips).length > 2);

// Filter/search the policy field catalogue and exercise pointer, keyboard, and touch-like selection.
const fieldButtons = page.locator('#policy-fields button[data-policy-field]');
const allFieldCount = await fieldButtons.count();
check('policy catalogue contains fields', allFieldCount > 5);
const firstField = fieldButtons.first();
const firstFieldId = await firstField.getAttribute('data-policy-field');
await firstField.hover();
const hoverTitle = norm(await page.locator('#policy-field-title').innerText());
check('hover updates policy field detail', hoverTitle.length > 0 && norm(await page.locator('#policy-field-path').innerText()) === norm(fieldById.get(firstFieldId)?.path));
await firstField.focus();
check('keyboard focus updates policy field detail', norm(await page.locator('#policy-field-title').innerText()).length > 0 && norm(await page.locator('#policy-field-path').innerText()) === norm(fieldById.get(firstFieldId)?.path));
await firstField.click();
check('click selects a policy field', (await firstField.getAttribute('aria-pressed') === 'true' || await firstField.getAttribute('aria-selected') === 'true'));
const selectedDetail = norm(await page.locator('#policy-description').innerText());
check('selected policy field has a description', selectedDetail.length > 12);

const searchable = await fieldButtons.evaluateAll(buttons => buttons.map(b => ({ id: b.dataset.policyField, text: b.innerText.replace(/\s+/g, ' ').trim() })));
const searchTarget = searchable.find(field => field.text.length > 2);
const searchInput = page.locator('#policy-search');
const wildcardAliasField = policyData.fields.find(field => field.aliases?.some(alias => alias.includes('*')));
if (wildcardAliasField) {
  const wildcardAlias = wildcardAliasField.aliases.find(alias => alias.includes('*'));
  await searchInput.fill(wildcardAlias);
  const aliasIds = await fieldButtons.evaluateAll(buttons => buttons.map(button => button.dataset.policyField));
  check('search finds wildcard alias and resolves its field', aliasIds.includes(wildcardAliasField.id));
} else {
  await searchInput.fill(searchTarget.text.split(/\s+/)[0]);
  check('search narrows the policy catalogue', await fieldButtons.count() > 0 && await fieldButtons.count() < allFieldCount);
}
await searchInput.fill('__guide_qa_no_match__');
check('search shows a useful no-results state', await fieldButtons.count() === 0 && await page.locator('#policy-no-results').isVisible());
await searchInput.fill('*');
check('wildcard search restores the catalogue', await fieldButtons.count() === allFieldCount);
const groups = page.locator('#policy-group option');
if (await groups.count() > 1) {
  const groupValue = await groups.nth(1).getAttribute('value');
  await page.locator('#policy-group').selectOption(groupValue);
  const groupCount = await fieldButtons.count();
  check('policy group filter reduces catalogue', groupCount > 0 && groupCount < allFieldCount);
  await page.locator('#policy-group').selectOption('all');
}
await page.locator('#policy-scope').selectOption('runtime');
const runtimeCount = await fieldButtons.count();
check('runtime publication filter has fields', runtimeCount > 0 && runtimeCount < allFieldCount);
await page.locator('#policy-scope').selectOption('startup');
const startupCount = await fieldButtons.count();
check('startup configuration filter complements runtime fields', startupCount > 0 && runtimeCount + startupCount === allFieldCount);
await page.locator('#policy-scope').selectOption('all');

// Three actual publication examples link to exact schema paths in the full guide.
await page.locator('#policy-show-json').click();
const jsonFieldButtons = page.locator('#policy-json button[data-policy-field]');
check('annotated publication JSON links known policy fields', await jsonFieldButtons.count() > 0);
const examples = page.locator('#policy-json-example option');
check('policy JSON has three selectable publication examples', await examples.count() === 3);
for (let i = 0; i < await examples.count(); i++) {
  await page.locator('#policy-json-example').selectOption({ index: i });
  const activeIds = await jsonFieldButtons.evaluateAll(buttons => buttons.map(b => b.dataset.policyField));
  const code = await page.locator('#policy-json').innerText();
  const example = policyData.examples[i];
  const expectedIds = [];
  const matchesPath = (pattern, value) => {
    const left = pattern.split('.'), right = value.split('.');
    return left.length === right.length && left.every((part, index) => part === '*' || part === right[index]);
  };
  const resolvePath = value => {
    const candidates = [value, value.replace(/^changes\./, '')];
    return policyData.fields.find(field => candidates.some(candidate => [field.path, ...(field.aliases || [])].some(pattern => matchesPath(pattern, candidate))))?.id;
  };
  const visit = (value, prefix = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${key}` : key;
      const id = resolvePath(next);
      if (id) expectedIds.push(id);
      visit(nested, next);
    }
  };
  visit(example.patch);
  check(`example ${i + 1} JSON field links match exact schema paths`, activeIds.length > 0 && activeIds.length === expectedIds.length && activeIds.every((id, index) => id === expectedIds[index] && fieldById.has(id)));
  check(`example ${i + 1} renders valid JSON`, (() => { try { JSON.parse(code); return true; } catch { return false; } })());
  if (activeIds.length) {
    const id = activeIds[0];
    await page.locator(`#policy-json button[data-policy-field="${id}"]`).click();
    check(`example ${i + 1} field reference opens its exact path`, norm(await page.locator('#policy-field-path').innerText()) === norm(fieldById.get(id).path));
  }
}

// Compare high-risk copy directly with runtime behavior and retain any coverage gaps for review.
check('policy guide explains that observe preserves hard blocks', /observe.*hard (?:blocks|denials)/i.test(policyData.scopeNote || ''));
const approvalField = policyData.fields.find(field => field.path === 'approvals.eligible_reason_codes');
const coreSource = fs.readFileSync(path.resolve(root, '../../../../blackwall/src/engine/core.ts'), 'utf8');
const runtimeHasHardApprovalGate = /needed\.every\(\(r\) => this\.policy\.approvals\.eligible_reason_codes\.includes\(r\)\)/.test(coreSource);
check('approval guidance states enabled and every required reason must be eligible', Boolean(approvalField && /approvals\.enabled\s*=\s*true/i.test(approvalField.effect) && /every required reason.*(?:list|eligible)/i.test(approvalField.effect)));
check('approval guidance explicitly excludes hard refusals and earlier API authentication', Boolean(approvalField && /(?:does not|cannot).*hard (?:denials|refusals)/i.test(approvalField.limits) && /API authentication.*(?:earlier|before)/i.test(approvalField.limits) && /(?:list.*does not replace|does not replace.*authentication)/i.test(approvalField.limits)));
check('runtime applies the all-reasons approval gate and keeps hard blocks outside observe mode', runtimeHasHardApprovalGate && /const hard = reasons\.some\(\(r\) => HARD\.has\(r\)\)/.test(coreSource) && /effect !== 'allow' && !hard/.test(coreSource));
if (approvalField) {
  await page.evaluate(id => window.BlackwallPolicyGuide.selectField(id), approvalField.id);
  check('approval detail displays the guarded eligibility scope', norm(await page.locator('#policy-effect').innerText()) === norm(approvalField.effect) && norm(await page.locator('#policy-limits').innerText()).includes(norm(approvalField.limits)));
}
const isolationFields = policyData.fields.filter(field => /execution_profile|require_isolation/.test(field.path));
check('isolated profile copy does not claim to provide an OS sandbox', isolationFields.length >= 2 && isolationFields.every(field => /does not (?:provide|create|detect)|declar/i.test(`${field.description} ${field.effect} ${field.limits}`)));

const policyDescription = norm(await page.locator('#policy-description').innerText());
const policyEffect = norm(await page.locator('#policy-effect').innerText());
const policyExample = norm(await page.locator('#policy-example').innerText());
const policyLimits = norm(await page.locator('#policy-limits').innerText());
const policyEditable = norm(await page.locator('#policy-editable').innerText());
check('policy detail states meaning, effect, example, limits and editability', policyDescription.length > 5 && policyEffect.length > 5 && policyExample.length > 0 && policyLimits.length > 5 && policyEditable.length > 5);

// Evidence references must resolve to files belonging to the named video/screen/notes source.
const videoEvidenceField = policyData.fields.find(field => field.evidence?.videoId);
check('guide contains fields linked to genuine video evidence', Boolean(videoEvidenceField));
if (videoEvidenceField) await page.evaluate(id => window.BlackwallPolicyGuide.selectField(id), videoEvidenceField.id);
const expectedClip = videoEvidenceField && evidence.videos.find(video => video.id === videoEvidenceField.evidence.videoId);
const scopedVideoPath = await page.locator('#policy-evidence video').getAttribute('src').catch(() => null);
check('selected field shows its declared genuine clip', Boolean(expectedClip && scopedVideoPath?.endsWith(expectedClip.file.replace(/^assets/, ''))));
check('clip evidence note describes the scope of that clip', norm(await page.locator('#policy-evidence').innerText()).includes(norm(videoEvidenceField?.evidence?.note)));
const screenEvidenceField = policyData.fields.find(field => field.evidence?.screenId);
if (screenEvidenceField) {
  await page.evaluate(id => window.BlackwallPolicyGuide.selectField(id), screenEvidenceField.id);
  const screenSource = await page.locator('#policy-evidence img').getAttribute('src').catch(() => null);
  check('selected field shows its declared genuine screen', Boolean(screenSource && screenSource.startsWith('assets/screens/')));
  const screenStatus = await page.locator('#policy-evidence img').evaluate(async image => {
    if (!image.complete) await new Promise(resolve => { image.onload = resolve; image.onerror = resolve; });
    return { complete: image.complete, naturalWidth: image.naturalWidth };
  });
  check('selected evidence screen actually loads', screenStatus.complete && screenStatus.naturalWidth > 0, JSON.stringify(screenStatus));
}
const media = await page.locator('#policy-evidence').evaluate(el => ({
  links: [...el.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), text: a.innerText })),
  images: [...el.querySelectorAll('img[src]')].map(i => ({ src: i.getAttribute('src'), alt: i.alt })),
  videos: [...el.querySelectorAll('video source[src], video[src]')].map(v => v.getAttribute('src')),
  text: el.innerText
}));
check('policy evidence includes scoped media or notes', media.links.length + media.images.length + media.videos.length > 0 || norm(media.text).length > 20);
for (const asset of [...media.links.map(x => x.href), ...media.images.map(x => x.src), ...media.videos]) {
  check(`policy evidence path stays within local assets (${asset})`, typeof asset === 'string' && asset.startsWith('assets/') && !asset.includes('..'));
}

// Schema downloads should be local, named, and parseable.
for (const id of ['download-policy-schema', 'download-publication-schema']) {
  const anchor = page.locator(`#${id}`);
  const href = await anchor.getAttribute('href');
  check(`${id} points to a local schema`, Boolean(href && href.startsWith('assets/') && href.endsWith('.schema.json')));
  const schema = JSON.parse(fs.readFileSync(path.join(root, href), 'utf8'));
  check(`${id} downloads valid JSON schema`, schema.$schema?.includes('json-schema.org') && typeof schema.type === 'string');
}

await page.evaluate(() => {
  const top = document.querySelector('#policy-explorer').getBoundingClientRect().top + scrollY - 94;
  scrollTo({ top, behavior: 'instant' });
});
await page.waitForFunction(() => document.querySelector('#policy-explorer').classList.contains('visible'));
await page.locator('#policy-evidence img').evaluate(async image => {
  if (image && !image.complete) await new Promise(resolve => { image.onload = resolve; image.onerror = resolve; });
});
await page.screenshot({ path: path.join(out, 'guide-desktop.png'), fullPage: false });

// Failure path: guide data fails once, then recovers via the visible retry action.
await page.close();
const faultPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let failPolicyOnce = true;
await faultPage.route('**/assets/policy-guide.json', route => {
  if (failPolicyOnce) return route.fulfill({ status: 503, body: 'temporarily unavailable' });
  return route.continue();
});
faultPage.on('pageerror', error => errors.push(error.message));
faultPage.on('response', response => {
  if (response.status() >= 400 && new URL(response.url()).host === '127.0.0.1:8790') {
    failedResponses.push({ url: response.url(), status: response.status() });
  }
});
await faultPage.goto(base, { waitUntil: 'networkidle' });
await openDetails(faultPage);
await faultPage.waitForTimeout(150);
check('policy guide failure shows retry state', await faultPage.locator('#policy-retry').isVisible());
failPolicyOnce = false;
await faultPage.locator('#policy-retry').click();
await faultPage.waitForSelector('#policy-fields button[data-policy-field]');
check('policy guide retry recovers field catalogue', await faultPage.locator('#policy-fields button[data-policy-field]').count() > 5);

// Responsive layout and keyboard selection.
await faultPage.setViewportSize({ width: 390, height: 844 });
await faultPage.evaluate(() => {
  const top = document.querySelector('#policy-explorer').getBoundingClientRect().top + scrollY - 94;
  scrollTo({ top, behavior: 'instant' });
});
await faultPage.waitForFunction(() => document.querySelector('#policy-explorer').classList.contains('visible'));
await faultPage.waitForTimeout(400);
check('mobile guide has no horizontal page overflow', await faultPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await faultPage.screenshot({ path: path.join(out, 'guide-mobile.png'), fullPage: false });
await faultPage.locator('#policy-search').focus();
await faultPage.locator('#policy-search').fill('');
const firstMobileField = faultPage.locator('#policy-fields button[data-policy-field]').first();
const secondMobileField = faultPage.locator('#policy-fields button[data-policy-field]').nth(1);
const secondMobileId = await secondMobileField.getAttribute('data-policy-field');
await firstMobileField.focus();
await faultPage.keyboard.press('ArrowDown');
await faultPage.keyboard.press('Enter');
check('keyboard navigation selects the next policy field on mobile viewport', await secondMobileField.getAttribute('aria-selected') === 'true' && norm(await faultPage.locator('#policy-field-path').innerText()) === norm(fieldById.get(secondMobileId)?.path));

const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
const touchPage = await touchContext.newPage();
await touchPage.goto(base, { waitUntil: 'networkidle' });
await openDetails(touchPage);
await touchPage.waitForSelector('#policy-fields button[data-policy-field]');
const touchTarget = touchPage.locator('#policy-fields button[data-policy-field]').nth(1);
await touchTarget.tap();
check('touch selection updates the policy detail', await touchTarget.getAttribute('aria-selected') === 'true' && norm(await touchPage.locator('#policy-field-path').innerText()).length > 0);
check('touch layout has no horizontal page overflow', await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await touchContext.close();

// A broken evidence media URL must have an understandable fallback.
await faultPage.route('**/assets/videos/**', route => route.fulfill({ status: 404, body: 'missing' }));
const faultVideoField = policyData.fields.find(field => field.evidence?.videoId);
if (faultVideoField) await faultPage.evaluate(id => window.BlackwallPolicyGuide.selectField(id), faultVideoField.id);
const policyVideo = faultPage.locator('#policy-evidence video');
await policyVideo.evaluate(v => { v.load(); });
await faultPage.waitForSelector('#policy-evidence .media-fallback:not([hidden])');
check('failed evidence video has a visible fallback', await faultPage.locator('#policy-evidence .media-fallback').isVisible());

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Local static Blackwall presentation and guide UI; no live agent backend, model API, external publication, or paid service.',
  checks,
  findings,
  errors,
  failedResponses,
  sessionPromptSamples: promptSamples,
  mediaInventory: media,
  policyDataTopLevelKeys: Object.keys(policyData),
  sessionDataTopLevelKeys: Object.keys(sessionData),
  evidenceCounts: { sessions: evidence.sessions.length, videos: evidence.videos.length }
};
report.sourceHashes = Object.fromEntries(['session-contexts.json', 'policy-guide.json', 'policy.schema.json', 'policy-publication.schema.json'].map(name => {
  const bytes = fs.readFileSync(path.join(root, 'assets', name));
  return [name, crypto.createHash('sha256').update(bytes).digest('hex')];
}));
report.contextCoverage = {
  sessions: sessionData.sessions.map(session => ({ id: session.id, kind: session.prompt.kind, source: session.prompt.source, replayKind: session.replayProposal?.kind ?? null, explainedEventSequences: Object.keys(session.events).length })),
  totalExplainedEventSequences: sessionData.sessions.reduce((sum, session) => sum + Object.keys(session.events).length, 0),
  policyFields: policyData.fields.length,
  featureIdsWithoutGuideFields: Object.keys(sessionData.featureCatalog).filter(id => !policyData.fields.some(field => field.featureIds?.includes(id)))
};
check('no uncaught browser exceptions', errors.length === 0, errors.join('; '));
const unexpectedResponses = failedResponses.filter(response => !(
  (response.status === 503 && response.url.endsWith('/assets/policy-guide.json')) ||
  (response.status === 404 && response.url.includes('/assets/videos/'))
));
check('only the intentional failure injection returned an error', unexpectedResponses.length === 0, JSON.stringify(unexpectedResponses));
report.checks = checks;
report.findings = findings;
report.errors = errors;
report.failedResponses = failedResponses;
fs.writeFileSync(path.join(out, 'guide-qa.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.filter(c => c.result === 'PASS').length, total: checks.length, findings, report: path.join(out, 'guide-qa.json') }, null, 2));
await browser.close();
process.exitCode = checks.some(c => c.result === 'FAIL') ? 1 : 0;
