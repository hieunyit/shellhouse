// Chụp ảnh các màn hình prototype: node design/prototype/tools/shoot.mjs [filter]
import { _electron as electron } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PROTO_DIR || path.resolve(here, '..');
const out = process.env.OUT_DIR || path.join(root, 'screens');
fs.mkdirSync(out, { recursive: true });
const indexUrl = pathToFileURL(path.join(root, 'index.html')).href;
const filter = process.argv[2] || '';

const SHOTS = [
  // [name, hash, steps?]
  ['01-home', '#/home'],
  ['01b-home-mac', '#/home?os=mac'],
  ['02-hosts-terminal', '#/hosts?tab=term&sftp=1&split=0'],
  ['02b-hosts-split', '#/hosts?tab=term&sftp=0&split=1'],
  ['02c-hosts-rdp', '#/hosts?tab=rdp'],
  ['02d-hosts-forwards', '#/hosts?tab=term&panel=forwards'],
  ['02e-multiexec', '#/hosts?multi=1'],
  ['02f-editor', '#/hosts?tab=logs&panel=none'],
  ['02g-group-dialog', '#/hosts', async (p) => { await p.evaluate(() => window.SH.groupDialog('prod')); await p.waitForTimeout(250); }],
  ['03-k8s-pods', '#/k8s/pods?itab=overview'],
  ['03b-k8s-pods-events', '#/k8s/pods?itab=events'],
  ['03c-k8s-pods-logs', '#/k8s/pods?itab=logs'],
  ['03d-k8s-pods-bulk', '#/k8s/pods?select=3&itab=overview'],
  ['03e-k8s-deployment', '#/k8s/deployments?itab=overview'],
  ['03f-k8s-deployment-history', '#/k8s/deployments?itab=history'],
  ['03g-k8s-yaml-diff', '#/k8s/deployments', async (p) => { await p.evaluate(() => window.SH.yamlDiffDialog()); await p.waitForTimeout(250); }],
  ['03h-helm', '#/k8s/helm?helm=shop'],
  ['03i-helm-rollback', '#/k8s/helm?helm=ingress-nginx', async (p) => { await p.evaluate(() => window.SH.rollbackDialog(6)); await p.waitForTimeout(250); }],
  ['04-k8s-topology', '#/k8s/topology'],
  ['04b-k8s-topology-hover', '#/k8s/topology', async (p) => { await p.hover('[data-node="deploy/web"]'); await p.waitForTimeout(250); }],
  ['05-docker-containers', '#/docker?itab=overview'],
  ['05b-docker-compose', '#/docker/compose?itab=stats'],
  ['05c-docker-env', '#/docker?itab=env'],
  ['05d-docker-overview', '#/docker/overview'],
  ['05e-docker-images', '#/docker/images'],
  ['05f-docker-pull', '#/docker/images', async (p) => { await p.evaluate(() => window.SH.pullDialog()); await p.waitForTimeout(250); }],
  ['05g-docker-build', '#/docker/images', async (p) => { await p.evaluate(() => window.SH.buildDialog()); await p.waitForTimeout(250); }],
  ['05h-docker-volumes', '#/docker/volumes'],
  ['05i-docker-networks', '#/docker/networks'],
  ['06-s3-buckets', '#/s3'],
  ['06b-s3-objects', '#/s3/objects?itab=overview'],
  ['06c-s3-sync', '#/s3/objects', async (p) => { await p.evaluate(() => window.SH.syncDialog()); await p.waitForTimeout(250); }],
  ['07-settings-accounts', '#/settings/accounts'],
  ['07b-settings-appearance', '#/settings/appearance'],
  ['07c-settings-terminal', '#/settings/terminal'],
  ['07d-settings-shortcuts', '#/settings/shortcuts'],
  ['07e-settings-security', '#/settings/security'],
  ['07f-settings-keys', '#/settings/keys'],
  ['07g-settings-known-hosts', '#/settings/known-hosts'],
  ['07h-settings-modules', '#/settings/modules'],
  ['07i-settings-general', '#/settings/general'],
  ['07j-settings-files', '#/settings/files'],
  ['07k-settings-updates', '#/settings/updates'],
  ['07l-settings-diagnostics', '#/settings/diagnostics'],
  ['08-palette', '#/k8s/pods', async (p) => { await p.keyboard.press('Control+k'); await p.keyboard.type('pod'); await p.waitForTimeout(200); }],
  ['08b-palette-snippets', '#/hosts', async (p) => { await p.keyboard.press('Control+k'); await p.keyboard.type(';'); await p.waitForTimeout(200); }],
  ['08c-snippet-vars', '#/hosts', async (p) => { await p.evaluate(() => window.SH.snippetRun('tail-log')); await p.waitForTimeout(250); }],
  ['09-confirm-prod', '#/k8s/topology', async (p) => { await p.evaluate(() => window.SH.confirmDeleteWeb()); await p.keyboard.type('we'); await p.waitForTimeout(250); }],
  ['09b-confirm-staging', '#/docker', async (p) => { await p.locator('[data-action="delete-container"]').click(); await p.waitForTimeout(250); }],
  ['10-context-menu', '#/k8s/pods', async (p) => { const r = await p.locator('tr[data-idx="3"]').boundingBox(); await p.mouse.click(r.x + 300, r.y + 14, { button: 'right' }); await p.waitForTimeout(200); }],
  ['11-shortcuts', '#/home', async (p) => { await p.locator('#content').click({ position: { x: 5, y: 5 } }); await p.keyboard.press('Shift+Slash'); await p.waitForTimeout(250); }],
  ['13-keyboard-focus', '#/k8s/pods', async (p) => { await p.locator('body').click({ position: { x: 700, y: 860 } }); for (const k of ['j', 'j', 'j', 'j', 'x', 'j', 'x', 'j']) await p.keyboard.press(k); await p.waitForTimeout(150); }],
  ['14-i18n-vi', '#/home?lang=vi'],
  ['15-files', '#/files'],
  ['16-transfers', '#/transfers'],
  ['17-snippets', '#/snippets'],
  ['12-toast-tooltip', '#/k8s/pods', async (p) => { await p.evaluate(() => { window.__noToastTimeout = true; window.SH.toast('success', 'Restarting web', 'Rolling restart started · 0/3 updated', { label: 'Undo' }); }); await p.hover('[data-action="toggle-inspector"]'); await p.waitForTimeout(700); }]
];
const MATRIX = [
  { theme: 'dark', size: '1440x900' },
  { theme: 'light', size: '1440x900' },
  { theme: 'dark', size: '1920x1080', only: ['01-home', '02-hosts-terminal', '02e-multiexec', '03-k8s-pods', '04-k8s-topology', '15-files', '16-transfers', '07c-settings-terminal'] },
  { theme: 'light', size: '1920x1080', only: ['01-home', '03-k8s-pods', '15-files', '06b-s3-objects'] },
  { theme: 'dark', size: '1440x900', density: 'compact', only: ['03-k8s-pods', '05b-docker-compose'] },
  { theme: 'dark', size: '1280x800', only: ['03-k8s-pods', '04-k8s-topology', '01-home', '15-files'] }
];
const errors = [];
for (const m of MATRIX) {
  const env = { ...process.env, SIZE: m.size, URL: indexUrl + '#/home' };
  delete env.ELECTRON_RUN_AS_NODE;
  const appE = await electron.launch({ args: [path.join(here, 'electron-main.cjs'), '--no-sandbox'], env });
  const page = await appE.firstWindow();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[${m.theme} ${m.size}] ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`[${m.theme} ${m.size}] pageerror ${err.message}`));
  await page.waitForLoadState('domcontentloaded');
  for (const [name, hash, steps] of SHOTS) {
    if (m.only && !m.only.includes(name)) continue;
    if (filter && !name.includes(filter)) continue;
    const q = `theme=${m.theme}&density=${m.density || 'comfortable'}&lang=en`;
    const full = hash + (hash.includes('?') ? '&' : '?') + q;
    // tải lại trang để reset state
    await page.goto('about:blank');
    await page.goto(indexUrl + full);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    if (steps) await steps(page);
    const file = `${m.theme}${m.density === 'compact' ? '-compact' : ''}-${m.size}-${name}.png`;
    await page.screenshot({ path: path.join(out, file) });
    console.log('shot', file);
  }
  await appE.close();
}
// Kit gallery (full page)
if (!filter || 'kit'.includes(filter)) {
  const env = { ...process.env, SIZE: '1600x1000', URL: pathToFileURL(path.join(root, 'kit.html')).href };
  delete env.ELECTRON_RUN_AS_NODE;
  const appE = await electron.launch({ args: [path.join(here, 'electron-main.cjs'), '--no-sandbox'], env });
  const page = await appE.firstWindow();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[kit] ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`[kit] pageerror ${err.message}`));
  await page.waitForLoadState('load'); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'kit-1600-fullpage.png'), fullPage: true });
  console.log('shot kit-1600-fullpage.png');
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0, i = 1; y < H; y += 1300, i++) {
    await page.screenshot({ path: path.join(out, `kit-1600-part${i}.png`), fullPage: true, clip: { x: 0, y, width: 1600, height: Math.min(1300, H - y) } });
  }
  await appE.close();
}
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
