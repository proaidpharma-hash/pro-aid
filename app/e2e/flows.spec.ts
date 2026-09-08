import { test, expect } from '@playwright/test';
import { signIn, signOut, attachPhoto, toastSeen, selectByText, countNotes } from './helpers';

// One full pharmacy day, in the order it happens, across the three roles.
// Each step exercises a rule the owner asked for. Tests run in order against one database.
test.describe.configure({ mode: 'serial' });

test('cashier adds a purchase with photo, pays part from cash, cannot exceed or duplicate', async ({ page }) => {
  await signIn(page, 'cashier');
  await page.goto('/purchases/new');
  await page.getByTestId('distributor').selectOption({ label: 'Getz Pharma (Sahil Traders)' });
  await page.getByTestId('invoice-no').fill('55120');
  await page.fill('#invoice-amount', '53800');
  await expect(page.getByTestId('save-purchase')).toBeDisabled(); // no photo, no POS answer yet
  await attachPhoto(page);
  await page.getByRole('radio', { name: 'Not yet' }).click();
  await page.getByRole('radio', { name: 'In installments' }).click();
  await expect(page.getByTestId('save-purchase')).toBeEnabled();
  await page.getByTestId('save-purchase').click();
  await toastSeen(page, 'Purchase saved');
  await expect(page).toHaveURL(/\/purchases/);
  await expect(page.locator('table')).toContainText('55120');
  await expect(page.locator('table')).toContainText('Not posted');

  // pay 27,400 from yesterday's cash
  await page.goto('/pay');
  await selectByText(page, '[data-testid=\"pay-distributor\"]', 'Getz Pharma');
  await selectByText(page, '[data-testid=\"pay-invoice\"]', '55120');
  await expect(page.locator('.notice.ok')).toContainText('53,800 remaining');
  await page.fill('#pay-amount', '60000');
  await expect(page.locator('.notice.danger')).toContainText('Exceeds remaining');
  await expect(page.getByTestId('save-payment')).toBeDisabled();
  await page.fill('#pay-amount', '27400');
  await page.getByTestId('source-cash_drawer').click();
  await page.getByRole('radio', { name: "Yesterday's cash" }).click();
  await expect(page.getByTestId('save-payment')).toBeDisabled(); // photo required
  await attachPhoto(page);
  await page.getByTestId('save-payment').click();
  await toastSeen(page, 'Payment saved');
  await expect(page).toHaveURL(/\/distributors\//);
  await expect(page.locator('.content')).toContainText('Installments 1/3');
  await expect(page.locator('.content')).toContainText('26,400 left');
  await expect(page.locator('.content')).toContainText("Yesterday's cash · by Ahmed Raza");

  // second payment: same amount same day triggers the warning; pay the rest online; then a third attempt is blocked
  await page.goto('/pay');
  await selectByText(page, '[data-testid=\"pay-distributor\"]', 'Getz Pharma');
  await selectByText(page, '[data-testid=\"pay-invoice\"]', '55120');
  await page.fill('#pay-amount', '27400');
  await expect(page.locator('.notice.warn')).toContainText('Same amount already paid', { timeout: 10000 });
  await page.fill('#pay-amount', '26400');
  await expect(page.locator('.notice.ok').nth(1)).toContainText('Fully paid');
  await page.getByTestId('source-bank').click();
  await attachPhoto(page);
  await page.getByTestId('save-payment').click();
  await toastSeen(page, 'Payment saved');
  await expect(page.locator('.content')).toContainText('Paid in full');
  await page.goto('/pay');
  await selectByText(page, '[data-testid=\"pay-distributor\"]', 'Getz Pharma');
  await expect(page.locator('.notice.info')).toContainText('No unpaid invoices'); // the duplicate guard: nothing left to pay
});

test('cashier cannot see staff advances of others, can add an expense with receipt', async ({ page }) => {
  await signIn(page, 'cashier');
  await page.goto('/expenses/new');
  await page.getByRole('radio', { name: 'Bike fuel' }).click();
  await page.fill('#expense-amount', '4250');
  await page.getByTestId('expense-note').fill('Petrol for delivery bike');
  await expect(page.getByTestId('save-expense')).toBeDisabled();
  await attachPhoto(page);
  await page.getByTestId('save-expense').click();
  await toastSeen(page, 'Expense saved');
  await expect(page.locator('.content')).toContainText('Petrol for delivery bike');
  await expect(page.locator('.content')).toContainText('4,250');
  await page.goto('/staff');
  await expect(page.locator('.content')).toContainText('Ahmed Raza');
  await expect(page.locator('.content')).not.toContainText('Bilal');
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/$/); // cashier bounced from owner-only pages
});

