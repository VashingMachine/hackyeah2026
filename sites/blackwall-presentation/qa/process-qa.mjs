import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const root = process.env.SITE_QA_ROOT || path.resolve(import.meta.dirname, fs.existsSync(path.resolve(import.meta.dirname, '../source/dist')) ? '../source/dist' : '../published/dist');
const output = process.env.SITE_QA_OUTPUT || import.meta.dirname;
fs.mkdirSync(output, {recursive:true});
const url = 'http://127.0.0.1:8790/presentation.html#proces';
const bytes = fs.readFileSync(path.join(root, 'assets/process-flow.json'));
const data = JSON.parse(bytes);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const expectedHash = process.env.SITE_PROCESS_EXPECTED_SHA || '851c39566cbed0c43ba8caa52c9614422e0a495ede0ac8fae149a93bc1a1f1aa';
const checks = [], findings = [], errors = [], failedResponses = [];
const norm = value => (value ?? '').replace(/\s+/g, ' ').trim();
const check = (name, passed, detail = '') => {
  checks.push({ name, result: passed ? 'PASS' : 'FAIL', detail });
  if (!passed) findings.push({ severity: 'failure', topic: name, detail });
};
const actorsFor = scenario => {
  const used = new Set(scenario.sequenceMessages.flatMap(m => [m.from, m.to]));
  return data.nodes.map(node => node.id).filter(id => used.has(id));
};
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.emulateMedia({ reducedMotion: 'reduce' });
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.status() >= 400 && new URL(response.url()).host === '127.0.0.1:8790') failedResponses.push({ url: response.url(), status: response.status() });
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#process-scenario')?.options.length > 0);
check('Source data hash matches the reviewed fixture', hash === expectedHash, hash);
check('sequence fixture has expected coverage totals', data.scenarios.length === 8 && data.nodes.length === 10
  && data.scenarios.reduce((n, s) => n + s.steps.length, 0) === 48
  && data.scenarios.reduce((n, s) => n + s.sequenceMessages.length, 0) === 114);
check('default scenario is tool-allow', await page.locator('#process-scenario').inputValue() === 'tool-allow');
check('scenario selector and route count match fixture', await page.locator('#process-scenario option').count() === 8
  && norm(await page.locator('#process-routes-count').textContent()).toLowerCase() === '8 paths · 10 components');

