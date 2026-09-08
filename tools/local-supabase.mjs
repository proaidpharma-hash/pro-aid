// Local stand-in for the parts of Supabase the Pro Aid app uses (auth, PostgREST-style REST, RPC, storage).
// Purpose: run the real database rules under the real app during development and automated tests,
// in an environment that cannot reach supabase.com. Never used in production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const PORT = Number(process.env.PORT || 54321);
const SECRET = 'local-dev-secret';
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), '.storage');
// dates come back as plain 'YYYY-MM-DD' strings, exactly like PostgREST
pg.types.setTypeParser(1082, (v) => v);
const pool = new pg.Pool({ host: '/tmp', port: 5433, user: 'postgres', database: process.env.PGDATABASE || 'proaid' });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// local credential store (Supabase keeps this inside auth.users)
await pool.query(`create table if not exists auth.local_creds (user_id uuid primary key references auth.users(id) on delete cascade, email text unique, pass_hash text)`);

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extra });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const session = (user) => {
  const access_token = jwt.sign({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated' }, SECRET, { expiresIn: '12h' });
  return { access_token, token_type: 'bearer', expires_in: 43200, expires_at: Math.floor(Date.now() / 1000) + 43200, refresh_token: 'r-' + user.id, user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
};
const userFromReq = (req) => {
  const h = req.headers.authorization || '';
  const t = h.replace(/^Bearer\s+/i, '');
  if (!t || t === ANON_KEY) return null;
  try { return jwt.verify(t, SECRET); } catch { return null; }
};
const ANON_KEY = 'local-anon-key';

// ---- auth --------------------------------------------------------------------
async function handleAuth(req, res, url) {
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
  if (url.pathname === '/auth/v1/signup') {
    const { email, password } = body;
    const id = crypto.randomUUID();
    await pool.query('insert into auth.users(id, email) values ($1,$2)', [id, email]);
    await pool.query('insert into auth.local_creds(user_id, email, pass_hash) values ($1,$2,$3)', [id, email, hash(password)]);
    return json(res, 200, session({ id, email }));
  }
  if (url.pathname === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const r = await pool.query('select user_id, email from auth.local_creds where email=$1 and pass_hash=$2', [body.email, hash(body.password)]);
      if (!r.rowCount) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 400, msg: 'Invalid login credentials' });
      return json(res, 200, session({ id: r.rows[0].user_id, email: r.rows[0].email }));
    }
    if (grant === 'refresh_token') {
      const id = String(body.refresh_token || '').replace(/^r-/, '');
      const r = await pool.query('select id, email from auth.users where id=$1', [id]);
      if (!r.rowCount) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, session(r.rows[0]));
    }
  }
  if (url.pathname === '/auth/v1/user') {
    const u = userFromReq(req);
    if (!u) return json(res, 401, { message: 'not signed in' });
    if (req.method === 'PUT') {
      if (body.password) await pool.query('update auth.local_creds set pass_hash=$2 where user_id=$1', [u.sub, hash(body.password)]);
      return json(res, 200, session({ id: u.sub, email: u.email }).user);
    }
    return json(res, 200, session({ id: u.sub, email: u.email }).user);
  }
  if (url.pathname === '/auth/v1/logout') return json(res, 204);
  // owner-side admin: reset a PIN (Supabase does this with the service key from an edge function)
  if (url.pathname === '/auth/v1/admin/users' && req.method === 'PUT') {
    await pool.query('update auth.local_creds set pass_hash=$2 where user_id=$1', [body.id, hash(body.password)]);
    return json(res, 200, {});
  }
  return json(res, 404, { message: 'auth route not found' });
}