test('cashier enters card/online receipts and a credit bill through the day', async ({ page }) => {
  await signIn(page, 'cashier');
  await page.getByTestId('add-receipt').click();
  await page.getByRole('radio', { name: /HBL card machine/ }).click();
  await page.fill('#receipt-amount', '1200');
  await attachPhoto(page);
  await page.getByTestId('save-receipt-again').click();
  await toastSeen(page, '1,200 on HBL card machine saved');
  await page.getByRole('radio', { name: /HBL card machine/ }).click();
  await page.fill('#receipt-amount', '2000');
  await attachPhoto(page);
  await page.getByTestId('save-receipt').click();
  await toastSeen(page, '2,000 on HBL card machine saved');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.content')).toContainText('2 receipts');
  // a credit bill for a customer, whole bill on credit
  await page.getByTestId('add-credit-bill').click();
  await selectByText(page, '[data-testid="credit-who"]', 'Imran Butt');
  await page.getByTestId('credit-bill-no').fill('9001');
  await page.fill('#credit-bill-total', '700');
  await attachPhoto(page);
  await page.getByTestId('credit-add').click();
  await toastSeen(page, '700 on credit for Imran Butt saved');
  await expect(page.locator('.content')).toContainText('Imran Butt · bill 9001');
});

test('manager records the daily sale with slips and screenshots, cash part is worked out', async ({ page }) => {
  await signOut(page);
  await signIn(page, 'manager');
  await page.goto('/sales/new');
  await page.fill('#pos-total', '104350');
  await attachPhoto(page, 0);
  const line = async (name: string, v: string, nth: number) => {
    const input = page.locator(`label:has-text("${name}") + .amount-wrap input`);
    await input.fill(v);
    await attachPhoto(page, nth);
  };
  await expect(page.locator('[data-testid^="receipts-"]')).toContainText('3,200'); // HBL from the cashier's two receipts
  await line('UBL card machine', '2100', 1);
  await line('Alfalah card machine', '1200', 2);
  await line('EasyPaisa', '2500', 3);
  await line('JazzCash', '1500', 4);
  // credit: 2,500 of Rashid Ali's 4,000 bill goes on credit, with the bill photo
  await page.getByTestId('add-credit').click();
  await selectByText(page, '[data-testid="credit-who"]', 'Rashid Ali');
  await page.getByTestId('credit-bill-no').fill('4470');
  await page.fill('#credit-bill-total', '4000');
  await page.getByRole('radio', { name: 'Part of it' }).click();
  await page.fill('#credit-amount', '2500');
  await attachPhoto(page, 5);
  await page.getByTestId('credit-add').click();
  await expect(page.getByTestId('credit-total')).toHaveText('3,200'); // 700 entered through the day + 2,500
  await expect(page.locator('.content')).toContainText('1,500 paid now');
  await expect(page.getByTestId('cash-part')).toHaveText('90,650');
  await expect(page.locator('.notice.ok')).toContainText('matches POS');
  await page.getByTestId('save-sale').click();
  await toastSeen(page, 'Daily sale saved');
  await expect(page).toHaveURL(/\/closing/);
});

