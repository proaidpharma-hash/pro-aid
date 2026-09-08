// Downloads every proof photo of one month from Supabase Storage into a folder (used by the monthly backup workflow).
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node tools/photo-backup.mjs 2026-09 ./out
import fs from 'node:fs';
import path from 'node:path';

const [, , month, outDir] = process.argv;
const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || !/^\d{4}-\d{2}$/.test(month || '') || !outDir) { console.error('usage: SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY node photo-backup.mjs YYYY-MM outDir'); process.exit(2); }
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const [y, m] = month.split('-');
const prefix = `${y}/${m}`;

async function list(pfx) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${url}/storage/v1/object/list/proofs`, { method: 'POST', headers, body: JSON.stringify({ prefix: pfx, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) });
    if (!r.ok) throw new Error(`list ${pfx}: ${r.status} ${await r.text()}`);
    const items = await r.json();
    for (const it of items) {
      if (it.id === null) out.push(...await list(`${pfx}/${it.name}`));   // a folder
      else out.push(`${pfx}/${it.name}`);
    }
    if (items.length < 1000) break;
  }
  return out;
}

const files = await list(prefix);
let bytes = 0;
for (const f of files) {
  const r = await fetch(`${url}/storage/v1/object/proofs/${f}`, { headers });
  if (!r.ok) throw new Error(`download ${f}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dest = path.join(outDir, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  bytes += buf.length;
}
console.log(JSON.stringify({ month, files: files.length, bytes }));
