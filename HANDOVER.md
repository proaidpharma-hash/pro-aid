# Pro Aid — Handover / Project Brief

> **For the owner (Roman Urdu):** Ye file kisi bhi AI (Claude, ChatGPT, Gemini, Copilot) ya developer ko dein — is mein wo sab kuch hai jo app samajhne aur us mein change karne ke liye chahiye. Saath mein repo ka link dein: `https://github.com/proaidpharma-hash/pro-aid`. Secrets (passwords, keys, tokens) is file mein NAHI hain aur kabhi kisi ko chat mein na dein.

> **For an AI assistant or developer reading this:** this document is the complete map of the project. Read it fully before changing anything. The rules in *Section 9 (Non-negotiables)* override any convenience shortcut.

---

## 1. What the app is

**Pro Aid** is a cash-control and bookkeeping web app for a retail pharmacy in Pakistan, owned by Ayan Khalid. Its purpose is to make skimming, double payments and "lost" cash impossible to hide: every rupee that enters or leaves the drawer is recorded with a photo proof, the drawer is counted note-by-note every night, and the owner gets alerts and a daily digest.

The owner also runs a fuel station, **WAW F/S**, which sometimes lends cash to the pharmacy to pay distributors; the app tracks those loans.

Users are the owner (Ayan), a manager, cashiers, staff members (no login, only ledgers), and read-only viewers. Everyone uses it on a phone (installable PWA) or laptop. Language of the UI is English; the owner communicates in Roman Urdu / English (never Devanagari).

Live app: `https://proaidpharma-hash.github.io/pro-aid/`
Backend: Supabase project `zpgvbyzljpwnnqxwmbaa` (Postgres + Auth + Storage)
Repo: `https://github.com/proaidpharma-hash/pro-aid` (public; branch `main` is live)

---

## 2. Business rules (the domain)

| Concept | Rule |
|---|---|
| Business day | Starts at **04:00 Asia/Karachi**. Anything before 4 am belongs to the previous day (`businessDay()` in `app/src/lib/format.ts`, `today()` everywhere in the app). |
| Daily sale | Entered once per day by cashier/manager. Modes: enter sale total, or **count-first** (count the drawer, sale is derived). Sale = cash + card/online receipts + customer credit bills + staff credit. |
| Receipts through the day | Card / wallet / bank receipts and customer credit bills are entered as they happen (Today page); the night sale form is prefilled from them. |
| Closing | Every night: note-by-note drawer count (5000 … 1 coin), drawer photo, expected vs counted, difference flagged. Blocked until every purchase invoice of the day passes the **posting check**. |
| Posting check | Each supplier invoice must be marked "Posted in POS (amount)" or given a same-day reason. Posted short → a distributor *difference* that is settled later (goods / credit note / refund / adjusted against a later payment). |
| Payments to distributors | One invoice may be paid from several sources in one go: today's drawer cash, yesterday's cash, card machine, wallet, bank, **owner's personal account** (settled later), **WAW F/S loan** (auto-booked as a loan), or **adjustment** against a difference the distributor owes. Each line has amount, optional note, and a photo proof (except adjustments). Remainder stays pending with a due date and daily reminder. |
| Expenses | By category, with photo, against optional monthly budgets (warn / block). |
| Staff | Advances, medicine on credit, salary deductions, repayments — per staff member, with balances. |
| Customer credit | Bills and collections per customer, balances. |
| Owner controls | Spot (surprise) counts, card-machine reconciliation vs bank settlements, anomaly alerts, staff scorecard, expense budgets, daily digest (in-app + Telegram), month-end statement PDF, day-sheet PDF, audit log over any range, approve/edit/delete days (audited). |
| Photos | Every proof photo is stamped, hashed (SHA-256, duplicates rejected), quality-checked (dark/blurred warning), stored in Supabase Storage bucket `proofs` under `yyyy/mm/<user id>/`. Never updated or deleted. |

---

## 3. Architecture