test('manager closes the day: expected cash computed, minus turns red, closing immutable', async ({ page }) => {
  await signIn(page, 'manager');
  // a credit bill collected in cash first (+1,200)
  await page.goto('/customers');
  await page.getByRole('button', { name: 'New credit bill' }).click();
  await selectByText(page, '.sheet select', 'Rashid Ali');
  await page.locator('.sheet input.num').first().fill('4476');
  await page.locator('.sheet .amount-wrap input').fill('1800');
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Save")').click();
  await toastSeen(page, 'Credit bill saved');
  await page.getByRole('button', { name: 'Collect payment' }).click();
  await selectByText(page, '.sheet select', 'Rashid Ali');
  await page.locator('.sheet .amount-wrap input').fill('1200');
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Save")').click();
  await toastSeen(page, 'Collection saved');
  await expect(page.locator('.content')).toContainText('owes 3,100'); // 2,500 from the sale + 1,800 − 1,200

  await page.goto('/closing');
  // 52,800 + 90,650 + 1,200 − 27,400 − 4,250 = 1,13,000
  await expect(page.getByTestId('expected-cash')).toHaveText('1,13,000');
  // posting check: the invoice received today is not posted — closing waits for an answer
  await expect(page.locator('.content')).toContainText('Needs answer');
  await expect(page.getByTestId('submit-closing')).toContainText('Answer 1 unposted invoice');
  await page.getByTestId('posting-reason').click();
  await page.getByTestId('unposted-reason').fill('stock check still pending');
  await page.getByTestId('unposted-reason-save').click();
  await toastSeen(page, 'Reason saved');
  await expect(page.locator('.content')).toContainText('not posted: stock check still pending (Bilal Hussain)');
  // …then it turns out only 51,800 of the 53,800 was posted: two items short
  await page.getByTestId('posting-posted').click();
  await page.fill('#posted-amount', '51800');
  await expect(page.locator('.sheet')).toContainText('Posted 2,000 less than the invoice');
  await page.getByRole('radio', { name: 'Items short' }).click();
  await page.getByTestId('diff-note').fill('2 packs missing, rep will send tomorrow');
  await page.getByTestId('posted-save').click();
  await toastSeen(page, '2,000 difference recorded');
  await expect(page.locator('.content')).toContainText('Posted today with a difference');
  await expect(page.locator('.content')).toContainText('2,000 short');
  await countNotes(page, 112500);
  await expect(page.getByTestId('live-diff')).toContainText('MINUS');
  await countNotes(page, 113940);
  await expect(page.getByTestId('live-diff')).toContainText('Difference + 940');
  await expect(page.getByTestId('submit-closing')).toBeDisabled();
  await attachPhoto(page);
  await page.getByTestId('submit-closing').click();
  await toastSeen(page, 'Closing submitted');
  await expect(page.getByTestId('difference')).toHaveText('+ Rs 940');
  await expect(page.locator('.content')).toContainText('Notes counted: 5000×22 · 1000×3 · 500×1 · 100×4 · 20×2');
  await expect(page.locator('.content')).toContainText('cannot be edited');
  await page.goto('/');
  await expect(page.locator('.content')).toContainText('1,13,940');
  await expect(page.locator('.topbar')).toContainText('awaiting approval');
});

