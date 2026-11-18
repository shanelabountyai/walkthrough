import { execSync } from 'node:child_process';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Phase 3 (docs/walkthrough/PHASE3_PLAN.md, B4–B8): the field app installs, opens offline from its own cache after one
// online sync, keeps answers made offline across reloads, syncs them on reconnect, surfaces a two-device conflict,
// and makes no network call while the "Go offline" toggle is on. context.setOffline drives the browser offline.
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

const OWNER = 'owner@acme.demo.test';

async function signIn(page: Page) {
  await page.goto('/demo');
  await page.getByRole('button', { name: OWNER }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
}

/** A template and an inspection assigned to the demo owner, made through the manager pages. Returns its title and id. */
async function makeInspection(page: Page): Promise<{ title: string; id: string }> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.goto('/o/acme/templates');
  await page.getByLabel('Name').fill(`Field ${stamp}`);
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByText('Version 1 · published')).toBeVisible();
  await page.goto('/o/acme/inspections');
  const title = `House ${stamp}`;
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Template').selectOption({ label: `Field ${stamp}` });
  await page.getByLabel('Technician').selectOption({ label: OWNER });
  await page.getByRole('button', { name: 'Create inspection' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return { title, id: page.url().split('/').pop()! };
}

/** Open the field app online once: the service worker installs and takes control, and the inspection downloads. */
async function openField(page: Page, title: string) {
  await page.goto('/field?org=acme');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: title })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status')).toHaveText('Synced');
}

const pending = (page: Page) => page.getByTestId('pending');

async function device(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  return { context, page };
}

test('installable; opens offline from its cache; offline answers survive a reload and sync on reconnect (B4–B6)', async ({ browser }) => {
  const { context, page } = await device(browser);
  const { title, id } = await makeInspection(page);

  const manifest = await page.request.get('/manifest.webmanifest');
  expect((await manifest.json()).start_url).toBe('/field');
  await openField(page, title);
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(/\/sw\.js$/);

  await context.setOffline(true);
  const nav = await page.reload();
  expect(nav?.headers()['x-walkthrough-cache']).toBe('hit'); // the shell came from the service worker's cache
  expect(await page.evaluate(() => fetch('/api/health').then(() => 'up', () => 'down'))).toBe('down'); // the network really is gone
  await expect(page.getByTestId('mode')).toHaveText('Offline (no network)');
  await page.getByRole('button', { name: title }).click();
  await page.getByRole('group', { name: 'Roof condition *' }).getByLabel('Pass').check();
  await page.getByLabel('Supply air temperature').fill('72');
  await page.getByLabel('Supply air temperature').press('Enter');
  await expect(pending(page)).toHaveText('2 changes waiting to sync');

  await page.reload(); // still offline: everything comes back from IndexedDB
  await page.getByRole('button', { name: title }).click();
  await expect(page.getByRole('group', { name: 'Roof condition *' }).getByLabel('Pass')).toBeChecked();
  await expect(page.getByLabel('Supply air temperature')).toHaveValue('72');
  await expect(pending(page)).toHaveText('2 changes waiting to sync');

  await context.setOffline(false); // the 'online' event syncs
  await expect(pending(page)).toHaveText('0 changes waiting to sync', { timeout: 15_000 });
  const server = await (await page.request.get(`/o/acme/inspections/${id}/sync`)).json();
  const sets = server.ops.filter((o: { kind: string }) => o.kind === 'set').map((o: { path: string; value: unknown }) => [o.path, o.value]);
  expect(sets).toEqual(expect.arrayContaining([['items.roof-condition', 'pass'], ['items.supply-temp', 72]]));
  await context.close();
});

test('two devices answer one field offline: both see the conflict, resolving on one clears it on both (B7)', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser);
  const { title } = await makeInspection(a.page);
  for (const d of [a, b]) {
    await openField(d.page, title);
    await d.context.setOffline(true);
    await d.page.getByRole('button', { name: title }).click();
  }
  await a.page.getByRole('group', { name: 'Roof condition *' }).getByLabel('Pass').check();
  await b.page.getByRole('group', { name: 'Roof condition *' }).getByLabel('Fail').check();
  await a.context.setOffline(false);
  await expect(pending(a.page)).toHaveText('0 changes waiting to sync', { timeout: 15_000 });
  await b.context.setOffline(false);
  await expect(pending(b.page)).toHaveText('0 changes waiting to sync', { timeout: 15_000 });
  const resolveB = b.page.getByRole('group', { name: 'Resolve Roof condition' });
  await expect(resolveB).toBeVisible();
  // Design pass 2026-11-18 (Conflict artboard): both values are shown as choices, neither chosen until one is picked.
  await expect(resolveB.getByRole('button', { name: /^Pass /, pressed: false })).toBeVisible(); // both values kept (WT-03)
  await expect(resolveB.getByRole('button', { name: /^Fail /, pressed: false })).toBeVisible();
  await expect(resolveB.getByRole('button', { name: 'Pick a value first' })).toBeDisabled();
  await a.page.getByRole('button', { name: 'Sync now' }).click();
  await expect(a.page.getByRole('group', { name: 'Resolve Roof condition' })).toBeVisible();

  await resolveB.getByRole('button', { name: /^Fail / }).click(); // pick…
  await expect(resolveB.getByRole('button', { name: /^Fail /, pressed: true })).toBeVisible();
  await resolveB.getByRole('button', { name: 'Keep Fail' }).click(); // …then keep: b has seen both, one write supersedes them
  await expect(resolveB).toBeHidden();
  await expect(pending(b.page)).toHaveText('0 changes waiting to sync', { timeout: 15_000 });
  await a.page.getByRole('button', { name: 'Sync now' }).click();
  await expect(a.page.getByRole('group', { name: 'Resolve Roof condition' })).toBeHidden();
  await expect(a.page.getByRole('group', { name: 'Roof condition *' }).getByLabel('Fail')).toBeChecked();
  await a.context.close();
  await b.context.close();
});

test('the Go offline toggle makes no network calls; turning it off syncs (B8)', async ({ browser }) => {
  const { context, page } = await device(browser);
  const { title } = await makeInspection(page);
  await openField(page, title);
  await page.getByRole('button', { name: 'Go offline' }).click();
  await expect(page.getByTestId('mode')).toHaveText('Offline (demo toggle)');
  const calls: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/o/')) calls.push(r.url()); });
  await page.getByRole('button', { name: title }).click();
  await page.getByRole('group', { name: 'Roof condition *' }).getByLabel('N/A').check();
  await page.getByLabel('Notes').fill('filter dirty');
  await page.getByLabel('Notes').blur();
  await expect(pending(page)).toHaveText('2 changes waiting to sync');
  await page.reload(); // the toggle is remembered on the device
  await expect(page.getByTestId('mode')).toHaveText('Offline (demo toggle)');
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: 'Go online' }).click();
  await expect(pending(page)).toHaveText('0 changes waiting to sync', { timeout: 15_000 });
  expect(calls.length).toBeGreaterThan(0);
  await context.close();
});