```
phone / laptop (PWA)
   │  HTTPS, anon key + user JWT
   ▼
Supabase  ── Auth (email/password, derived from phone + PIN)
          ── Postgres (ALL business rules live here: RLS + RPC functions + triggers)
          ── Storage bucket "proofs"
          ── pg_cron (daily jobs) + pg_net (Telegram)
   ▲
GitHub Actions ── tests → migrations → GitHub Pages deploy
              ── nightly encrypted DB backup, monthly photo backup
```

**Key principle:** the browser is untrusted. The app never enforces a rule by itself — it only calls RPC functions; the database refuses anything wrong with a `PA0xx` error code, and the app shows a friendly message (`friendlyError` in `app/src/lib/api.ts`).

### 3.1 Frontend (`app/`)
- Vite 8 + React 19 + TypeScript, `vite-plugin-pwa` (auto-update; `main.tsx` reloads when a new service worker takes control and checks for updates every 15 min).
- State: `zustand` (`src/lib/store.ts`). Routing: `react-router-dom`. PDFs: `jspdf` + `jspdf-autotable`. Font: self-hosted Manrope.
- `src/lib/supabase.ts` — client; `src/lib/api.ts` — every RPC/table call, typed; `src/lib/auth.ts` — login/PIN scheme; `src/lib/photos.ts` — stamp, hash, quality check, upload; `src/lib/realtime.ts` — notifications + device alerts; `src/lib/pdf.ts` / `daypdf.ts` — PDFs; `src/lib/format.ts` — money/date helpers and the 4 am business day.
- Pages (`src/pages/`): `Login`, `Today` (home, receipts/credit entry), `Sale`, `Purchases` (invoices, payments, expenses), `Closing`, `Ledgers` (distributors, customers, staff, WAW, owner), `Owner` (Settings, Insights, Reports, PIN), `Control` (owner control pack).
- Components (`src/components/`): `Shell` (nav, idle lock, viewer banner), `ui` (Card, Field, AmountInput, Chips, PhotoPicker, DenominationCount…), `PaymentLines` (multi-source payment editor), `Posting` (posting check sheets), `EditSheet`.
- Content-Security-Policy is injected at build (`vite.config.ts`): scripts only from self; connections only to self, the Supabase URL, and `https://api.telegram.org`.
- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (`.env.production` = real project; `.env.development` = local stand-in). `VITE_BASE=/pro-aid/` is set by CI for GitHub Pages.

### 3.2 Database (`supabase/migrations/`)
Numbered, **append-only** migrations. Never edit a file that has already been applied; add `0012_....sql`. CI applies each file once and records it in `public._migrations`.

| File | Contents |
|---|---|
| 0001_schema | enums, tables, RLS, audit trigger, helpers (`my_role()`, `is_owner()`, `current_device()`) |
| 0002_api | RPCs: profiles, days, sale, purchases, payments, expenses, staff, closing, summaries |
| 0003_jobs | pg_cron schedule (production only, not run in tests) |
| 0004_bootstrap | first-time setup, seeds |
| 0005_staff_and_sale_credit | staff role without login, credit in sale, count-first |
| 0006_day_receipts | `sale_receipts` through the day |
| 0007_denominations | note-by-note counts |
| 0008_posting_check | posting check, distributor differences |
| 0009_security | execute grants, `is_api_request()`, `*_impl` wrappers, invoker views, storage folder rule, `reset_login_pin` |
| 0010_multi_source_payments | payment notes, adjustment account, WAW auto-loan, due dates |
| 0011_control_pack | viewer role, device alerts, duplicate-photo guard, budgets, spot counts, reconciliation, scorecard, settings, Telegram, digest, anomaly checks |

