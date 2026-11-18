import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

// Design pass 2026-11-18 (PRD "Design, UX and accessibility requirements"): keyboard focus is never thrown to the top
// of the page (DX-03), the signature can be typed (DX-04), and a refused template form keeps the admin's work (DX-05).
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

const OWNER = 'owner@acme.demo.test';

async function signIn(page: Page) {
  await page.goto('/demo');
  await page.getByRole('button', { name: OWNER }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
}

async function openNewInspection(page: Page) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await page.goto('/o/acme/templates');
  await page.getByLabel('Name').fill(`Keys ${stamp}`);
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByText('Version 1 · published')).toBeVisible();
  await page.goto('/o/acme/inspections');
  const title = `Keyboard house ${stamp}`;
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Template').selectOption({ label: `Keys ${stamp}` });
  await page.getByLabel('Technician').selectOption({ label: OWNER });
  await page.getByRole('button', { name: 'Create inspection' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.goto('/field?org=acme');
  await page.getByRole('button', { name: title }).click({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

const focused = (page: Page) => page.evaluate(() => {
  const e = document.activeElement as HTMLElement | null;
  return { tag: e?.tagName ?? '', value: (e as HTMLInputElement | null)?.value ?? '', label: e?.getAttribute('aria-label') ?? e?.textContent?.trim() ?? '' };
});

test('answering with the keyboard keeps focus on the question (DX-03)', async ({ page }) => {
  await signIn(page);
  await openNewInspection(page);
  const roof = page.getByRole('group', { name: 'Roof condition *' });
  await roof.getByLabel('Pass').focus();
  await page.keyboard.press('Space');
  await expect(roof.getByLabel('Pass')).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(roof.getByLabel('Fail')).toBeChecked();
  await expect(page.getByTestId('pending')).toHaveText(/changes? waiting to sync/);
  expect(await focused(page)).toMatchObject({ tag: 'INPUT', value: 'fail' });
});

test('a typed signature saves like a drawn one, and focus follows the controls (DX-03, DX-04)', async ({ page }) => {
  await signIn(page);
  await openNewInspection(page);
  await page.getByRole('button', { name: 'Type name instead' }).click();
  await expect(page.getByLabel('Signer’s full name')).toBeFocused();
  await page.keyboard.type('Pat Example');
  await page.getByRole('button', { name: 'Save signature' }).click();
  await expect(page.getByRole('img', { name: 'Signature: Customer signature' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign again' })).toBeFocused();
});

test('a refused template keeps the name and the definition the admin typed (DX-05)', async ({ page }) => {
  await signIn(page);
  await page.goto('/o/acme/templates');
  const name = `Typo ${Date.now()}`;
  const bad = '{ "sections": [ { "key": "a", ';
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Definition (JSON)').fill(bad);
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByText('The definition is not valid JSON.')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue(name);
  await expect(page.getByLabel('Definition (JSON)')).toHaveValue(bad);
});
