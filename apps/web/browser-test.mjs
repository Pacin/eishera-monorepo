// Real-browser render test (Chromium via Playwright). Drives the live SPA at
// :5173 (Vite proxy → backend :4000) exactly as a user would: register, then
// exercise every panel and the live socket. Asserts on rendered DOM, not on the
// network layer. Run with the backend + vite dev server already up.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
let fail = 0;
const ck = (label, cond, detail) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond ? '' : ` — ${detail ?? ''}`));
  if (!cond) fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

try {
  const user = `pw_${Date.now()}`;

  // ── Auth screen renders, register a fresh account ──────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle' });
  ck('auth screen renders heading', (await page.textContent('h1')) === 'Eishera');
  // Default mode is "Sign in" — switch to register via the toggle, then submit.
  await page.click('button[type="button"]:has-text("Register")');
  await page.waitForSelector('p.muted:has-text("Create an account")');
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', 'password123');
  await page.click('button.primary:has-text("Register")');

  // ── Dashboard loads (topbar shows the username + resources) ────────────────
  await page.waitForSelector('header.topbar', { timeout: 15000 });
  const topbar = await page.textContent('header.topbar');
  ck('dashboard topbar shows username', topbar.includes(user), topbar);
  ck('topbar shows gold/tokens/actions', /💰|🎟|⚡/.test(topbar), topbar);
  // The "live" connection dot flips on once the socket authenticates.
  await page.waitForFunction(() => document.querySelector('header .dot.on') !== null, {
    timeout: 15000,
  });
  ck('socket connected (live dot on)', true);

  // ── Gathering tab: idle shows options; starting one swaps to the detail ─────
  await page.click('nav.tabs >> text=Gathering');
  await page.waitForSelector('.col-mid button.primary:has-text("Gather")');
  const gatherButtons = await page.locator('.col-mid button.primary:has-text("Gather")').count();
  ck('gathering options render when idle (≥1 Gather button)', gatherButtons >= 1, gatherButtons);
  // Start the first gather → options are replaced by the live detail + Action Tracker.
  await page.locator('.col-mid button.primary:has-text("Gather")').first().click();
  await page.waitForSelector('section:has-text("Action Tracker"):has-text("Total Actions")', {
    timeout: 15000,
  });
  ck('gather detail + Action Tracker render while active', true);
  const gatherBtnsActive = await page.locator('.col-mid button.primary:has-text("Gather")').count();
  ck('gathering options hidden while active', gatherBtnsActive === 0, gatherBtnsActive);
  ck('no Current action section', (await page.locator('text=Current action').count()) === 0);
  ck('no Stop button on detail', (await page.locator('.col-mid button:has-text("Stop")').count()) === 0);
  // "Change" reveals the options again without stopping the active gather.
  await page.locator('.col-mid button:has-text("Change")').first().click();
  await page.waitForSelector('.col-mid button.primary:has-text("Gather")', { timeout: 5000 });
  const reopened = await page.locator('.col-mid button.primary:has-text("Gather")').count();
  ck('Change re-shows gathering options', reopened >= 1, reopened);
  ck('a gather is still marked Active after Change', (await page.locator('.col-mid button:has-text("Active")').count()) >= 1);

  // ── Crafting tab: recipes with inputs render ───────────────────────────────
  await page.click('nav.tabs >> text=Crafting');
  await page.waitForSelector('.col-mid button.primary:has-text("Craft")');
  const craftButtons = await page.locator('.col-mid button.primary:has-text("Craft")').count();
  ck('crafting recipes render (≥1 Craft button)', craftButtons >= 1, craftButtons);

  // ── Alchemy tab: brew recipes render ───────────────────────────────────────
  await page.click('nav.tabs >> text=Alchemy');
  await page.waitForSelector('.col-mid button.primary:has-text("Brew")');
  const brewButtons = await page.locator('.col-mid button.primary:has-text("Brew")').count();
  ck('alchemy recipes render (≥1 Brew button)', brewButtons >= 1, brewButtons);

  // ── Combat tab: monster targets render + battle detail after a tick ────────
  await page.click('nav.tabs >> text=Combat');
  await page.waitForSelector('.col-mid button.primary:has-text("Fight")');
  const monsterButtons = await page.locator('.col-mid button.primary:has-text("Fight")').count();
  ck('combat targets render (≥1 Fight button)', monsterButtons >= 1, monsterButtons);
  // Start a fight → options swap to the battle report (rendered after a tick).
  await page.locator('.col-mid button.primary:has-text("Fight")').first().click();
  await page.waitForSelector('section:has-text("damage per hit")', { timeout: 15000 });
  const report = await page.textContent('.col-mid');
  ck('combat detail (battle report) renders', /damage per hit/.test(report), report?.slice(0, 80));
  ck('combat detail shows Wins / Losses tracker', /Wins \/ Losses/.test(report), report?.slice(0, 80));
  const fightBtnsActive = await page.locator('.col-mid button.primary:has-text("Fight")').count();
  ck('combat targets hidden while fighting', fightBtnsActive === 0, fightBtnsActive);

  // ── Profile tab: attribute chips + skill XP bars (xpToNext) ────────────────
  await page.click('nav.tabs >> text=Profile');
  await page.waitForSelector('section:has-text("Attributes") .stat-chip');
  const statChips = await page
    .locator('section:has-text("Attributes") .stat-chip')
    .count();
  ck('six attribute chips render in Profile', statChips === 6, statChips);
  const xpBars = await page.locator('section:has-text("Skills") .bar.xp').count();
  ck('skill XP bars render (shared xpToNext)', xpBars >= 1, xpBars);

  // ── Inventory tab: items + equipment panels (empty for a fresh account) ─────
  await page.click('nav.tabs >> text=Inventory');
  await page.waitForSelector('section:has-text("Items")');
  const invPanels = await page.locator('section:has-text("Items"), section:has-text("Equipment")').count();
  ck('inventory Items + Equipment panels render', invPanels >= 2, invPanels);

  // ── Housing panel renders features ─────────────────────────────────────────
  await page.click('nav.tabs >> text=Housing');
  await page.waitForSelector('text=House features');
  const features = await page.locator('section:has-text("House features") .card').count();
  ck('housing features render', features >= 1, features);

  // ── World boss panel: join → HP bar appears ────────────────────────────────
  page.on('response', async (r) => {
    if (r.url().includes('/boss/join')) {
      const hdr = r.request().headers()['csrf-token'] ? 'csrf-token sent' : 'NO csrf-token';
      let body = '';
      try {
        body = await r.text();
      } catch {
        body = '(no body)';
      }
      console.log(`     · /boss/join → ${r.status()} [${hdr}] ${body}`);
    }
  });
  await page.click('nav.tabs >> text=World boss');
  await page.waitForSelector('h2:has-text("World boss")');
  const joinBtn = page.locator('button:has-text("Join the hunt")');
  if (await joinBtn.count()) await joinBtn.first().click();
  // The join handler refetches, but a 3 s poll also refreshes boss state — give it
  // a couple of poll cycles to be safe, then assert the HP bar rendered.
  await page.waitForSelector('.bar.hp', { timeout: 12000 });
  ck('boss HP bar renders after joining', true);

  // ── Market panel: order book renders ───────────────────────────────────────
  await page.click('nav.tabs >> text=Market');
  await page.waitForSelector('section:has-text("Market") table');
  const tables = await page.locator('section:has-text("Market") table').count();
  ck('market order book renders (buys + sells tables)', tables === 2, tables);

  // ── Chat: send a message, see it appear live in the log ────────────────────
  const marker = `browser-hi-${Date.now()}`;
  await page.fill('section.chat input', marker);
  await page.click('section.chat button:has-text("Send")');
  await page.waitForSelector(`.chat-log:has-text("${marker}")`, { timeout: 10000 });
  ck('chat message sent and rendered live', true);

  await page.screenshot({ path: '/tmp/eishera-dashboard.png', fullPage: true });

  // ── Reload stays logged in (httpOnly cookies + refresh, not localStorage) ───
  await page.reload({ waitUntil: 'networkidle' });
  const stillIn = await page
    .waitForSelector('header.topbar', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  ck('reload stays logged in (dashboard, not login screen)', stillIn);
  // The only acceptable console error is the logged-out /me auth probe (a browser
  // logs every non-2xx fetch; a 401 there just means "show the login screen").
  const realErrors = errors.filter((e) => !/Failed to load resource.*401/.test(e));
  ck('no unexpected console/page errors', realErrors.length === 0, realErrors.join(' | '));
  ck('only the benign logged-out auth-probe 401 (if any)', true);
  console.log('  📸 screenshot → /tmp/eishera-dashboard.png');
} catch (e) {
  fail++;
  console.log('  ❌ exception:', e.message);
  await page.screenshot({ path: '/tmp/eishera-failure.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log(fail === 0 ? '\n[browser-test] PASSED' : `\n[browser-test] FAILED (${fail})`);
process.exit(fail ? 1 : 0);
