// Browser test of the admin panel against the real API + MongoDB (CI job "node", step "Panel end-to-end").
// Needs: web on BASE (with /api proxied to the API), an ISP `e2e`, an ISP Admin and a Support user (see ci.yml).
/* global document, window -- inside page.evaluate */
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import process from 'node:process';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
const TENANT = 'e2e';
const ADMIN = { login: 'admin@e2e.test', password: process.env.E2E_PASSWORD ?? 'Monsoon-Fibre-42' };
const SUPPORT = { login: 'support@e2e.test', password: ADMIN.password };
const ART = 'e2e-artifacts';
mkdirSync(ART, { recursive: true });

function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let browser;
let page;
const errors = [];

async function signIn(p, who) {
  await p.goto(`${BASE}/login`);
  await p.getByRole('button', { name: 'Sign in to a different organisation' }).click();
  await p.fill('#tenant', TENANT);
  await p.fill('#login', who.login);
  await p.fill('#password', who.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
}

before(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
});

after(async () => {
  await browser?.close();
});

const step = (name, fn) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      await page
        .screenshot({ path: `${ART}/${name.replace(/\W+/g, '-')}.png`, fullPage: true })
        .catch(() => {});
      throw e;
    }
  });

step('signed-out visit goes to sign-in', async () => {
  await page.goto(`${BASE}/admin/subscribers`);
  await page.waitForURL(/\/login\?next=%2Fadmin%2Fsubscribers/);
});