test('owner sees the alerts, approves & locks the day, locked day rejects entries, unlock needs a reason', async ({ page }) => {
  await signOut(page);
  await signIn(page, 'owner');
  // the posting difference shows on the distributor and can be settled once the goods arrive
  await page.goto('/distributors');
  await expect(page.locator('.content')).toContainText('they owe 2,000 (posting difference)');
  await page.locator('.row', { hasText: 'Getz Pharma' }).click();
  await expect(page.locator('.content')).toContainText('They owe us · posting differences · 2,000');
  await page.getByRole('button', { name: 'Settle…' }).click();
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Settle")').last().click();
  await toastSeen(page, 'Difference settled');
  await expect(page.locator('.content')).not.toContainText('They owe us');
  await page.goto('/notifications');
  await expect(page.locator('.content')).toContainText('Closing submitted');
  await page.goto('/closing');
  await page.getByTestId('approve-day').click();
  await toastSeen(page, 'Day approved and locked');
  await expect(page.locator('.topbar')).toContainText('Approved & locked');
  // a new expense on the locked day is refused by the database
  await page.goto('/expenses/new');
  await page.getByRole('radio', { name: 'Other' }).click();
  await page.fill('#expense-amount', '10');
  await attachPhoto(page);
  await page.getByTestId('save-expense').click();
  await toastSeen(page, /approved and locked/);
  // unlock with a reason
  await page.goto('/closing');
  await page.getByRole('button', { name: 'Unlock day…' }).click();
  await expect(page.locator('.sheet button:has-text("Unlock day")').last()).toBeDisabled(); // no reason typed
  await page.locator('.sheet textarea').fill('manager counted a bundle twice');
  await page.locator('.sheet button:has-text("Unlock day")').last().click();
  await toastSeen(page, 'Day unlocked');
  await expect(page.getByTestId('submit-closing')).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Audit log' }).click();
  await expect(page.locator('table')).toContainText('unlock');
  await expect(page.locator('table')).toContainText('manager counted a bundle twice');
});

