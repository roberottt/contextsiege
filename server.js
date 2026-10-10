// Local server for CONTEXT SIEGE.
// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl), adds up the tokens consumed
// since you started playing, detects open `claude` processes and serves the game.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UPGRADES, upgradeCost } from './public/upgrades.js';
import { SHIPS, DEFAULT_SHIP } from './public/ships.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SAVE_FILE = path.join(ROOT, 'save.json');
const LEDGER_FILE = path.join(ROOT, 'tokens.json');
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const PORT = Number(process.env.PORT) || 4321;

const STARTER_TK = 20000;
// Weight of each token type when converting it into TK, the in-game currency.
// Cache is weighted down so a long conversation doesn't blow up the economy.
const WEIGHTS = { input: 1, output: 1, cacheWrite: 0.25, cacheRead: 0.02 };
const GENERATING_WINDOW = 90_000;
const RATE_WINDOW = 5 * 60_000;
const SESSION_WINDOW = 15 * 60_000;
// How long already-counted message.ids are remembered (so copies across files aren't counted twice).
const SEEN_TTL = 45 * 24 * 3600_000;
// Diminishing returns: within each 10-minute window the first INCOME_CAP TK count in full, and anything above
// grows with the square root. A single session rarely gets there; many sessions running in parallel do.
const INCOME_WINDOW = 10 * 60_000;
const INCOME_CAP = 100_000;
const BUCKET_TTL = 3 * 24 * 3600_000;
const effectiveIncome = (x) => (x <= INCOME_CAP ? x : INCOME_CAP * Math.sqrt(x / INCOME_CAP));

// ---------- Saved game ----------

function defaults() {
  return { createdAt: Date.now(), spent: 0, levels: {}, wave: 1, bestWave: 1, kills: 0, ships: [DEFAULT_SHIP], ship: DEFAULT_SHIP };
}

function writeJson(file, data, pretty = true) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0));
  fs.renameSync(tmp, file);
}

function writeSave(s) {
  writeJson(SAVE_FILE, s);
}

function loadSave() {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`save.json is invalid, refusing to overwrite it: ${err.message}`);
    const s = defaults();
    writeSave(s);
    return s;
  }
}

const save = loadSave();

// ---------- Earned tokens ledger (tokens.json) ----------
// Stores earned TK together with how far each transcript has been read and which messages were already counted,
// all in a single file so the total and the read positions can never get out of sync.
// That way TK aren't lost even if Claude Code deletes old conversations.

function loadLedger() {
  let l;
  try {
    l = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`tokens.json is invalid, refusing to overwrite it: ${err.message}`);
    return null;
  }
  // A ledger from another game (save.json deleted or replaced) is not valid.
  return l.createdAt === save.createdAt ? l : null;
}

const ledger = loadLedger();
const files = new Map();     // path -> { offset, rest }
const seen = new Map();      // message.id -> timestamp (Claude Code repeats the same response across several lines)
const sessions = new Map();  // sessionId -> { project, total, lastTs, model }
const buckets = new Map();   // 10-minute window index -> raw TK produced in it (before diminishing returns)
const events = [];
const raw = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, ...ledger?.raw };
let recent = [];
let earned = ledger?.earned || 0;
let dirty = !ledger;
for (const [file, offset] of Object.entries(ledger?.files || {})) files.set(file, { offset, rest: Buffer.alloc(0) });
for (const [id, ts] of Object.entries(ledger?.seen || {})) seen.set(id, ts);
for (const [w, tk] of Object.entries(ledger?.buckets || {})) buckets.set(Number(w), tk);

function writeLedger() {
  const cutoff = Date.now() - SEEN_TTL;
  for (const [id, ts] of seen) if (ts < cutoff) seen.delete(id);
  const oldest = Math.floor((Date.now() - BUCKET_TTL) / INCOME_WINDOW);
  for (const w of buckets.keys()) if (w < oldest) buckets.delete(w);
  const offsets = {};
  // Only complete lines are saved: any partial line is re-read next time.
  for (const [file, rec] of files) offsets[file] = rec.offset - rec.rest.length;
  writeJson(LEDGER_FILE, {
    createdAt: save.createdAt,
    earned,
    raw,
    files: offsets,
    seen: Object.fromEntries(seen),
    buckets: Object.fromEntries(buckets),
  }, false);
  dirty = false;
}
let seq = 0;
let ready = false;

