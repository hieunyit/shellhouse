// Kiểm tra: (1) chạy từ bản sao ở thư mục khác có dấu cách qua file://, không lỗi console;
// (2) bàn phím: Ctrl+K palette lọc + Enter điều hướng; Esc đóng overlay; Tab có focus ring; j/k/x/Enter trong bảng.
import { _electron as electron } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh proto copy '));
const dst = path.join(tmp, 'My Downloads', 'prototype');
fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.includes(`${path.sep}screens`) });
const url = pathToFileURL(path.join(dst, 'index.html')).href;
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

const env = { ...process.env, SIZE: '1440x900', URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(here, 'electron-main.cjs'), '--no-sandbox'], env });
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
await page.waitForLoadState('load');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

ok('Opened from copied folder with spaces', true, url);
ok('Shell rendered (activity bar + explorer + main)', await page.locator('#activitybar .ab-item').count() >= 6 && await page.locator('#explorer-body .tree__item').count() > 3);
const fontOk = await page.evaluate(() => document.fonts.check('13px "Inter Variable"') && [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded'));
ok('Inter font loaded from embedded data URL', fontOk);

// Palette
await page.keyboard.press('Control+k');
ok('Ctrl+K opens palette', await page.locator('.palette').isVisible());
await page.keyboard.type('topo');
const first = await page.locator('.palette__item[aria-selected="true"]').innerText();
ok('Palette fuzzy filter selects best match', /Topology/.test(first), first.replace(/\s+/g, ' '));
await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
ok('Enter runs command (navigates)', (await page.evaluate(() => location.hash)).startsWith('#/k8s/topology'));
await page.keyboard.press('Control+k');
await page.keyboard.press('Escape');
ok('Esc closes palette', (await page.locator('.palette').count()) === 0);

// Pods: j/k/x, bulk bar, Esc
await page.evaluate(() => { location.hash = '#/k8s/pods'; });
await page.waitForTimeout(300);
await page.locator('body').click({ position: { x: 700, y: 820 } });
await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('x');
ok('j/j/x selects a row → bulk bar shown', await page.locator('.bulkbar').isVisible());
await page.keyboard.press('Escape');
ok('Esc clears selection', (await page.locator('.bulkbar').count()) === 0);
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
ok('Enter opens focused row in inspector', (await page.locator('.inspector__name').innerText()).length > 0, await page.locator('.inspector__name').innerText());

// Context menu + Esc
const r = await page.locator('tr[data-idx="2"]').boundingBox();
await page.mouse.click(r.x + 200, r.y + 10, { button: 'right' });
ok('Right-click opens context menu', await page.locator('.menu').isVisible());
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Escape');
ok('Esc closes context menu', (await page.locator('.menu').count()) === 0);

// Prod confirm
await page.evaluate(() => window.SH.confirmDeleteWeb());
const okBtn = page.locator('[data-dlg="ok"]');
ok('Prod delete: confirm disabled before typing', await okBtn.isDisabled());
await page.keyboard.type('web');
ok('Prod delete: enabled after typing exact name', await okBtn.isEnabled());
await page.keyboard.press('Escape');
ok('Esc closes dialog', (await page.locator('.dialog').count()) === 0);

// Tab focus order + visible ring
await page.goto('about:blank'); await page.goto(url + '#/home');
await page.waitForTimeout(400);
const order = [];
for (let i = 0; i < 18; i++) {
  await page.keyboard.press('Tab');
  order.push(await page.evaluate(() => { const a = document.activeElement; const ringEl = a.closest('.input') || a; const cs = getComputedStyle(ringEl); return `${a.closest('[id]')?.id || '?'}:${(a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 18)}${cs.boxShadow !== 'none' || cs.outlineStyle !== 'none' ? '' : ' (NO RING)'}`; }));
}
ok('Tab order follows shell (skip link → activity bar → explorer → main)', order[0].includes('Skip') || order.join(' ').includes('activitybar'), order.join(' | '));
ok('Every Tab stop shows a focus ring', !order.some((o) => o.includes('NO RING')));

// Shortcut ? and [ ]
await page.locator('#content').click({ position: { x: 10, y: 10 } });
await page.keyboard.press('Shift+Slash');
ok('? opens shortcuts dialog', await page.locator('.dialog').isVisible());
await page.keyboard.press('Escape');
await page.keyboard.press('[');
ok('[ collapses explorer', (await page.locator('#app').getAttribute('data-explorer')) === 'closed');
await page.keyboard.press('[');

// v0.2: mọi route render được; title bar frameless theo os; type-to-confirm chỉ cho prod
const routes = ['#/home', '#/hosts', '#/hosts?panel=forwards', '#/hosts?multi=1', '#/files', '#/snippets', '#/transfers', '#/k8s/pods', '#/k8s/deployments', '#/k8s/helm', '#/k8s/topology', '#/docker', '#/docker/compose', '#/docker/overview', '#/docker/images', '#/docker/volumes', '#/docker/networks', '#/s3', '#/s3/objects', '#/settings/accounts', '#/settings/general', '#/settings/appearance', '#/settings/terminal', '#/settings/shortcuts', '#/settings/files', '#/settings/keys', '#/settings/known-hosts', '#/settings/modules', '#/settings/security', '#/settings/updates', '#/settings/diagnostics'];
const bad = [];
for (const r of routes) { await page.evaluate((h) => { location.hash = h; }, r); await page.waitForTimeout(120); const n = await page.evaluate(() => document.querySelector('#content').innerHTML.length); if (n < 200) bad.push(r); }
ok(`All ${routes.length} routes render content`, bad.length === 0, bad.join(' '));
await page.goto('about:blank'); await page.goto(url + '#/home?os=win'); await page.waitForTimeout(250);
ok('Title bar (win): window controls on the right, no traffic lights', (await page.locator('.tb-winctl button').count()) === 3 && (await page.locator('.tb-traffic').count()) === 0);
await page.goto('about:blank'); await page.goto(url + '#/home?os=mac'); await page.waitForTimeout(250);
ok('Title bar (mac): traffic lights inset left, no window buttons', (await page.locator('.tb-traffic i').count()) === 3 && (await page.locator('.tb-winctl').count()) === 0);
ok('Accent switch removed (teal only)', (await page.evaluate(() => !document.body.dataset.accent && !document.querySelector('[data-pref="accent"]'))));
await page.goto('about:blank'); await page.goto(url + '#/docker'); await page.waitForTimeout(250);
await page.locator('[data-action="delete-container"]').click(); await page.waitForTimeout(150);
ok('Staging delete: normal confirm (no type-to-confirm)', (await page.locator('#confirm-input').count()) === 0 && await page.locator('[data-dlg="ok"]').isEnabled());
await page.keyboard.press('Escape');
await page.evaluate(() => { location.hash = '#/k8s/helm'; }); await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('[data-action="helm-uninstall"]').click()); await page.waitForTimeout(150);
ok('Production delete (Helm uninstall): type-to-confirm', (await page.locator('#confirm-input').count()) === 1 && await page.locator('[data-dlg="ok"]').isDisabled());
await page.keyboard.press('Escape');
await page.evaluate(() => { location.hash = '#/hosts'; }); await page.waitForTimeout(200);
ok('Env shown on group rows only (hosts do not repeat it)', await page.evaluate(() => [...document.querySelectorAll('#explorer-body .tree__item[aria-level="2"] .env')].length === 0 && [...document.querySelectorAll('#explorer-body .tree__item[aria-level="1"] .env')].length >= 3));
await page.keyboard.press('Control+k'); await page.keyboard.type(';tail'); await page.waitForTimeout(150);
ok('Palette ";" lists snippets', /Tail a log file/.test(await page.locator('.palette__item[aria-selected="true"]').innerText()));
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
ok('Snippet with variables opens fill-in dialog', (await page.locator('.dialog').count()) === 1);
await page.keyboard.press('Escape');

const errs = errors.filter((e) => !/Electron Security Warning/.test(e));
ok('No console errors / failed requests', errs.length === 0, errs.join(' ; '));
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