step('ISP Admin must enrol 2FA, then lands on the dashboard', async () => {
  await signIn(page, ADMIN);
  await page.waitForURL(/\/setup-2fa/);
  await page.getByText("Can't scan? Enter the key instead").click();
  const secret = (await page.locator('details code').textContent()).trim();
  await page.fill('#code', totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.waitForURL(/\/admin$/);
  await page.getByRole('heading', { name: /Hello, E2E/ }).waitFor();
});

step('create a plan', async () => {
  await page.getByRole('link', { name: 'Plans' }).click();
  await page.getByRole('button', { name: 'New plan' }).click();
  await page.fill('#p-name', 'E2E Home 50');
  await page.fill('#p-down', '50');
  await page.fill('#p-up', '20');
  await page.fill('#p-price', '499');
  await page.fill('#p-cap', '500');
  await page.fill('#p-fd', '5');
  await page.fill('#p-fu', '2');
  await page.getByRole('button', { name: 'Create plan' }).click();
  await page.getByRole('cell', { name: 'E2E Home 50', exact: true }).waitFor();
  await page.getByText('20M/50M', { exact: true }).waitFor();
});

step('add a router; the generated secret is shown once', async () => {
  await page.getByRole('link', { name: 'Routers' }).click();
  await page.getByRole('button', { name: 'Add router' }).click();
  await page.fill('#n-name', 'E2E POP-1');
  await page.fill('#n-ip', '198.51.100.7');
  await page.getByRole('button', { name: 'Add router', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Router ready' }).waitFor();
  assert.match(await page.locator('[role=dialog] code').first().textContent(), /^[\w-]{24}$/);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('cell', { name: 'E2E POP-1', exact: true }).waitFor();
});

step('create a subscriber with a generated password', async () => {
  await page.getByRole('link', { name: 'Subscribers' }).click();
  await page.getByRole('link', { name: 'New subscriber' }).click();
  await page.fill('#username', 'e2e.ramesh');
  await page.selectOption('#planId', { label: 'E2E Home 50' });
  await page.fill('#name', 'Ramesh E2E');
  await page.fill('#phone', '98765 43210');
  await page.fill('#line1', '12 Gandhi Nagar');
  await page.fill('#city', 'Noida');
  await page.fill('#state', 'Uttar Pradesh');
  await page.fill('#pincode', '201301');
  await page.getByRole('button', { name: 'Create subscriber' }).click();
  await page.getByRole('heading', { name: 'Subscriber created' }).waitFor();
  await page.getByRole('button', { name: 'Open subscriber' }).click();
  await page.waitForURL(/\/admin\/subscribers\/[0-9a-f]{24}$/);
  await page.getByRole('heading', { name: /Ramesh E2E/ }).waitFor();
});

step('server validation shows on the field', async () => {
  await page.goto(`${BASE}/admin/subscribers/new`);
  await page.fill('#username', 'e2e.ramesh');
  await page.fill('#name', 'Duplicate');
  await page.fill('#phone', '9876543211');
  await page.fill('#line1', 'x');
  await page.fill('#city', 'Noida');
  await page.fill('#state', 'UP');
  await page.fill('#pincode', '201301');
  await page.getByRole('button', { name: 'Create subscriber' }).click();
  await page.getByRole('alert').filter({ hasText: 'This PPPoE username is already used' }).waitFor();
});

step('edit sends only the change and shows in history', async () => {
  await page.goto(`${BASE}/admin/subscribers?q=ramesh`);
  await page.getByRole('link', { name: 'Ramesh E2E' }).click();
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.fill('#name', 'Ramesh Kumar E2E');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: /Ramesh Kumar E2E/ }).waitFor();
  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByText('Ramesh Kumar E2E').last().waitFor();
  await page.locator('.line-through', { hasText: 'Ramesh E2E' }).first().waitFor();
});

step('audit log lists the changes and sign-in', async () => {
  await page.getByRole('link', { name: 'Audit log' }).click();
  await page
    .getByRole('cell', { name: /subscriber\s*Create/ })
    .first()
    .waitFor();
  await page.selectOption('#a-area', { label: 'Sign-ins and security' });
  await page.getByText('2FA enable').first().waitFor();
});

step('resellers: tree, drill-down and a customer added from a reseller', async () => {
  await page.getByRole('link', { name: 'Resellers' }).click();
  await page.getByRole('button', { name: 'New reseller' }).click();
  await page.fill('#r-name', 'E2E Noida Net');
  await page.fill('#r-owner', 'Amit');
  await page.getByRole('button', { name: 'Add reseller' }).click();
  await page.getByRole('link', { name: 'E2E Noida Net' }).click();
  await page.waitForURL(/\/admin\/resellers\/[0-9a-f]{24}$/);
  await page.getByRole('button', { name: 'Sub-reseller' }).click();
  await page.fill('#r-name', 'E2E Sector 62');
  await page.fill('#r-owner', 'Bina');
  await page.getByRole('button', { name: 'Add reseller' }).click();
  await page.getByRole('heading', { name: /E2E Sector 62/ }).waitFor();
  await page
    .getByRole('navigation', { name: 'Reseller path' })
    .getByRole('link', { name: 'E2E Noida Net' })
    .waitFor();
  await page.getByRole('link', { name: 'Customer', exact: true }).click();
  await page.waitForURL(/\/admin\/subscribers\/new\?reseller=/);
  await page.getByText(/E2E Sector 62 · R-\d{4}/).waitFor();
  await page.goto(`${BASE}/admin/resellers`);
  await page.getByRole('link', { name: '1 sub-reseller of E2E Noida Net' }).click();
  await page.waitForURL(/parent=/);
  await page.getByRole('link', { name: 'E2E Sector 62' }).waitFor();
  await page
    .getByRole('row', { name: /E2E Sector 62/ })
    .getByRole('cell')
    .nth(1)
    .click();
  await page.waitForURL(/\/admin\/resellers\/[0-9a-f]{24}$/);
  await page.getByRole('heading', { name: /E2E Sector 62/ }).waitFor();
});

step('phone layout: cards, no sideways scrolling, menu works', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/admin/subscribers`);
  await page.getByRole('link', { name: 'Ramesh Kumar E2E' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Online now' }).click();
  await page.waitForURL(/\/admin\/sessions/);
  await page.setViewportSize({ width: 1280, height: 860 });
});

step('sign out', async () => {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  await page.goto(`${BASE}/admin`);
  await page.waitForURL(/\/login/);
});

step('Support sees only what the role allows', async () => {
  await signIn(page, SUPPORT);
  await page.waitForURL(/\/admin$/);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Subscribers' }).waitFor();
  for (const hidden of ['Staff & roles', 'Audit log', 'ISP settings', 'Import & export']) {
    assert.equal(await nav.getByRole('link', { name: hidden }).count(), 0, `${hidden} should be hidden`);
  }
  await page.goto(`${BASE}/admin/users`);
  await page.getByText('Your role does not allow this.').first().waitFor();
  await page.goto(`${BASE}/admin/routers`);
  await page.getByRole('cell', { name: 'E2E POP-1', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add router' }).count(), 0);
  await page.goto(`${BASE}/admin/subscribers?q=ramesh`);
  await page.getByRole('link', { name: 'Ramesh Kumar E2E' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Suspend' }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Delete' }).count(), 0, 'Support must not delete');
  await page.keyboard.press('Escape');
});

step('no uncaught page errors', async () => {
  assert.deepEqual(errors, []);
});