async function listJsonl(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function ingest(line, file) {
  if (!line.includes('"usage"')) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const msg = d.message;
  const u = msg?.usage;
  if (d.type !== 'assistant' || !u) return;
  const key = msg.id || d.uuid;
  if (!key || seen.has(key)) return;

  const ts = Date.parse(d.timestamp) || Date.now();
  if (ts < save.createdAt) return;
  seen.set(key, ts);
  dirty = true;

  const parts = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
  let tk = 0;
  for (const k in parts) {
    raw[k] += parts[k];
    tk += parts[k] * WEIGHTS[k];
  }
  const w = Math.floor(ts / INCOME_WINDOW);
  const before = buckets.get(w) || 0;
  buckets.set(w, before + tk);
  const gained = effectiveIncome(before + tk) - effectiveIncome(before);
  earned += gained;

  const id = d.sessionId || path.basename(file, '.jsonl');
  const project = d.cwd ? path.basename(d.cwd) : path.basename(path.dirname(file));
  const s = sessions.get(id) || { project, total: 0, lastTs: 0, model: '' };
  s.project = project;
  s.total += gained;
  s.lastTs = Math.max(s.lastTs, ts);
  s.model = msg.model || s.model;
  sessions.set(id, s);

  recent.push({ ts, tk: gained });
  if (ready) {
    events.push({ seq: ++seq, tk: Math.round(gained), project, ts });
    if (events.length > 200) events.shift();
  }
}

async function readNew(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return; }
  let rec = files.get(file);
  if (!rec) {
    rec = { offset: 0, rest: Buffer.alloc(0) };
    files.set(file, rec);
    // A file untouched since the game started can't contain new tokens.
    if (st.mtimeMs < save.createdAt) { rec.offset = st.size; return; }
  }
  if (st.size < rec.offset) { rec.offset = 0; rec.rest = Buffer.alloc(0); dirty = true; }
  if (st.size === rec.offset) return;

  const fh = await fsp.open(file, 'r');
  try {
    const len = st.size - rec.offset;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, rec.offset);
    rec.offset += bytesRead;
    dirty = true;
    const data = Buffer.concat([rec.rest, buf.subarray(0, bytesRead)]);
    const nl = data.lastIndexOf(10);
    if (nl === -1) { rec.rest = data; return; }
    rec.rest = data.subarray(nl + 1);
    for (const line of data.subarray(0, nl).toString('utf8').split('\n')) ingest(line, file);
  } finally {
    await fh.close();
  }
}

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const list = await listJsonl(PROJECTS_DIR);
    for (const f of list) await readNew(f);
    // Transcripts Claude Code has deleted: their TK stay counted, only their position is forgotten.
    const present = new Set(list);
    for (const f of files.keys()) if (!present.has(f)) { files.delete(f); dirty = true; }
    if (dirty) writeLedger();
  } finally {
    scanning = false;
    ready = true;
  }
  const cutoff = Date.now() - RATE_WINDOW;
  recent = recent.filter((r) => r.ts >= cutoff);
}

// ---------- Open Claude processes ----------

let claudeProcs = [];
function checkProcs() {
  execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 << 20 }, (err, out) => {
    if (err) return;
    claudeProcs = out.split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, cmd]) => ({ pid: Number(pid), cmd }))
      .filter(({ cmd }) => {
        const exe = cmd.split(/\s+/)[0];
        const isClaude = /(^|\/)claude$/.test(exe) || cmd.includes('@anthropic-ai/claude-code/cli');
        return isClaude && !/native-host|mcp/.test(cmd);
      });
  });
}

// ---------- API ----------

function wallet() {
  return Math.floor(STARTER_TK + earned - save.spent);
}

function incomeStatus(now) {
  const windowTk = buckets.get(Math.floor(now / INCOME_WINDOW)) || 0;
  return {
    cap: INCOME_CAP,
    windowMinutes: INCOME_WINDOW / 60_000,
    windowTk: Math.round(windowTk),
    efficiency: windowTk ? effectiveIncome(windowTk) / windowTk : 1,
  };
}

