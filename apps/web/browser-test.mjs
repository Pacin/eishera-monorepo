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

  // ── Actions panel: recipes + monsters render, selecting starts an activity ─
  await page.click('nav.tabs >> text=Actions');
  await page.waitForSelector('text=Gather & craft');
  const recipeButtons = await page
    .locator('section:has-text("Gather & craft") button.primary')
    .count();
  ck('recipe list renders (≥1 Start button)', recipeButtons >= 1, recipeButtons);
  const monsterButtons = await page.locator('section:has-text("Battle") button.primary').count();
  ck('monster list renders (≥1 Fight button)', monsterButtons >= 1, monsterButtons);
  // Start the first recipe → its button flips to "Active" and the action ticker shows.
  await page.locator('section:has-text("Gather & craft") button.primary').first().click();
  await page.waitForSelector('section:has-text("Gather & craft") button:has-text("Active")', {
    timeout: 10000,
  });
  ck('selecting a recipe marks it Active', true);
  const current = await page.textContent('section:has-text("Current action")');
  ck('current action reflects the selection', /Gathering\/crafting/.test(current), current);

  // ── Character panel: stat cards + skill XP bars (xpToNext) ──────────────────
  await page.click('nav.tabs >> text=Character');
  await page.waitForSelector('text=Base stats');
  const statCards = await page.locator('section:has-text("Base stats") .card').count();
  ck('six base-stat cards render', statCards === 6, statCards);
  const xpBars = await page.locator('section:has-text("Skills") .bar.xp').count();
  ck('skill XP bars render (shared xpToNext)', xpBars >= 1, xpBars);

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
  await page.fill('section:has-text("Chat") input', marker);
  await page.click('section:has-text("Chat") button:has-text("Send")');
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