let testedSteps = 0, testedMessages = 0, testedConditions = 0;
const scenarioResults = [];
for (const scenario of data.scenarios) {
  await page.locator('#process-scenario').selectOption(scenario.id);
  const messages = scenario.sequenceMessages;
  const expectedActors = actorsFor(scenario);
  const groups = page.locator('#process-map [data-sequence-group]');
  const rows = page.locator('#process-map button[data-sequence-message]');
  const actualActors = await page.locator('#process-map .sequence-actors [data-process-node]').evaluateAll(els => els.map(el => el.dataset.processNode));
  check(`scenario ${scenario.id}: exact message rows and SVG groups`, await groups.count() === messages.length
    && await rows.count() === messages.length && await page.locator('#process-summary').textContent().then(norm) === norm(scenario.summary));
  check(`scenario ${scenario.id}: actor lifelines match message endpoints`, JSON.stringify([...actualActors].sort()) === JSON.stringify([...expectedActors].sort())
    && new Set(await page.locator('#process-map .sequence-lifeline').evaluateAll(els => els.map(el => el.getAttribute('x1')))).size === expectedActors.length);
  const messageReport = await page.evaluate(() => [...document.querySelectorAll('#process-map [data-sequence-group]')].map(group => ({
    index: Number(group.dataset.sequenceGroup), step: Number(group.dataset.sequenceStep), label: group.querySelector('.sequence-message-label')?.textContent,
    title: group.querySelector('.sequence-message-label title')?.textContent, condition: group.querySelector('.sequence-condition')?.textContent,
    wireClass: group.querySelector('.sequence-message-wire')?.getAttribute('class'), y: Number((group.querySelector('.sequence-message-wire')?.getAttribute('d') || '').match(/\s([\d.]+)\s+H\s/)?.[1] || 0),
    rowTop: Number(document.querySelectorAll('#process-map button[data-sequence-message]')[Number(group.dataset.sequenceGroup)]?.style.top.replace('px', ''))
  })));
  let sequenceOk = messageReport.length === messages.length;
  for (let i = 0; i < messages.length; i++) {
    const expected = messages[i], actual = messageReport[i];
    const row = rows.nth(i);
    const aria = await row.getAttribute('aria-label');
    const condition = expected.condition ? `[${expected.condition}]` : undefined;
    const expectedY = 152 + i * 82;
    const y = await groups.nth(i).locator('.sequence-message-wire').getAttribute('d');
    const yMatch = y.match(/\s([\d.]+)\s+H\s/);
    const visualY = yMatch ? Number(yMatch[1]) : expectedY; // self-loop path has a distinct shape.
    sequenceOk &&= actual.index === i && actual.step === expected.step && actual.title === expected.label
      && (!expected.condition || norm(actual.condition) === norm(condition))
      && (!!expected.condition === !!actual.condition)
      && actual.rowTop === 112 + i * 82 && visualY === expectedY
      && aria.includes(expected.label) && aria.includes(data.nodes.find(n => n.id === expected.from).title)
      && aria.includes(data.nodes.find(n => n.id === expected.to).title)
      && (expected.kind === 'response' ? actual.wireClass.includes('response') : !actual.wireClass.includes('response'));
    if (expected.condition) testedConditions++;
    testedMessages++;
  }
  check(`scenario ${scenario.id}: endpoint labels, order, guards, and response styling`, sequenceOk,
    sequenceOk ? '' : JSON.stringify(messageReport));
  const stepButtons = page.locator('#process-route-list button[data-process-step]');
  check(`scenario ${scenario.id}: exact step count`, await stepButtons.count() === scenario.steps.length);
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    await stepButtons.nth(i).click(); testedSteps++;
    const activeGroups = await page.locator('#process-map [data-sequence-group].active').evaluateAll(els => els.map(el => Number(el.dataset.sequenceGroup)));
    const expectedActive = messages.flatMap((m, index) => m.step === i ? [index] : []);
    const pressedRows = await rows.evaluateAll(els => els.flatMap((el, index) => el.getAttribute('aria-pressed') === 'true' ? [index] : []));
    const activeMatch = JSON.stringify(activeGroups) === JSON.stringify(expectedActive) && JSON.stringify(pressedRows) === JSON.stringify(expectedActive);
    const detailMatch = norm(await page.locator('#process-step-label').textContent()) === `${i + 1} / ${scenario.steps.length}`
      && norm(await page.locator('#process-step-title').textContent()) === norm(step.title)
      && norm(await page.locator('#process-step-description').textContent()) === norm(step.description)
      && norm(await page.locator('#process-step-condition').textContent()) === norm(step.condition || 'STEP ON THE SELECTED PATH')
      && JSON.stringify((await page.locator('#process-step-events .process-event-chip').allTextContents()).map(norm)) === JSON.stringify(step.events || []);
    check(`step ${scenario.id} ${i + 1}: detail and every associated sequence message`, activeMatch && detailMatch,
      activeMatch && detailMatch ? '' : JSON.stringify({ activeGroups, expectedActive, pressedRows, step: i + 1 }));
    if (step.condition) check(`step ${scenario.id} ${i + 1}: conditional detail remains visible`, norm(await page.locator('#process-step-condition').textContent()) === norm(step.condition));
    if (i === scenario.steps.length - 1) {
      check(`scenario ${scenario.id}: full outcome appears only at final step`, await page.locator('#process-final-summary').isVisible()
        && norm(await page.locator('#process-final-summary').textContent()) === norm(scenario.outcome));
    }
  }
  await page.locator('#process-reset').click();
  await page.locator('#process-next').click();
  const nextWorks = norm(await page.locator('#process-step-label').textContent()) === `2 / ${scenario.steps.length}`;
  await page.locator('#process-prev').click();
  const prevWorks = norm(await page.locator('#process-step-label').textContent()) === `1 / ${scenario.steps.length}`;
  check(`scenario ${scenario.id}: reset, next, and previous controls`, nextWorks && prevWorks);
  scenarioResults.push({ id: scenario.id, steps: scenario.steps.length, messages: messages.length, actors: expectedActors });
}