function status(since = 0) {
  const now = Date.now();
  const all = [...sessions.values()];
  const lastTs = all.reduce((m, s) => Math.max(m, s.lastTs), 0);
  const rateTk = recent.reduce((a, r) => (now - r.ts < RATE_WINDOW ? a + r.tk : a), 0);
  return {
    ready,
    wallet: wallet(),
    earned: Math.floor(earned),
    starter: STARTER_TK,
    spent: save.spent,
    rate: Math.round(rateTk / (RATE_WINDOW / 60_000)),
    income: incomeStatus(now),
    generating: lastTs > 0 && now - lastTs < GENERATING_WINDOW,
    lastTokenAgo: lastTs ? now - lastTs : null,
    processes: claudeProcs.length,
    sessions: all
      .filter((s) => now - s.lastTs < SESSION_WINDOW)
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 5)
      .map((s) => ({ project: s.project, total: Math.round(s.total), ago: now - s.lastTs, model: s.model })),
    events: events.filter((e) => e.seq > since),
    seq,
    levels: save.levels,
    ship: save.ship,
    ships: save.ships,
    wave: save.wave,
    bestWave: save.bestWave,
    kills: save.kills,
    weights: WEIGHTS,
    raw,
    since: save.createdAt,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 10_000) break;
  }
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

const int = (v, min) => (Number.isFinite(v) ? Math.max(min, Math.floor(v)) : null);

// Only requests addressed to this server by a local name are accepted. This blocks DNS rebinding,
// where a web page points its own domain at 127.0.0.1 to read the API.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

// Writes must be JSON sent by the game itself. Other sites can't send a cross-origin JSON POST
// without a CORS preflight (which this server never approves), and a mismatched Origin is rejected.
function isTrustedWrite(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  const origin = req.headers.origin;
  return type === 'application/json' && (!origin || ALLOWED_ORIGINS.has(origin));
}

async function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && !isTrustedWrite(req)) return send(res, 403, { error: 'Forbidden' });

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return send(res, 200, status(Number(url.searchParams.get('since')) || 0));
  }

  if (url.pathname === '/api/buy' && req.method === 'POST') {
    const { id } = await readBody(req);
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return send(res, 404, { error: 'Unknown upgrade' });
    const lvl = save.levels[id] || 0;
    if (u.max != null && lvl >= u.max) return send(res, 400, { error: 'Max level reached' });
    const cost = upgradeCost(u, lvl);
    if (wallet() < cost) return send(res, 402, { error: 'Not enough tokens: put Claude to work' });
    save.spent += cost;
    save.levels[id] = lvl + 1;
    writeSave(save);
    return send(res, 200, status(Infinity));
  }

  if (url.pathname === '/api/ship' && req.method === 'POST') {
    const { id, action } = await readBody(req);
    const ship = SHIPS.find((x) => x.id === id);
    if (!ship) return send(res, 404, { error: 'Unknown ship' });
    const owned = save.ships.includes(id);
    if (action === 'buy') {
      if (owned) return send(res, 400, { error: 'You already own this ship' });
      if (wallet() < ship.price) return send(res, 402, { error: 'Not enough tokens: put Claude to work' });
      save.spent += ship.price;
      save.ships.push(id);
    } else if (action !== 'select') {
      return send(res, 400, { error: 'Invalid action' });
    } else if (!owned) {
      return send(res, 403, { error: "You don't own this ship yet" });
    }
    save.ship = id;
    writeSave(save);
    return send(res, 200, status(Infinity));
  }

  if (url.pathname === '/api/progress' && req.method === 'POST') {
    const b = await readBody(req);
    save.wave = int(b.wave, 1) ?? save.wave;
    save.bestWave = Math.max(save.bestWave, int(b.bestWave, 1) ?? 0);
    save.kills = Math.max(save.kills, int(b.kills, 0) ?? 0);
    writeSave(save);
    return send(res, 200, { ok: true });
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

  let rel;
  try {
    rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// A failure in one request must never bring the whole server down.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    else res.end();
  });
});

await scan();
checkProcs();
setInterval(scan, 2000);
setInterval(checkProcs, 5000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ◆ CONTEXT SIEGE  →  http://localhost:${PORT}\n`);
  console.log(`  Reading tokens from: ${PROJECTS_DIR}`);
  console.log(`  Game started:       ${new Date(save.createdAt).toLocaleString('en-US')}`);
  console.log(`  TK available:       ${wallet().toLocaleString('en-US')}\n`);
});
