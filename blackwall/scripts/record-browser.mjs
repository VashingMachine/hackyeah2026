#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const defaultRuntime = '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, defaultRuntime, 'playwright', 'playwright-core'].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try the next configured or installed runtime */ }
  }
  throw new Error('Playwright not found. Set PLAYWRIGHT_MODULE to the runtime playwright module path.');
}

const [baseUrl, outputArg] = process.argv.slice(2);
if (!baseUrl || !outputArg) throw new Error('Usage: node scripts/record-browser.mjs <dashboard-base-url> <output-directory>');
const output = resolve(outputArg);
const videoRoot = join(output, 'video');
mkdirSync(videoRoot, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true });
let context;
let page;
let currentClip;
let transcript = { title: 'DEMO · TRANSKRYPT', entries: [] };
const clips = [];
const titleLabels = {
  '01-kyc-approved-write': 'KYC · zapis za zgodą',
  '02-kyc-rejected-write': 'KYC · odmowa zapisu',
  '03-kyc-other-client': 'KYC · zakres klienta',
  '04-ma-injection': 'M&A · instrukcja w dokumencie',
  '05-ma-replay': 'M&A · kontekst z04 / replay POST',
  '06-hr-termination': 'HR · zamknięcie sesji',
  '07-shell-routing': 'Shell · odczyt i test',
  '08-threat-feed': 'Feed zagrożeń · pickle',
  '09-secrets': 'Sekrety · redakcja',
  '10-hr-pl-first-violation': 'HR · naruszenie po polsku',
  '11-hr-pl-general-question': 'HR · pytanie ogólne',
  '12-ma-authorized-post': 'M&A · jawnie zlecony POST',
  '13-grep-protected-source': 'Grep · pliki dozwolone',
  '14-kyc-unseeded-topic-detection': 'KYC · wykrycie embeddingiem',
  'dashboard-tour': 'Przegląd dashboardu',
};

function displayText(value) {
  return String(value).replace(/\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/T\/bw-ws-[^/\s]+/g, '/workspace');
}