test('owner corrects an expense with a reason; staff advance; WAW loan; reminder; owner-paid invoice minused from receipts', async ({ page }) => {
  await signIn(page, 'owner');
  // owner edit with reason
  await page.goto('/expenses');
  await page.locator('.row', { hasText: 'Petrol' }).getByRole('link', { name: 'Edit' }).click();
  await page.locator('.sheet .amount-wrap input').fill('1500');
  await expect(page.locator('.sheet button:has-text("Save correction")')).toBeDisabled();
  await page.locator('.sheet textarea').fill('typed 4250 instead of 1500 — receipt shows 1,500');
  await page.locator('.sheet button:has-text("Save correction")').click();
  await toastSeen(page, 'Correction saved');
  await expect(page.locator('.content')).toContainText('1,500');

  // staff advance (owner only) with slip photo
  await page.goto('/staff');
  await page.locator('.row', { hasText: 'Ahmed Raza' }).click();
  await page.getByRole('button', { name: 'Add advance / credit' }).click();
  await page.locator('.sheet .amount-wrap input').fill('5000');
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Save")').click();
  await toastSeen(page, 'Saved');
  await expect(page.locator('.kpi.warn')).toContainText('5,000');

  // WAW borrow 40,000 then repay 5,000 → 35,000 owed; repay more than owed is refused in the form
  await page.goto('/waw');
  await page.getByRole('button', { name: 'Borrow from WAW F/S' }).click();
  await page.locator('.sheet .amount-wrap input').fill('40000');
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Save loan")').click();
  await toastSeen(page, 'Saved');
  await expect(page.locator('.content')).toContainText('40,000');
  await page.getByRole('button', { name: 'Repay WAW F/S' }).click();
  await page.locator('.sheet .amount-wrap input').fill('50000');
  await expect(page.locator('.sheet')).toContainText('More than owed');
  await page.locator('.sheet .amount-wrap input').fill('5000');
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Save repayment")').click();
  await toastSeen(page, 'Saved');
  await expect(page.locator('.kpi.danger')).toContainText('35,000');

  // an invoice paid from the owner's personal account, then minused from the UBL machine receipts
  await page.goto('/purchases/new');
  await page.getByTestId('distributor').selectOption({ label: 'IBL Healthcare' });
  await page.getByTestId('invoice-no').fill('30412');
  await page.fill('#invoice-amount', '2000');
  await attachPhoto(page);
  await page.getByRole('radio', { name: 'Yes, posted' }).click();
  await page.getByRole('radio', { name: 'Pay now (on the spot)' }).click();
  await page.getByTestId('save-purchase').click();
  await expect(page).toHaveURL(/\/pay\?invoice=/);
  await expect(page.locator('.notice.ok')).toContainText('2,000 remaining');
  await page.fill('#pay-amount', '2000');
  await page.getByTestId('source-owner_personal').click();
  await attachPhoto(page);
  await page.getByTestId('save-payment').click();
  await toastSeen(page, 'Payment saved');
  await page.goto('/noncash');
  await expect(page.locator('.content')).toContainText('UBL card machine');
  await expect(page.locator('.content')).toContainText('IBL Healthcare · Inv 30412');
  await page.getByRole('button', { name: 'Minus from…' }).click();
  await page.locator('.tile', { hasText: 'UBL card machine' }).click();
  await attachPhoto(page);
  await page.locator('.sheet button:has-text("Minus")').last().click();
  await toastSeen(page, 'Settled');
  await expect(page.locator('.content')).toContainText('minused');
  await expect(page.locator('.card.accent')).toContainText('2,000');

  // reminder from the distributor ledger + insights + reports render
  await page.goto('/purchases/new');
  await page.getByTestId('distributor').selectOption({ label: 'Muller & Phipps' });
  await page.getByTestId('invoice-no').fill('88213');
  await page.fill('#invoice-amount', '22400');
  await attachPhoto(page);
  await page.getByRole('radio', { name: 'Yes, posted' }).click();
  await page.getByTestId('save-purchase').click();
  await toastSeen(page, 'Purchase saved');
  await page.goto('/distributors');
  await page.locator('.row', { hasText: 'Muller & Phipps' }).click();
  await page.locator('button[title="Set reminder"]').first().click();
  await page.locator('.sheet button:has-text("Set reminder")').click();
  await toastSeen(page, 'Reminder set');
  await page.goto('/insights');
  await expect(page.locator('.content')).toContainText('Total sale');
  await expect(page.locator('.content')).toContainText('Extra cash above the POS sale');
  await expect(page.locator('.content')).toContainText('1,04,350');
  await expect(page.locator('.content')).toContainText('Owed to WAW F/S');
  // the day was unlocked earlier: close it again (owner may close) and approve
  await page.goto('/closing');
  // expected: 1,13,000 + 2,750 (expense corrected 4,250→1,500) − 5,000 staff advance + 40,000 WAW − 5,000 repaid = 1,45,750
  await expect(page.getByTestId('expected-cash')).toHaveText('1,45,750');
  await countNotes(page, 146690);
  await attachPhoto(page);
  await page.getByTestId('submit-closing').click();
  await toastSeen(page, /Closing submitted/);
  await page.getByTestId('approve-day').click();
  await toastSeen(page, 'Day approved and locked');
  await page.goto('/reports');
  await expect(page.locator('table')).toContainText('Ayan Khalid');
  await expect(page.locator('.content')).toContainText('Non-cash received from customers');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export PDF/ }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/ProAid-.*\.pdf/);
});