// ---- REST (PostgREST subset) -----------------------------------------------
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
function buildWhere(params, args) {
  const clauses = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    const m = /^(\w+)\.(.+)$/.exec(v);
    if (!m) continue;
    let [, op, val] = m;
    let not = false;
    if (op === 'not') { not = true; const m2 = /^(\w+)\.(.+)$/.exec(val); op = m2[1]; val = m2[2]; }
    let clause;
    if (op === 'is') clause = `${q(k)} is ${val === 'null' ? 'null' : val}`;
    else if (op === 'in') { const items = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); args.push(items); clause = `${q(k)} = any($${args.length})`; }
    else if (OPS[op]) { args.push(val); clause = `${q(k)} ${OPS[op]} $${args.length}`; }
    else if (op === 'cs') { args.push(val); clause = `${q(k)} @> $${args.length}`; }
    else continue;
    clauses.push(not ? `not (${clause})` : clause);
  }
  return clauses.length ? ' where ' + clauses.join(' and ') : '';
}
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
function buildOrder(params) {
  const o = params.get('order');
  if (!o) return '';
  return ' order by ' + o.split(',').map((p) => { const [c, d, n] = p.split('.'); return `${q(c)} ${d === 'desc' ? 'desc' : 'asc'}${n === 'nullsfirst' ? ' nulls first' : n === 'nullslast' ? ' nulls last' : ''}`; }).join(', ');
}
function buildSelect(params) {
  const s = params.get('select');
  if (!s || s === '*') return '*';
  return s.split(',').map((c) => { const [name, alias] = c.includes(':') ? c.split(':').reverse() : [c, null]; return alias ? `${q(name)} as ${q(alias)}` : q(name.trim()); }).join(', ');
}

async function withTx(req, fn) {
  const u = userFromReq(req);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('role', $1, true)", [u ? 'authenticated' : 'anon']);
    await client.query('set local role ' + (u ? 'authenticated' : 'anon'));
    await client.query("select set_config('app.uid', $1, true)", [u ? u.sub : '']);
    const headers = {};
    for (const h of ['x-device', 'x-reason']) if (req.headers[h]) headers[h] = req.headers[h];
    await client.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    throw e;
  } finally { client.release(); }
}
const pgError = (res, e) => json(res, 400, { code: e.code || 'PGRST', message: e.message, details: e.detail || null, hint: e.hint || null });

