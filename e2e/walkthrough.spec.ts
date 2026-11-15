import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// Walkthrough Phase 2 smoke: a manager builds a template, creates an inspection (the server pins version 1, D-15),
// publishes version 2, and the inspection still renders and downloads on version 1 (WT-04).
// Seeded as a child process, like security-pages.spec.ts (F-08).
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

test('template → inspection → pinned version survives a new template version', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@acme.demo.test' }).click();
  await page.getByRole('link', { name: 'Acme Studio' }).click();

  await page.getByRole('link', { name: 'Templates' }).click();
  const name = `House ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Version 1 · published')).toBeVisible();

  await page.getByRole('link', { name: 'Inspections' }).click();
  await page.getByLabel('Title').fill('Smith house');
  await page.getByLabel('Template').selectOption({ label: name });
  await page.getByLabel('Technician').selectOption({ label: 'owner@acme.demo.test' });
  await page.getByRole('button', { name: 'Create inspection' }).click();
  await expect(page.getByRole('heading', { name: 'Smith house' })).toBeVisible();
  await expect(page.getByText(`${name}, version 1 (pinned`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roof' })).toBeVisible();
  const inspectionUrl = page.url();

  await page.getByRole('link', { name: 'Templates' }).click();
  await page.getByRole('link', { name }).click();
  await page.getByLabel('Definition (JSON)').fill(JSON.stringify({ sections: [{ key: 'attic', title: 'Attic', items: [{ key: 'depth', label: 'Insulation depth', type: 'number' }] }] }));
  await page.getByRole('button', { name: 'Publish new version' }).click();
  await expect(page.getByText('Version 2 · published')).toBeVisible();

  await page.goto(inspectionUrl);
  await expect(page.getByText(`${name}, version 1 (pinned`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roof' })).toBeVisible();
  const sync = await page.request.get(`${inspectionUrl}/sync`);
  expect(sync.status()).toBe(200);
  const body = await sync.json();
  expect(body.template.version).toBe(1);
  expect(body.ops.map((o: { kind: string; opId: string }) => [o.kind, o.opId])).toEqual([['pin', 'server:1']]);
});
