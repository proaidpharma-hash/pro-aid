// Rebuild the local development database with the real migrations plus dev users.
// Usage: node tools/reset-dev-db.mjs [dbname]   (default proaid_dev)
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = process.argv[2] || 'proaid_dev';
const P = 'psql -h /tmp -p 5433 -U postgres';
execSync(`${P} -q -c "drop database if exists ${db}" -c "create database ${db}"`, { stdio: 'inherit' });
execSync(`${P} -d ${db} -v ON_ERROR_STOP=1 -q -f ${root}/supabase/tests/00_auth_stub.sql -f ${root}/supabase/migrations/0001_schema.sql -f ${root}/supabase/migrations/0002_api.sql -f ${root}/supabase/migrations/0004_bootstrap.sql`, { stdio: 'inherit' });

const pool = new pg.Pool({ host: '/tmp', port: 5433, user: 'postgres', database: db });
await pool.query(`create table if not exists auth.local_creds (user_id uuid primary key references auth.users(id) on delete cascade, email text unique, pass_hash text)`);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const emailFor = (phone) => `${phone.replace(/\D/g, '')}@proaid.app`;

// PIN → password exactly as the app does it (see app/src/lib/auth.ts)
const pinToPassword = (pin) => `proaid-${pin}`;

export const DEV_USERS = [
  { id: '10000000-0000-0000-0000-000000000001', name: 'Ayan Khalid', role: 'owner', phone: '03001234567', pin: '112233' },
  { id: '10000000-0000-0000-0000-000000000002', name: 'Bilal Hussain', role: 'manager', phone: '03002345678', pin: '223344' },
  { id: '10000000-0000-0000-0000-000000000003', name: 'Ahmed Raza', role: 'cashier', phone: '03003456789', pin: '334455' },
];
for (const u of DEV_USERS) {
  await pool.query('insert into auth.users(id, email, phone) values ($1,$2,$3)', [u.id, emailFor(u.phone), u.phone]);
  await pool.query('insert into auth.local_creds(user_id, email, pass_hash) values ($1,$2,$3)', [u.id, emailFor(u.phone), hash(pinToPassword(u.pin))]);
  await pool.query('insert into profiles(id, name, role, phone) values ($1,$2,$3,$4)', [u.id, u.name, u.role, u.phone]);
}
await pool.query(`insert into distributors(name, rep_name, phone, delivery_days) values
  ('Getz Pharma (Sahil Traders)', 'Kamran', '0300-1234567', 'Mon / Thu'),
  ('Muller & Phipps', 'Asif', '0301-2233445', 'Daily'),
  ('United Distributors', 'Rehan', '0302-3344556', 'Tue / Fri'),
  ('Premier Distributors', 'Saad', '0303-4455667', 'Wed'),
  ('IBL Healthcare', 'Junaid', '0304-5566778', 'Mon'),
  ('Sami Pharma', 'Omer', '0305-6677889', 'Thu'),
  ('Abbott (Ali Medicos)', 'Ali', '0306-7788990', 'Sat')`);
await pool.query(`insert into customers(name, phone) values ('Rashid Ali', '0301-2223344'), ('Dr. Saleem''s clinic', '0321-9988776'), ('Imran Butt', '0333-1122334')`);
await pool.query(`insert into business_days(day, opening_cash) values (current_date, 52800) on conflict do nothing`);
await pool.end();
console.log(`dev database "${db}" ready. Sign in with phone 03001234567 / PIN 112233 (owner), 03002345678 / 223344 (manager), 03003456789 / 334455 (cashier)`);