test('owner creates a new cashier login and the new user can sign in', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/settings');
  // a helper without a login gets an account
  await page.getByTestId('add-staff').click();
  await page.getByTestId('staff-name').fill('Salman Helper');
  await page.getByTestId('staff-save').click();
  await toastSeen(page, 'Salman Helper added');
  await expect(page.locator('table').first()).toContainText('staff · no login');
  await page.goto('/staff');
  await expect(page.locator('.content')).toContainText('Salman Helper');
  // owner adds a new card machine; it shows up in the daily sale form straight away
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Accounts & wallets' }).click();
  await page.getByTestId('add-account').click();
  await page.getByTestId('account-name').fill('Meezan card machine');
  await page.getByRole('radio', { name: 'Card machine' }).click();
  await page.getByTestId('account-save').click();
  await toastSeen(page, 'Meezan card machine added');
  await expect(page.locator('.content')).toContainText('Meezan card machine');
  await page.goto('/sales/new?day=2020-01-01');
  await expect(page.locator('label:has-text("Meezan card machine")')).toBeVisible();
  // audit log and days accept any date range
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Audit log' }).click();
  await page.getByRole('radio', { name: 'Last year' }).click();
  await expect(page.locator('.content')).toContainText('Audit log · everything that happened · 0');
  await page.getByRole('radio', { name: 'This month' }).click();
  await expect(page.locator('.content')).not.toContainText('happened · 0');
  await page.goto('/settings');
  await page.getByRole('button', { name: '+ Add login' }).click();
  await page.locator('.sheet input').nth(0).fill('Kashif Mehmood');
  await page.locator('.sheet input').nth(1).fill('03004567890');
  await page.locator('.sheet input').nth(2).fill('445566');
  await page.locator('.sheet button:has-text("Create login")').click();
  await toastSeen(page, 'can now sign in');
  await expect(page.locator('table').first()).toContainText('Kashif Mehmood');
  await signOut(page);
  await page.fill('input[inputmode="tel"]', '03004567890');
  await page.fill('input[type="password"]', '445566');
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/$/);
  await expect(page.locator('.sidebar')).toContainText('Cashier · Kashif');
  // Kashif changes his own PIN (current PIN required)
  await page.goto('/pin');
  await page.getByTestId('pin-current').fill('000000');
  await page.getByTestId('pin-new').fill('556677');
  await page.getByTestId('pin-again').fill('556677');
  await page.getByTestId('pin-save').click();
  await toastSeen(page, 'Current PIN is wrong');
  await page.getByTestId('pin-current').fill('445566');
  await page.getByTestId('pin-save').click();
  await toastSeen(page, 'PIN changed');
  // owner resets it again from Settings; the old one stops working
  await signOut(page);
  await signIn(page, 'owner');
  await page.goto('/settings');
  await page.getByTestId('reset-pin-03004567890').click();
  await page.getByTestId('new-pin').fill('998877');
  await page.getByTestId('new-pin-save').click();
  await toastSeen(page, 'PIN reset');
  await signOut(page);
  await page.fill('input[inputmode="tel"]', '03004567890');
  await page.fill('input[type="password"]', '556677');
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.notice.danger')).toContainText('Phone number or PIN is wrong');
  await page.fill('input[type="password"]', '998877');
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/$/);
  await expect(page.locator('.sidebar')).toContainText('Cashier · Kashif');
});

test('count-first: manager counts the drawer and the app works the sale out, closing is prefilled', async ({ page }) => {
  await signOut(page);
  await signIn(page, 'manager');
  const d = new Date(); d.setDate(d.getDate() - 3); const day = d.toISOString().slice(0, 10);
  await page.goto(`/sales/new?day=${day}`);
  await page.getByRole('radio', { name: /Count the drawer/ }).click();
  await countNotes(page, 30000);
  await attachPhoto(page, 0);
  await expect(page.getByTestId('cash-from-count')).toHaveText('30,000');
  const input = page.locator('label:has-text("HBL card machine") + .amount-wrap input');
  await input.fill('2000');
  await attachPhoto(page, 1);
  await expect(page.locator('.notice.ok')).toContainText('32,000');
  await page.getByTestId('save-sale').click();
  await toastSeen(page, 'Daily sale saved');
  await expect(page).toHaveURL(/\/closing/);
  await expect(page.locator('.content')).toContainText('worked out from the drawer count');
  await expect(page.getByTestId('expected-cash')).toHaveText('30,000');
  await expect(page.locator('#note-5000')).toHaveValue('6');
  await expect(page.locator('.content')).toContainText('from the count done at the sale');
  await attachPhoto(page, 0);
  await page.getByTestId('submit-closing').click();
  await toastSeen(page, 'Closing submitted');
  await expect(page.getByTestId('difference')).toContainText('0');
});