// Message rows select the parent step; actors remain accessible by hover, focus, click, and keys.
const keyboardScenario = data.scenarios.find(s => s.id === 'tool-allow');
await page.locator('#process-scenario').selectOption(keyboardScenario.id);
const firstMessage = keyboardScenario.sequenceMessages[0];
await page.locator(`#process-map button[data-sequence-message="0"]`).click();
check('message-row activation selects its parent scenario step', norm(await page.locator('#process-step-label').textContent()) === `${firstMessage.step + 1} / ${keyboardScenario.steps.length}`);
const actorId = actorsFor(keyboardScenario)[0];
const actor = page.locator(`#process-map [data-process-node="${actorId}"]`);
await actor.hover();
check('pointer focus on an actor selects its full detail', await actor.getAttribute('aria-pressed') === 'true'
  && norm(await page.locator('#process-detail-title').textContent()) === norm(data.nodes.find(n => n.id === actorId).title));
await actor.focus();
check('keyboard focus on an actor selects its detail', await actor.getAttribute('aria-pressed') === 'true');
await actor.click();
check('click selects the actor detail panel', norm(await page.locator('#process-detail-title').textContent()) === norm(data.nodes.find(n => n.id === actorId).title));
await actor.focus(); await page.keyboard.press('ArrowRight');
const focusedActor = await page.evaluate(() => document.activeElement.dataset.processNode);
check('arrow key moves across actor lifelines', focusedActor === actorsFor(keyboardScenario)[1]);
await page.locator('#process-route-list button[data-process-step="0"]').focus(); await page.keyboard.press('ArrowRight');
check('arrow key advances selected scenario step', norm(await page.locator('#process-step-label').textContent()) === `2 / ${keyboardScenario.steps.length}`);
check('reduced motion removes active wire animation', await page.locator('#process-map .sequence-message-wire').first().evaluate(el => getComputedStyle(el).animationName === 'none' || getComputedStyle(el).animationDuration === '0s'));
check('desktop page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
const desktopScroller = page.locator('.process-map-scroll');
check('desktop diagram scrolls vertically inside its own region', await desktopScroller.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible'));
await page.locator('#process-reset').click(); await page.locator('#process-play').click();
await page.waitForFunction(() => document.querySelector('#process-step-label')?.textContent?.startsWith('2 /'), null, { timeout: 4000 });
check('play advances the sequence timeline', norm(await page.locator('#process-step-label').textContent()) === `2 / ${keyboardScenario.steps.length}`);
await page.locator('#process-play').click();
const pausedAt = norm(await page.locator('#process-step-label').textContent()); await page.waitForTimeout(2450);
check('pause stops the sequence timeline', norm(await page.locator('#process-step-label').textContent()) === pausedAt);

await page.locator('#process-scenario').selectOption('tool-allow'); await page.locator('#process-reset').click();
await page.evaluate(() => { const target = document.querySelector('#process-workbench').getBoundingClientRect().top + scrollY - 90; scrollTo({ top: target, behavior: 'instant' }); });
await page.waitForTimeout(150); await page.screenshot({ path: path.join(output, 'process-desktop.png'), fullPage: false });

// Confirm a transient data-load failure can be retried.
const fault = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
fault.on('pageerror', e => errors.push(e.message)); let firstRequest = true;
await fault.route('**/assets/process-flow.json', route => firstRequest ? route.fulfill({ status: 503, body: 'temporarily unavailable' }) : route.continue());
await fault.goto(url, { waitUntil: 'networkidle' }); await fault.waitForSelector('#process-load-error:not([hidden])');
check('HTTP 503 displays retry and disables process controls', await fault.locator('#process-retry').isVisible() && await fault.locator('#process-scenario').isDisabled());
firstRequest = false; await fault.locator('#process-retry').click(); await fault.waitForFunction(() => document.querySelector('#process-scenario')?.options.length === 8);
check('retry recovers all sequence routes', await fault.locator('#process-map button[data-sequence-message]').count() === data.scenarios.find(s => s.id === 'tool-allow').sequenceMessages.length);
await fault.close();

// Mobile: page width stays fixed while diagram scrolling is contained within the map panel.
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
const mobile = await mobileContext.newPage(); mobile.on('pageerror', e => errors.push(e.message));
await mobile.goto(url, { waitUntil: 'networkidle' }); await mobile.waitForFunction(() => document.querySelector('#process-scenario')?.options.length === 8);
await mobile.locator('#proces').scrollIntoViewIfNeeded();
const mobileScroller = mobile.locator('.process-map-scroll');
check('mobile page has no horizontal overflow', await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
check('mobile sequence has contained horizontal and vertical scrolling', await mobileScroller.evaluate(el => el.scrollWidth > el.clientWidth && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).overflowY !== 'visible'));
await mobileScroller.evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = Math.min(200, el.scrollHeight); });
check('mobile diagram scrolls internally without page overflow', await mobileScroller.evaluate(el => el.scrollLeft > 0 && el.scrollTop > 0) && await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await mobileScroller.evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
const mobileRow = mobile.locator('#process-map button[data-sequence-message="0"]'); await mobileRow.tap();
check('touching a sequence row selects its step', norm(await mobile.locator('#process-step-label').textContent()) === `1 / ${data.scenarios.find(s => s.id === 'tool-allow').steps.length}`);
const mobileActor = mobile.locator('#process-map [data-process-node]').first(); await mobileActor.tap();
check('touching an actor selects its detail', await mobileActor.getAttribute('aria-pressed') === 'true');
await mobile.evaluate(() => { const target = document.querySelector('#process-workbench').getBoundingClientRect().top + scrollY - 78; scrollTo({ top: target, behavior: 'instant' }); });
await page.waitForTimeout(150); await mobile.screenshot({ path: path.join(output, 'process-mobile.png'), fullPage: false });
await mobileContext.close();

const unexpected = failedResponses.filter(item => !(item.status === 503 && item.url.endsWith('/assets/process-flow.json')));
check('no unexpected HTTP failures', unexpected.length === 0, JSON.stringify(unexpected));
check('no uncaught browser exceptions', errors.length === 0, errors.join('; '));
const report = {
  generated_at: new Date().toISOString(), scope: 'Local Sequence Diagram UI and static process-flow data only; no live model, API, or publishing.',
  checks, findings, errors, failedResponses, componentCount: data.nodes.length, scenarioCount: data.scenarios.length,
  stepCount: testedSteps, messageCount: testedMessages, conditionalMessageCount: testedConditions,
  scenarioResults, processFlowSha256: hash, expectedProcessFlowSha256: expectedHash, viewports: ['1440x1000', '390x844'],
  screenshots: ['process-desktop.png', 'process-mobile.png']
};
fs.writeFileSync(path.join(output, 'process-qa.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.filter(c => c.result === 'PASS').length, total: checks.length, findings, hash, report: path.join(output, 'process-qa.json') }, null, 2));
await browser.close(); process.exitCode = checks.some(c => c.result === 'FAIL') ? 1 : 0;