async function attachPanel() {
  await page.evaluate(({ data, labels }) => {
    let panel = document.getElementById('bw-demo-transcript');
    if (!panel) {
      panel = document.createElement('aside');
      panel.id = 'bw-demo-transcript';
      Object.assign(panel.style, { position: 'fixed', zIndex: '2147483000', right: '20px', bottom: '20px', width: '420px', maxHeight: '32vh', overflow: 'hidden', padding: '14px 16px', background: 'rgba(10, 14, 18, .96)', border: '1px solid #34434f', borderTop: '3px solid #ff493e', borderRadius: '10px', color: '#eef4f7', font: '14px/1.45 system-ui, sans-serif', boxShadow: '0 8px 36px #0009', pointerEvents: 'none' });
      document.body.append(panel);
    }
    panel.replaceChildren();
    const heading = document.createElement('div');
    const id = String(data.title).replace(/^DEMO · /, '');
    heading.textContent = labels[id] ?? data.title;
    Object.assign(heading.style, { fontWeight: '700', letterSpacing: '.06em', color: '#ff655b', marginBottom: '8px', fontSize: '12px' });
    panel.append(heading);
    for (const entry of data.entries.slice(-3)) {
      const row = document.createElement('div');
      const visibleText = String(entry.text).replace(/\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/T\/bw-ws-[^/\s]+/g, '/workspace');
      row.textContent = `${entry.role}: ${visibleText}`;
      Object.assign(row.style, { borderTop: '1px solid #27343d', paddingTop: '6px', marginTop: '6px', display: '-webkit-box', WebkitLineClamp: '3', WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' });
      panel.append(row);
    }
  }, { data: transcript, labels: titleLabels });
}

async function saveCurrentClip() {
  if (!context) return;
  const video = page.video();
  await context.close();
  if (video) {
    const source = await video.path();
    const webm = join(videoRoot, `${currentClip}.webm`);
    const target = join(videoRoot, `${currentClip}.mp4`);
    if (existsSync(target)) throw new Error(`Refusing to overwrite existing video: ${target}`);
    renameSync(source, webm);
    const ffmpeg = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
    const converted = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', webm, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target], { stdio: 'inherit' });
    if (converted.error || converted.status !== 0) throw converted.error ?? new Error(`ffmpeg exited with status ${converted.status}`);
    unlinkSync(webm);
    clips.push(target);
  }
  context = undefined;
  page = undefined;
}

async function startClip(name) {
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || `clip-${clips.length + 1}`;
  await saveCurrentClip();
  currentClip = safeName;
  context = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: videoRoot, size: { width: 1600, height: 900 } } });
  page = await context.newPage();
  await page.goto(`${baseUrl}/dashboard#overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await attachPanel();
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { return send(res, 400, { error: 'invalid JSON' }); }
  try {
    if (req.url === '/clip') {
      await startClip(body.name);
      return send(res, 200, { ok: true, clip: currentClip });
    }
    if (!page && req.url !== '/close') await startClip('dashboard');
    if (req.url === '/transcript') {
      transcript = { title: String(body.title ?? 'DEMO · TRANSKRYPT'), entries: Array.isArray(body.entries) ? body.entries.map((x) => ({ role: String(x.role ?? ''), text: String(x.text ?? '') })) : [] };
      await attachPanel();
      return send(res, 200, { ok: true });
    }
    if (req.url === '/capture') {
      const hash = String(body.hash ?? 'overview').replace(/^#/, '');
      const [tab, sessionId] = hash.split('/');
      await page.locator(`.tabs button[data-tab="${tab}"]`).click();
      if (sessionId) {
        await page.waitForFunction((id) => [...document.querySelector('#f-session').options].some((option) => option.value === id), sessionId, { timeout: 5000 });
        await page.locator('#f-session').selectOption(sessionId);
      }
      await page.waitForTimeout(Number(body.waitMs ?? 2200));
      await attachPanel();
      if (body.eventDetail) {
        const preferred = body.detailText
          ? page.locator('#timeline li').filter({ hasText: String(body.detailText) }).first()
          : page.locator('#timeline li').first();
        if (await preferred.count()) { await preferred.click(); await page.waitForTimeout(300); }
      }
      const name = String(body.name ?? `capture-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
      const file = join(output, `${name}.png`);
      const overlay = page.locator('#bw-demo-transcript');
      await overlay.evaluate((el) => { el.dataset.previousDisplay = el.style.display; el.style.display = 'none'; });
      await page.screenshot({ path: file, fullPage: true });
      await page.screenshot({ path: join(output, `${name}-viewport.png`) });
      await overlay.evaluate((el) => { el.style.display = el.dataset.previousDisplay ?? ''; delete el.dataset.previousDisplay; });
      return send(res, 200, { ok: true, file: `${name}.png` });
    }
    if (req.url === '/close') {
      await saveCurrentClip();
      await browser.close();
      server.close();
      return send(res, 200, { ok: true, clips: clips.map((x) => x.replace(`${output}/`, '')) });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
console.log(`BROWSER_RECORDER_READY:${server.address().port}`);
if (process.argv[4] === '--smoke') {
  transcript = { title: 'DEMO · SMOKE', entries: [{ role: 'Smoke', text: 'Dynamic transcript overlay is connected to the recording browser.' }] };
  await startClip('browser-smoke');
  for (const [name, hash] of [['overview', 'overview'], ['policies', 'policies'], ['events', 'events']]) {
    await page.locator(`.tabs button[data-tab="${hash}"]`).click();
    await page.waitForTimeout(2200);
    await attachPanel();
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  }
  await saveCurrentClip();
  await browser.close();
  server.close();
  console.log('BROWSER_RECORDER_SMOKE_DONE');
}
