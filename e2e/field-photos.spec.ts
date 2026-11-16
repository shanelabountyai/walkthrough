import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BLUE_PNG, RED_JPEG } from '../tests/walkthrough/images';

// Phase 4 (docs/walkthrough/PHASE4_PLAN.md, C6, C10, C12): photos and a customer signature captured with the browser
// offline survive an offline reload, reach the server byte-identical (by content hash) once it reconnects, and the
// finished inspection's PDF report is stored and linked. context.setOffline drives the browser offline.
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

const OWNER = 'owner@acme.demo.test';
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function device(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/demo');
  await page.getByRole('button', { name: OWNER }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  return { context, page };
}

async function makeInspection(page: Page) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.goto('/o/acme/templates');
  await page.getByLabel('Name').fill(`Photos ${stamp}`);
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByText('Version 1 · published')).toBeVisible();
  await page.goto('/o/acme/inspections');
  const title = `Photo house ${stamp}`;
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Template').selectOption({ label: `Photos ${stamp}` });
  await page.getByLabel('Technician').selectOption({ label: OWNER });
  await page.getByRole('button', { name: 'Create inspection' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return { title, id: page.url().split('/').pop()! };
}

async function drawSignature(page: Page) {
  const pad = page.getByLabel('Signature pad: Customer signature');
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(box.x + 20 + k * 18, box.y + box.height * (0.6 - 0.3 * Math.sin(k / 2)));
  await page.mouse.up();
}

test('photos and a signature captured offline sync after reconnect; the finished report is stored and linked (C6, C10, C12)', async ({ browser }) => {
  const { context, page } = await device(browser);
  const { title, id } = await makeInspection(page);
  await page.goto('/field?org=acme');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: title })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status')).toHaveText('Synced');

  await context.setOffline(true);
  await page.reload(); // the shell from the service worker's cache, the inspection from IndexedDB
  await expect(page.getByTestId('mode')).toHaveText('Offline (no network)');
  await page.getByRole('button', { name: title }).click();
  await page.getByRole('group', { name: 'Roof condition *' }).getByLabel('Pass').check();
  await page.getByLabel('Supply air temperature').fill('70');
  await page.getByLabel('Supply air temperature').press('Enter');
  const add = page.getByLabel('Add photo: Photo of the roof');
  await add.setInputFiles({ name: 'roof-1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(RED_JPEG) });
  await expect(page.getByRole('img', { name: 'Photo of the roof, photo 1' })).toBeVisible();
  await add.setInputFiles({ name: 'roof-2.png', mimeType: 'image/png', buffer: Buffer.from(BLUE_PNG) });
  await expect(page.getByRole('img', { name: 'Photo of the roof, photo 2' })).toBeVisible();
  await drawSignature(page);
  await page.getByRole('button', { name: 'Save signature' }).click();
  await expect(page.getByRole('img', { name: 'Signature: Customer signature' })).toBeVisible();
  await expect(page.getByTestId('pending')).toHaveText('5 changes waiting to sync');
  await expect(page.getByTestId('uploads')).toHaveText('3 photos waiting to upload');
  await expect(page.getByRole('button', { name: 'Finish and make report' })).toBeDisabled(); // needs a connection

  await page.reload(); // still offline: answers, photos and the signature all come back from IndexedDB
  await page.getByRole('button', { name: title }).click();
  await expect(page.getByRole('img', { name: 'Photo of the roof, photo 2' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Signature: Customer signature' })).toBeVisible();
  await expect(page.getByTestId('uploads')).toHaveText('3 photos waiting to upload');
  const truckroll = await page.getByRole('link', { name: 'Open this day in Truckroll' }).getAttribute('href');
  expect(truckroll).toMatch(/^http:\/\/localhost:7800\/o\/acme\/dispatch\?date=\d{4}-\d{2}-\d{2}$/);

  await context.setOffline(false); // the 'online' event syncs: ops first, then the blobs
  await expect(page.getByTestId('pending')).toHaveText('0 changes waiting to sync', { timeout: 20_000 });
  await expect(page.getByTestId('uploads')).toHaveText('0 photos waiting to upload', { timeout: 20_000 });

  const server = await (await page.request.get(`/o/acme/inspections/${id}/sync`)).json();
  const latest = (path: string) => server.ops.filter((o: { kind: string; path: string }) => o.kind === 'set' && o.path === path).at(-1).value;
  const photos: string[] = latest('items.roof-photo');
  const signature: string = latest('items.customer-signature');
  expect(photos).toHaveLength(2);
  for (const h of [...photos, signature]) {
    const res = await page.request.get(`/o/acme/inspections/${id}/blobs/${h}`);
    expect(res.status()).toBe(200);
    expect(sha(await res.body())).toBe(h); // byte-identical: the server holds exactly what the device hashed
  }
  expect((await page.request.get(`/o/acme/inspections/${id}/blobs/${signature}`)).headers()['content-type']).toBe('image/png');

  await page.getByRole('button', { name: 'Finish and make report' }).click();
  const link = page.getByRole('link', { name: 'Open report 1 (PDF)' });
  await expect(link).toBeVisible({ timeout: 20_000 });
  const pdf = await page.request.get((await link.getAttribute('href'))!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await page.goto(`/o/acme/inspections/${id}`); // the manager page links the stored report and shows the photos
  await expect(page.getByRole('link', { name: 'Report 1 (PDF)' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Photo of the roof, photo 1' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Signature: Customer signature' })).toBeVisible();
  await context.close();
});