async function handleRest(req, res, url) {
  const parts = url.pathname.replace('/rest/v1/', '').split('/');
  const params = url.searchParams;
  const wantSingle = (req.headers.accept || '').includes('vnd.pgrst.object');
  const prefer = req.headers.prefer || '';
  const finish = (rows) => {
    if (wantSingle) {
      if (rows.length !== 1) return json(res, 406, { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned`, details: `Results contain ${rows.length} rows` });
      return json(res, 200, rows[0]);
    }
    return json(res, 200, rows);
  };
  try {
    if (parts[0] === 'rpc') {
      const fn = parts[1];
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : Object.fromEntries(params);
      let setReturning = false;
      const rows = await withTx(req, async (c) => {
        const meta = await c.query(`select p.proretset, t.typname, t.typtype from pg_proc p join pg_type t on t.oid = p.prorettype where p.proname = $1 and p.pronamespace = 'public'::regnamespace limit 1`, [fn]);
        if (!meta.rowCount) throw Object.assign(new Error(`function ${fn} not found`), { code: 'PGRST202' });
        const keys = Object.keys(body);
        const args = keys.map((k, i) => `${q(k)} := $${i + 1}`).join(', ');
        const vals = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' && !Array.isArray(body[k]) ? JSON.stringify(body[k]) : body[k]));
        const { proretset, typname, typtype } = meta.rows[0];
        setReturning = proretset;
        if (proretset) return (await c.query(`select * from ${q(fn)}(${args})`, vals)).rows;
        if (typtype === 'c') return [ (await c.query(`select to_jsonb(${q(fn)}(${args})) as v`, vals)).rows[0].v ];
        if (typname === 'void') { await c.query(`select ${q(fn)}(${args})`, vals); return [null]; }
        return [ (await c.query(`select ${q(fn)}(${args}) as v`, vals)).rows[0].v ];
      });
      const meta2 = rows.length === 1 && !wantSingle && !setReturning ? rows[0] : rows;
      return json(res, 200, meta2 === null ? undefined : meta2);
    }
    const table = parts[0];
    if (req.method === 'GET' || req.method === 'HEAD') {
      const args = [];
      const sql = `select ${buildSelect(params)} from ${q(table)}${buildWhere(params, args)}${buildOrder(params)}${params.get('limit') ? ' limit ' + Number(params.get('limit')) : ''}${params.get('offset') ? ' offset ' + Number(params.get('offset')) : ''}`;
      const rows = await withTx(req, (c) => c.query(sql, args).then((r) => r.rows));
      return finish(rows);
    }
    if (req.method === 'POST') {
      let body = JSON.parse((await readBody(req)).toString() || '[]');
      const list = Array.isArray(body) ? body : [body];
      if (!list.length) return json(res, 201, []);
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
      const args = []; const rowsSql = [];
      for (const r of list) { rowsSql.push('(' + cols.map((c) => { args.push(r[c] === undefined ? null : (r[c] !== null && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])); return '$' + args.length; }).join(', ') + ')'); }
      const sql = `insert into ${q(table)} (${cols.map(q).join(', ')}) values ${rowsSql.join(', ')} returning ${buildSelect(params)}`;
      const rows = await withTx(req, (c) => c.query(sql, args).then((r) => r.rows));
      if (!prefer.includes('return=representation')) return json(res, 201, undefined);
      return wantSingle ? json(res, 201, rows[0]) : json(res, 201, rows);
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const args = [];
      const sets = Object.keys(body).map((k) => { args.push(body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]); return `${q(k)} = $${args.length}`; }).join(', ');
      const sql = `update ${q(table)} set ${sets}${buildWhere(params, args)} returning ${buildSelect(params)}`;
      const rows = await withTx(req, (c) => c.query(sql, args).then((r) => r.rows));
      if (!prefer.includes('return=representation')) return json(res, 204, undefined);
      return finish(rows);
    }
    if (req.method === 'DELETE') {
      const args = [];
      const sql = `delete from ${q(table)}${buildWhere(params, args)} returning ${buildSelect(params)}`;
      const rows = await withTx(req, (c) => c.query(sql, args).then((r) => r.rows));
      if (!prefer.includes('return=representation')) return json(res, 204, undefined);
      return finish(rows);
    }
    return json(res, 405, { message: 'method not allowed' });
  } catch (e) { return pgError(res, e); }
}

// ---- storage ----------------------------------------------------------------
async function handleStorage(req, res, url) {
  const u = userFromReq(req);
  const p = url.pathname.replace('/storage/v1/object/', '');
  if (req.method === 'POST' && p.startsWith('sign/')) {
    const key = p.replace('sign/', '');
    return json(res, 200, { signedURL: `/object/sign/${key}?token=local`, signedUrl: `/object/sign/${key}?token=local` });
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!u) return json(res, 401, { message: 'not signed in' });
    const buf = await readBody(req);
    let data = buf;
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) {
      const boundary = '--' + ct.split('boundary=')[1];
      const s = buf.toString('binary');
      const start = s.indexOf('\r\n\r\n', s.indexOf('filename=')) + 4;
      const end = s.lastIndexOf(boundary) - 2;
      data = Buffer.from(s.slice(start, end), 'binary');
    }
    const file = path.join(STORAGE_DIR, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return json(res, 200, { Key: p, Id: crypto.randomUUID() });
  }
  if (req.method === 'GET') {
    const key = p.replace(/^(authenticated|sign|public)\//, '');
    const file = path.join(STORAGE_DIR, key);
    if (!fs.existsSync(file)) return json(res, 404, { message: 'not found' });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' });
    return res.end(fs.readFileSync(file));
  }
  return json(res, 404, { message: 'storage route not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': '*' });
    return res.end();
  }
  try {
    if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url);
    if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url);
    if (url.pathname.startsWith('/storage/v1/')) return await handleStorage(req, res, url);
    if (url.pathname.startsWith('/realtime/')) return json(res, 404, { message: 'realtime not available locally' });
    return json(res, 404, { message: 'not found' });
  } catch (e) { return json(res, 500, { message: e.message }); }
}).listen(PORT, () => console.log(`local supabase stand-in on http://localhost:${PORT} (db ${process.env.PGDATABASE || 'proaid'})`));