Conventions:
- Public entry points are `security definer` functions; internal ones are `*_impl` (execute revoked from API roles). Entry points call `set_config('app.internal','1',true)` before internal work; `is_api_request()` tells whether the call came through PostgREST.
- Errors: `raise exception '<message>' using errcode = 'PA0xx'` (see table in Section 6). The message text is what the user sees.
- Enum values added with `alter type … add value` must be referenced via `::text` casts in the same migration.
- Views use `security_invoker = true`. Drop and recreate a view when its columns change.
- Every table has RLS; the audit trigger writes `audit_log` on all edits.
- `notify_users(...)` creates notifications; owner-alert kinds are also sent to Telegram (`send_telegram`, pg_net; no-op locally).
- Daily jobs: `run_daily_jobs()` (reminders, anomaly checks, yesterday's digest) — scheduled by pg_cron in production.

### 3.3 Auth
- Login = phone number + 6-digit PIN. Email is `<digits>@proaid.app`; password = `'v2.' + sha256('proaid:v2:' + phone + ':' + pin)`; old accounts on the legacy scheme `proaid-<pin>` are upgraded transparently on first login.
- 5 wrong PINs → 60 s lockout (client), 15 min idle → lock screen, owner can reset any PIN (`reset_login_pin`, audited), users change their own PIN (`/pin`).
- Roles: `owner`, `manager`, `cashier`, `staff` (no login), `viewer` (read-only). `my_role()` returns null for staff/viewer; `can_read()` for reads; in the app `useCanWrite()` hides write buttons and `Guard` protects routes.
- New sign-ups should be OFF in Supabase Auth settings (users are created by the owner inside the app).

### 3.4 CI/CD (`.github/workflows/`)
- `deploy.yml` on push to `main`: **test-db** (182 SQL assertions) → **build** (tsc, vitest, Playwright e2e desktop + phone against the real rules) → **migrate** (applies new migrations to Supabase with `SUPABASE_DB_URL`) → **deploy** to GitHub Pages. If any step fails nothing goes live.
- `backup.yml` nightly: `pg_dump` (client 17), AES-256 encrypted with `BACKUP_PASSPHRASE`, stored as a workflow artifact. Restore instructions: `supabase/BACKUP.md`.
- `photo-backup.yml` monthly: `tools/photo-backup.mjs` downloads the `proofs` bucket, encrypted the same way.
- Repo secrets (names only — values are held by the owner): `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BACKUP_PASSPHRASE`. The service-role key exists **only** as a GitHub secret.

---

## 4. Running it locally

Requirements: Node 22, Postgres 16 (any local instance), Chromium for Playwright.

```bash
git clone https://github.com/proaidpharma-hash/pro-aid && cd pro-aid
cd tools && npm install && cd ../app && npm install
```

The tools expect Postgres at socket `/tmp`, port `5433`, user `postgres` with no password (see the `pg.Pool` line in `tools/local-supabase.mjs`, `tools/reset-dev-db.mjs`, and `P=` in `supabase/run_tests.sh`). Change those three places if your Postgres differs (CI does exactly that with `sed`).

```bash
# 1. database rule tests
cd supabase && bash run_tests.sh            # expect "ALL RULE TESTS PASSED"

# 2. dev database + local Supabase stand-in (auth, REST, RPC, storage — no internet needed)
node tools/reset-dev-db.mjs                 # creates proaid_dev with dev users
node tools/local-supabase.mjs               # http://localhost:54321

# 3. the app
cd app && npm run dev                       # http://localhost:5173, uses .env.development

# 4. end-to-end tests (each project resets the database itself)
npx playwright test --project=desktop
npx playwright test --project=phone
```

Dev users (local only): owner `03001234567` / PIN `112233`, manager `03002345678` / `223344`, cashier `03003456789` / `334455`.

---

## 5. How to make a change (checklist)

1. **Decide where the rule lives.** Anything that must be enforced (who may do what, arithmetic, blocking conditions) goes in a new migration; the app only presents it.
2. **Database:** create `supabase/migrations/0012_<name>.sql`. Add it to the file lists in `supabase/run_tests.sh` and `tools/reset-dev-db.mjs`. Add tests to `supabase/tests/01_rules.sql` (pattern: `t_as('<user>')` then `select ok(...)` / expect a `PA0xx` error). Run `bash run_tests.sh`.
3. **API layer:** add the typed call in `app/src/lib/api.ts` (and the friendly message for any new error code).
4. **UI:** edit the page/component. Respect `useCanWrite()` for anything that writes; keep phone layout working (390 px wide — use `.row.wrap`, `grid-2.stack`).
5. **Tests:** extend `app/e2e/flows.spec.ts` (serial, uses `helpers.ts`: `signIn`, `attachPhoto`, `countNotes`…). Run desktop and phone projects.
6. **Type check:** `npx tsc -p tsconfig.app.json --noEmit && npx vitest run`.
7. **Ship:** commit, push to `main`. Watch the *Actions* tab. Green = live within ~5 min; users' phones pick up the new version automatically.
8. Never hand over untested work — the owner's explicit requirement is "bug-free, tested end to end".

Small operational changes need **no code**: users, roles, PIN resets, accounts/wallets, distributors, budgets, Telegram alerts — all in *Settings* inside the app.

---

## 6. Error codes (`PA0xx`)

| Code | Meaning |
|---|---|
| PA001–PA023 | original rules (duplicate day, closed day, missing photo, wrong role…) — see `0002_api.sql` |
| PA030 | staff/credit entry guard |
| PA031/PA032 | receipt/credit guards on a closed day |
| PA033 | note count doesn't add up to the counted cash |
| PA034 | closing blocked: invoices not posted |
| PA040/PA041 | posting amount / difference kind invalid |
| PA042 | unposted reason missing |
| PA050 | PIN reset rules |
| PA060/PA061 | adjustment lines: which difference, same distributor, not more than pending |
| PA062 | due date invalid |
| PA070 | spot count rules (manager/owner only; not after the sale is recorded) |
| PA071 | bank settlement rules |
| PA072 | settings rules |
| 42501 | permission denied (role) |

---

## 7. Deployment route used so far

The owner's laptop is linked to Claude (Cowork). Changes were pushed like this: Claude commits in its workspace → creates a `git bundle` → the bundle is written to `Documents/ProAid/pro-aid.bundle` on the laptop → inside the laptop VM: `cd $HOME/pro-aid-push && git fetch -q "$HOME/mnt/Documents/ProAid/pro-aid.bundle" master && git reset -q --hard FETCH_HEAD && git push origin HEAD:main`. A GitHub token for that push lives only at `$HOME/proaid-auth/token` on the laptop. Any ordinary `git push` to `main` from any machine with access works just as well.

---

## 8. Owner's working preferences

- Reply in **Roman Urdu / English**. Never Devanagari.
- Ask before adding or changing a feature, unless he has said "add what you think is right".
- Explain settings step by step (he is not a developer). Test everything before handing over.
- Never ask him to paste secrets (Telegram bot token, chat id, keys, passphrase) in chat; give him the steps to enter them where they belong (app Settings, GitHub Secrets).

---

## 9. Non-negotiables

1. The **service-role key** is only ever a GitHub secret. Never in the app, never in chat, never in a file.
2. `BACKUP_PASSPHRASE` is known only to the owner. Without it backups cannot be restored — do not "help" by storing it anywhere.
3. Migrations are append-only. Never edit or delete an applied migration; never run `DROP TABLE` on production data.
4. Do not weaken RLS, the `*_impl` / `is_api_request()` guards, the storage folder rule, or the CSP to "make something work".
5. Photos are immutable; never add update/delete on the `proofs` bucket.
6. Pushing to `main` deploys. Nothing goes to `main` without green tests.
7. Keep the 4 am business-day rule consistent everywhere (`today()` in the app, `Asia/Karachi` in the database jobs).

---

## 10. Prompt to give another AI

> You are taking over the Pro Aid project. Read `HANDOVER.md` in the repo `https://github.com/proaidpharma-hash/pro-aid` first, then `SECURITY.md` and `supabase/BACKUP.md`. Business rules live in Postgres migrations (append-only, `PA0xx` error codes, `*_impl` wrappers); the React app in `app/` only calls RPCs. Before any change: propose it in Roman Urdu/English and wait for approval. Every change must pass `supabase/run_tests.sh`, `tsc`, `vitest`, and both Playwright projects (`desktop`, `phone`) before it is pushed to `main`, because `main` deploys automatically. Never request or store secrets.
