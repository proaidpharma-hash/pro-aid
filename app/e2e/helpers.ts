import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const USERS = {
  owner: { phone: '03001234567', pin: '112233', name: 'Ayan Khalid' },
  manager: { phone: '03002345678', pin: '223344', name: 'Bilal Hussain' },
  cashier: { phone: '03003456789', pin: '334455', name: 'Ahmed Raza' },
};

export async function signIn(page: Page, who: keyof typeof USERS) {
  await page.goto('/login');
  await page.fill('input[inputmode="tel"]', USERS[who].phone);
  await page.fill('input[type="password"]', USERS[who].pin);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/$/, { timeout: 15000 });
}
export async function signOut(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/login');
}

// a tiny valid JPEG so the photo pipeline (compress → upload → photos row) runs for real
let jpg: Buffer | null = null;
export function jpegFixture() {
  if (jpg) return jpg;
  const p = path.join(process.cwd(), 'e2e', 'fixture.jpg');
  if (!fs.existsSync(p)) throw new Error('fixture.jpg missing — run e2e/make-fixture.mjs');
  jpg = fs.readFileSync(p);
  return jpg;
}
export async function attachPhoto(page: Page, nth = 0) {
  const inputs = page.getByTestId('photo-gallery');
  await inputs.nth(nth).setInputFiles({ name: 'proof.jpg', mimeType: 'image/jpeg', buffer: jpegFixture() });
  await expect(page.getByTestId('photo-picker').nth(nth)).toContainText('attached', { timeout: 15000 });
}
export async function toastSeen(page: Page, text: string | RegExp) {
  await expect(page.locator('.toast').filter({ hasText: text }).last()).toBeVisible({ timeout: 10000 });
}
export async function amount(page: Page, selector: string, v: number) {
  await page.fill(selector, String(v));
}

// select an <option> whose visible text contains `text`
export async function selectByText(page: Page, selector: string, text: string) {
  const loc = page.locator(selector);
  await expect(loc.locator('option', { hasText: text })).toHaveCount(1, { timeout: 10000 });
  const value = await loc.locator('option', { hasText: text }).getAttribute('value');
  await loc.selectOption(value!);
}

// fill the note-by-note drawer count so that it adds up to `total` (greedy, largest note first)
export async function countNotes(page: Page, total: number) {
  let left = total;
  for (const n of [5000, 1000, 500, 100, 50, 20, 10, 5, 2, 1]) {
    const c = Math.floor(left / n); left -= c * n;
    await page.fill(`#note-${n}`, c ? String(c) : '');
  }
  await expect(page.getByTestId('denominations-total')).toHaveText(new Intl.NumberFormat('en-IN').format(total));
}
