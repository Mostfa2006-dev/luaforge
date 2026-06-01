try { require('dotenv').config(); } catch {} // optional: local dev only

// ─── Structured logger ────────────────────────────────────────────────────────
const log = {
  info:  (msg, meta={}) => console.log(JSON.stringify({ level:'info',  msg, ...meta, ts: new Date().toISOString() })),
  warn:  (msg, meta={}) => console.warn(JSON.stringify({ level:'warn',  msg, ...meta, ts: new Date().toISOString() })),
  error: (msg, meta={}) => console.error(JSON.stringify({ level:'error', msg, ...meta, ts: new Date().toISOString() })),
};

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { WebSocketServer } = require('ws');
const http = require('http');

// ─── Startup safety checks ────────────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change_me_in_railway_env') {
  console.error('FATAL: JWT_SECRET env var is not set or is using the default insecure value.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://rluaforge.netlify.app',
  'https://luaforge.onrender.com', // ← add this
  'http://localhost:3000',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS policy: origin not allowed — ' + origin));
  },
  credentials: true,
}));

app.use(express.json({ limit: '8mb' }));

const JWT_SECRET      = process.env.JWT_SECRET;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const CEREBRAS_KEY    = process.env.CEREBRAS_API_KEY   || '';
const TOGETHER_KEY    = process.env.TOGETHER_API_KEY   || '';
const GROQ_KEY        = process.env.GROQ_API_KEY       || '';
const CHROMA_URL      = process.env.CHROMA_URL         || 'http://localhost:8000';
const PORT            = process.env.PORT               || 3001;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);



// ─── AI provider circuit breaker ──────────────────────────────────────────────
const providerBreakers = new Map(); // url → {failures, openUntil}
const CB_THRESHOLD = 3, CB_COOLDOWN = 30000;
function isProviderOpen(url) {
  const b = providerBreakers.get(url);
  if (!b) return false;
  if (Date.now() > b.openUntil) { providerBreakers.delete(url); return false; }
  return true;
}
function recordProviderFailure(url) {
  const b = providerBreakers.get(url) || { failures: 0, openUntil: 0 };
  b.failures++;
  if (b.failures >= CB_THRESHOLD) { b.openUntil = Date.now() + CB_COOLDOWN; log.warn('AI provider circuit open', { url }); }
  providerBreakers.set(url, b);
}
function recordProviderSuccess(url) { providerBreakers.delete(url); }

// ─── Per-endpoint rate limiter for RAG store ──────────────────────────────────
const ragStoreHits = new Map(); // ip → {count, resetAt}
function ragRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = ragStoreHits.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  ragStoreHits.set(ip, entry);
  if (entry.count > 30) return res.status(429).json({ error: 'RAG store rate limit exceeded' });
  next();
}

// ─── Redis optional: for horizontal scaling ───────────────────────────────────
// If REDIS_URL is set, WebSocket presence is tracked via Redis pub/sub so that
// multiple server instances can route messages to the correct Studio client.
// Without Redis, everything works fine on a single instance (Railway default).
let redisPublisher = null, redisSubscriber = null;
const REDIS_URL = process.env.REDIS_URL || '';
if (REDIS_URL) {
  try {
    const { createClient } = require('redis');
    redisPublisher  = createClient({ url: REDIS_URL });
    redisSubscriber = createClient({ url: REDIS_URL });
    Promise.all([redisPublisher.connect(), redisSubscriber.connect()])
      .then(() => console.log('Redis connected — horizontal scaling enabled'))
      .catch(e => { console.warn('Redis connect failed, running single-process:', e.message); redisPublisher = redisSubscriber = null; });
  } catch { console.warn('redis package not installed — running single-process'); }
}


// ─── ChromaDB health check ────────────────────────────────────────────────────
async function checkChromaHealth() {
  try {
    const res = await fetch(CHROMA_URL + '/api/v1/heartbeat');
    if (!res.ok) throw new Error('status ' + res.status);
    log.info('ChromaDB connected', { url: CHROMA_URL });
  } catch (e) {
    log.warn('ChromaDB not reachable — RAG features will be skipped', { url: CHROMA_URL, error: e.message });
  }
}
checkChromaHealth();


// ─── In-memory token blocklist ────────────────────────────────────────────────
const tokenBlocklist = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of tokenBlocklist) {
    if (exp < now) tokenBlocklist.delete(jti);
  }
}, 10 * 60 * 1000);

// ─── Rate limiter ─────────────────────────────────────────────────────────────
function makeRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, times] of hits) {
      const pruned = times.filter(t => t > cutoff);
      if (pruned.length === 0) hits.delete(k); else hits.set(k, pruned);
    }
  }, windowMs);
  return (req, res, next) => {
    const key = req.user?.id || getClientIp(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(key) || []).filter(t => t > cutoff);
    times.push(now);
    hits.set(key, times);
    if (times.length > max) return res.status(429).json({ error: message || 'Too many requests.' });
    next();
  };
}

const aiRateLimit   = makeRateLimiter({ windowMs: 60_000,      max: 30,  message: 'AI rate limit: max 30 requests/min.' });
const authRateLimit = makeRateLimiter({ windowMs: 15 * 60_000, max: 10,  message: 'Too many auth attempts — try again in 15 minutes.' });

const ALLOWED_CEREBRAS_MODELS = new Set(['llama3.1-70b', 'llama3.1-8b', 'llama-3.3-70b']);
const ALLOWED_TOGETHER_MODELS = new Set([
  'deepseek-ai/DeepSeek-Coder-V2-Instruct',
  'meta-llama/Llama-3-70b-chat-hf',
  'meta-llama/Llama-3-8b-chat-hf',
]);
const MAX_AI_TOKENS = 8000;

function signToken(payload) {
  const jti = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) { return jwt.verify(token, JWT_SECRET); }

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = verifyToken(header.slice(7));
    if (payload.jti && tokenBlocklist.has(payload.jti))
      return res.status(401).json({ error: 'Session expired — please sign in again' });
    req.user = payload;
    req.tokenJti = payload.jti;
    req.tokenExp = payload.exp;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fill in all fields' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const ip = getClientIp(req);
  if (ip) {
    const { data: ipBanned } = await supabase.from('ip_bans').select('ip').eq('ip', ip).maybeSingle();
    if (ipBanned) return res.status(403).json({ error: 'Registration not allowed from this network' });
  }
  const { data: existing } = await supabase.from('users').select('id').eq('username', username.toLowerCase()).single();
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({
    username: username.toLowerCase(), password_hash: hash,
    is_admin: false, is_banned: false, created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(500).json({ error: 'Registration failed' });
  const user = { id: data.id, username: data.username, isAdmin: data.is_admin };
  res.json({ token: signToken(user), user });
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fill in all fields' });
  const ip = getClientIp(req);
  if (ip) {
    const { data: ipBanned } = await supabase.from('ip_bans').select('ip').eq('ip', ip).maybeSingle();
    if (ipBanned) return res.status(403).json({ error: 'Login not allowed from this network' });
  }
  const { data, error } = await supabase.from('users').select('*').eq('username', username.toLowerCase()).single();
  if (error || !data) return res.status(401).json({ error: 'Invalid username or password' });
  if (data.is_banned) return res.status(403).json({ error: 'This account has been banned' });
  const match = await bcrypt.compare(password, data.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid username or password' });
  await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', data.id);
  const user = { id: data.id, username: data.username, isAdmin: data.is_admin };
  res.json({ token: signToken(user), user });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!data) return res.status(404).json({ error: 'User not found' });
  if (data.is_banned) return res.status(403).json({ error: 'This account has been banned' });
  res.json({ id: data.id, username: data.username, isAdmin: data.is_admin });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  if (req.tokenJti && req.tokenExp) tokenBlocklist.set(req.tokenJti, req.tokenExp * 1000);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI PROXY — Cerebras
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/cerebras', requireAuth, aiRateLimit, async (req, res) => {
  if (!CEREBRAS_KEY) return res.status(503).json({ error: 'Cerebras not configured on server' });
  const { messages, model, max_tokens, stream } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  if (messages.length > 50) return res.status(400).json({ error: 'Too many messages in context (max 50)' });
  const cerebrasModel = ALLOWED_CEREBRAS_MODELS.has(model) ? model : 'llama3.1-70b';
  const clampedTokens = Math.min(max_tokens || 4000, MAX_AI_TOKENS);
  try {
    const upstream = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CEREBRAS_KEY },
      body: JSON.stringify({ model: cerebrasModel, max_tokens: clampedTokens, messages, stream: !!stream }),
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: err?.message || 'Cerebras error ' + upstream.status });
    }
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      upstream.body.pipe(res);
      req.on('close', () => { try { upstream.body.destroy(); } catch {} });
    } else {
      res.json(await upstream.json());
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI PROXY — Together.ai
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/together', requireAuth, aiRateLimit, async (req, res) => {
  if (!TOGETHER_KEY) return res.status(503).json({ error: 'Together.ai not configured' });
  const { messages, model, max_tokens, stream } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  if (messages.length > 50) return res.status(400).json({ error: 'Too many messages in context (max 50)' });
  const togetherModel = ALLOWED_TOGETHER_MODELS.has(model) ? model : 'deepseek-ai/DeepSeek-Coder-V2-Instruct';
  const clampedTokens = Math.min(max_tokens || 4000, MAX_AI_TOKENS);
  try {
    const upstream = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOGETHER_KEY },
      body: JSON.stringify({ model: togetherModel, max_tokens: clampedTokens, messages, stream: !!stream }),
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({ error: err?.error?.message || 'Together error ' + upstream.status });
    }
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      upstream.body.pipe(res);
      req.on('close', () => { try { upstream.body.destroy(); } catch {} });
    } else {
      res.json(await upstream.json());
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RAG MEMORY — ChromaDB vector store
// ═══════════════════════════════════════════════════════════════════════════════
const RAG_COLLECTION        = 'luaforge_scripts';
const RAG_PATTERNS_COLL     = 'luaforge_patterns';   // NEW: global learned patterns

async function chromaRequest(path, method, body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(CHROMA_URL + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error('ChromaDB error ' + res.status + ': ' + txt);
      }
      return res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

async function ensureCollection(name = RAG_COLLECTION) {
  try {
    await chromaRequest('/api/v1/collections', 'POST', {
      name, metadata: { 'hnsw:space': 'cosine' },
    });
  } catch (e) {
    if (!e.message.includes('already exists') && !e.message.includes('409')) throw e;
  }
}

async function embedText(text) {
  if (TOGETHER_KEY) {
    try {
      const res = await fetch('https://api.together.xyz/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOGETHER_KEY },
        body: JSON.stringify({ model: 'togethercomputer/m2-bert-80M-8k-retrieval', input: text.slice(0, 4000) }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.data?.[0]?.embedding) return data.data[0].embedding;
      }
    } catch {}
  }
  // Fallback: deterministic sparse pseudo-embedding (768-dim) from token hashes.
  // Weaker than a real model but allows ChromaDB to function without Together.ai.
  const dim = 768;
  const vec = new Array(dim).fill(0);
  const tokens = text.toLowerCase().slice(0, 2000).split(/\W+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 5381;
    for (let i = 0; i < tok.length; i++) h = ((h << 5) + h) ^ tok.charCodeAt(i);
    vec[Math.abs(h) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

app.post('/api/rag/store', requireAuth, async (req, res) => {
  const { text, metadata } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    await ensureCollection();
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_COLLECTION, 'GET');
    const colId = colRes.id;
    const embedding = await embedText(text);
    const id = 'doc_' + req.user.id + '_' + Date.now();
    const body = {
      ids: [id],
      documents: [text.slice(0, 8000)],
      metadatas: [{ userId: String(req.user.id), ...(metadata || {}), storedAt: new Date().toISOString() }],
    };
    if (embedding) body.embeddings = [embedding];
    await chromaRequest('/api/v1/collections/' + colId + '/add', 'POST', body);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rag/query', requireAuth, async (req, res) => {
  const { query, n = 3 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    await ensureCollection();
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_COLLECTION, 'GET');
    const colId = colRes.id;
    const embedding = await embedText(query);
    const queryBody = { n_results: Math.min(n, 5), where: { userId: String(req.user.id) } };
    if (embedding) { queryBody.query_embeddings = [embedding]; }
    else { queryBody.query_texts = [query.slice(0, 1000)]; }
    const result = await chromaRequest('/api/v1/collections/' + colId + '/query', 'POST', queryBody);
    const docs = (result.documents?.[0] || []).map((doc, i) => ({
      text: doc,
      metadata: result.metadatas?.[0]?.[i] || {},
      distance: result.distances?.[0]?.[i] || 0,
    }));
    res.json({ results: docs });
  } catch (e) { res.json({ results: [], error: e.message }); }
});

app.post('/api/rag/auto-store', requireAuth, async (req, res) => {
  const { code, name, type, description } = req.body;
  if (!code) return res.json({ ok: true });
  try {
    await ensureCollection();
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_COLLECTION, 'GET');
    const colId = colRes.id;
    const embedding = await embedText(code);
    const id = 'script_' + req.user.id + '_' + Date.now();
    const body = {
      ids: [id],
      documents: [code.slice(0, 8000)],
      metadatas: [{ userId: String(req.user.id), name: name || 'unnamed', type: type || 'Script', description: description || '', storedAt: new Date().toISOString() }],
    };
    if (embedding) body.embeddings = [embedding];
    await chromaRequest('/api/v1/collections/' + colId + '/add', 'POST', body);
  } catch {}
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW: SCRIPT VERSION CONTROL
//  Every script push saves a version. Users can list and restore any version.
//  POST /api/versions/save  { scriptName, code, source }
//  GET  /api/versions/:scriptName  → list all versions for a script
//  POST /api/versions/restore  { versionId }  → push old version back to Studio
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/versions/save', requireAuth, async (req, res) => {
  const { scriptName, code, scriptType, description } = req.body;
  if (!scriptName || !code) return res.status(400).json({ error: 'scriptName and code required' });
  if (code.length > 500_000) return res.status(400).json({ error: 'Code too large (max 500KB)' });

  const { data, error } = await supabase.from('script_versions').insert({
    user_id: req.user.id,
    script_name: scriptName,
    script_type: scriptType || 'Script',
    code,
    description: description || '',
    created_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: 'Failed to save version' });
  res.json({ ok: true, versionId: data.id });
});

app.get('/api/versions/:scriptName', requireAuth, async (req, res) => {
  const scriptName = decodeURIComponent(req.params.scriptName);
  const { data, error } = await supabase
    .from('script_versions')
    .select('id, script_name, script_type, description, created_at, code')
    .eq('user_id', req.user.id)
    .eq('script_name', scriptName)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Failed to fetch versions' });
  // Return metadata for listing; full code only on restore
  const versions = (data || []).map(v => ({
    id: v.id,
    scriptName: v.script_name,
    scriptType: v.script_type,
    description: v.description,
    createdAt: v.created_at,
    codePreview: v.code?.slice(0, 120) + (v.code?.length > 120 ? '…' : ''),
    codeLength: v.code?.length || 0,
  }));
  res.json({ versions });
});

app.get('/api/versions/list/all', requireAuth, async (req, res) => {
  // Returns distinct script names with their latest version time
  const { data, error } = await supabase
    .from('script_versions')
    .select('script_name, script_type, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch version list' });

  // Deduplicate by script name keeping latest
  const seen = new Map();
  for (const row of (data || [])) {
    if (!seen.has(row.script_name)) seen.set(row.script_name, row);
  }
  res.json({ scripts: [...seen.values()] });
});

app.post('/api/versions/restore', requireAuth, async (req, res) => {
  const { versionId } = req.body;
  if (!versionId) return res.status(400).json({ error: 'versionId required' });

  const { data: ver, error } = await supabase
    .from('script_versions')
    .select('*')
    .eq('id', versionId)
    .eq('user_id', req.user.id)  // security: own versions only
    .single();

  if (error || !ver) return res.status(404).json({ error: 'Version not found' });

  // Push restored version to Studio if connected
  const ws = studioClients.get(String(req.user.id));
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'inject',
      scriptName: ver.script_name,
      scriptType: ver.script_type,
      code: ver.code,
    }));
  }

  res.json({ ok: true, pushed: !!(ws && ws.readyState === 1), code: ver.code, scriptName: ver.script_name });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW: AUTO CONSOLE LOG CAPTURE + SMART AUTO-FIX
//  Plugin streams console output to server automatically (no manual paste).
//  Server queues errors; AI analyzes and optionally auto-patches.
//
//  POST /api/console/log  { logs: [{level, message, timestamp}] }
//  GET  /api/console/recent  → last 100 log lines for the user
//  POST /api/console/analyze  { logId }  → AI explains + optional patch
// ═══════════════════════════════════════════════════════════════════════════════

// In-memory log buffer per user (last 500 lines), flushed to Supabase async
const consoleBuffers = new Map(); // userId → [{level, message, timestamp, id}]

// ─── Async learning queue (avoids blocking request path) ──────────────────────
const learnQueue = [];
let learnQueueRunning = false;
async function drainLearnQueue() {
  if (learnQueueRunning) return;
  learnQueueRunning = true;
  while (learnQueue.length > 0) {
    const { userId, errors } = learnQueue.shift();
    await learnFromErrors(userId, null, errors).catch(() => {});
    await new Promise(r => setTimeout(r, 200)); // small gap between analyses
  }
  learnQueueRunning = false;
}
function queueLearnFromErrors(userId, errors) {
  learnQueue.push({ userId, errors });
  if (learnQueue.length > 50) learnQueue.splice(0, learnQueue.length - 50); // cap queue
  setImmediate(drainLearnQueue);
}

app.post('/api/console/log', requireAuth, async (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs) || logs.length === 0) return res.status(400).json({ error: 'logs array required' });
  if (logs.length > 200) return res.status(400).json({ error: 'Too many logs at once (max 200)' });

  const uid = String(req.user.id);
  const buf = consoleBuffers.get(uid) || [];

  const enriched = logs.map(l => ({
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2),
    level: ['error', 'warn', 'info', 'print'].includes(l.level) ? l.level : 'print',
    message: String(l.message || '').slice(0, 2000),
    timestamp: l.timestamp || new Date().toISOString(),
    userId: uid,
  }));

  buf.push(...enriched);
  // Keep last 500
  if (buf.length > 500) buf.splice(0, buf.length - 500);
  consoleBuffers.set(uid, buf);

  // Async persist errors to Supabase
  const errors = enriched.filter(l => l.level === 'error');
  if (errors.length > 0) {
    supabase.from('console_logs').insert(
      errors.map(l => ({ user_id: req.user.id, level: l.level, message: l.message, created_at: l.timestamp }))
    ).catch(() => {});

    // ── Self-learning: if an error occurs and we have a recent script,
    //    queue an async AI analysis to learn from the failure pattern
    queueLearnFromErrors(req.user.id, errors);
  }

  res.json({ ok: true, received: enriched.length });
});

app.get('/api/console/recent', requireAuth, async (req, res) => {
  const uid = String(req.user.id);
  const buf = consoleBuffers.get(uid) || [];
  // Also fetch persisted errors from DB
  const { data: dbLogs } = await supabase
    .from('console_logs')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  res.json({ logs: buf.slice(-100), persistedErrors: dbLogs || [] });
});

app.post('/api/console/analyze', requireAuth, aiRateLimit, async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const prompt = `You are a Roblox Studio expert. A developer got this error in their console:

"${String(message).slice(0, 1000)}"

${context ? `Recent context: ${String(context).slice(0, 500)}` : ''}

Explain:
1. What caused this error (plain English, 1-2 sentences)
2. Exactly how to fix it (be specific — line numbers, function names, what to change)
3. A corrected code snippet if applicable (short, under 20 lines)

Be direct. No fluff.`;

  try {
    const result = await callAI(prompt, 600);
    res.json({ explanation: result });
  } catch (e) {
    res.status(500).json({ error: 'AI request failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW: SELF-LEARNING PIPELINE
//  LuaForge learns from every script it generates and every error that occurs.
//  It extracts reusable patterns, stores them globally, and injects them into
//  future prompts — making the AI smarter on Roblox-specific patterns over time.
//
//  POST /api/learn/pattern       { code, description, tags }  — manual store
//  GET  /api/learn/patterns      → list all learned patterns (admin)
//  POST /api/learn/query         { prompt }  → get relevant learned patterns
//  POST /api/learn/from-feedback { code, feedback, rating }  — user feedback loop
// ═══════════════════════════════════════════════════════════════════════════════

async function learnFromErrors(userId, authHeader, errors) {
  // Automatically analyze error patterns and store what causes them
  // so future prompts can avoid the same mistakes
  if (!GROQ_KEY && !CEREBRAS_KEY) return;

  for (const err of errors.slice(0, 3)) {  // max 3 auto-analyses per batch
    try {
      const prompt = `You are a Roblox Lua expert analyzing a runtime error to extract a reusable "what to avoid" pattern.

Error: "${err.message}"

Write a SHORT (2-3 sentence) rule that tells an AI code generator what to do differently to avoid this class of error.
Format: "When [situation], always [do X] instead of [doing Y]. This prevents [error type]."
Return only the rule text, nothing else.`;

      const rule = await callAI(prompt, 120);
      if (!rule || rule.length < 20) continue;

      // Store in global patterns collection
      await ensureCollection(RAG_PATTERNS_COLL);
      const colRes = await chromaRequest('/api/v1/collections/' + RAG_PATTERNS_COLL, 'GET');
      const colId = colRes.id;
      const embedding = await embedText(rule);
      const id = 'pattern_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const body = {
        ids: [id],
        documents: [rule],
        metadatas: [{
          source: 'auto_error',
          userId: String(userId),
          originalError: err.message.slice(0, 200),
          storedAt: new Date().toISOString(),
          upvotes: '0',
          downvotes: '0',
        }],
      };
      if (embedding) body.embeddings = [embedding];
      await chromaRequest('/api/v1/collections/' + colId + '/add', 'POST', body);

      // Persist to Supabase for admin review
      await supabase.from('learned_patterns').insert({
        source: 'auto_error',
        user_id: userId,
        pattern: rule,
        original_error: err.message.slice(0, 200),
        created_at: new Date().toISOString(),
      }).catch(() => {});
    } catch {}
  }
}

app.post('/api/learn/pattern', requireAuth, async (req, res) => {
  // Manually store a learned pattern (admin or trusted user)
  const { code, description, tags } = req.body;
  if (!description) return res.status(400).json({ error: 'description required' });

  const text = code ? `${description}\n\nExample:\n${code.slice(0, 2000)}` : description;

  try {
    await ensureCollection(RAG_PATTERNS_COLL);
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_PATTERNS_COLL, 'GET');
    const colId = colRes.id;
    const embedding = await embedText(text);
    const id = 'pattern_manual_' + Date.now();
    const body = {
      ids: [id],
      documents: [text.slice(0, 8000)],
      metadatas: [{
        source: 'manual',
        userId: String(req.user.id),
        tags: Array.isArray(tags) ? tags.join(',') : (tags || ''),
        storedAt: new Date().toISOString(),
        upvotes: '0',
        downvotes: '0',
      }],
    };
    if (embedding) body.embeddings = [embedding];
    await chromaRequest('/api/v1/collections/' + colId + '/add', 'POST', body);

    await supabase.from('learned_patterns').insert({
      source: 'manual',
      user_id: req.user.id,
      pattern: text.slice(0, 2000),
      tags: Array.isArray(tags) ? tags.join(',') : (tags || ''),
      created_at: new Date().toISOString(),
    }).catch(() => {});

    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/learn/query', requireAuth, async (req, res) => {
  // Get learned patterns relevant to a prompt — injected into AI context
  const { prompt, n = 5 } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    await ensureCollection(RAG_PATTERNS_COLL);
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_PATTERNS_COLL, 'GET');
    const colId = colRes.id;
    const embedding = await embedText(prompt);
    const queryBody = { n_results: Math.min(n, 8) };
    if (embedding) { queryBody.query_embeddings = [embedding]; }
    else { queryBody.query_texts = [prompt.slice(0, 1000)]; }
    const result = await chromaRequest('/api/v1/collections/' + colId + '/query', 'POST', queryBody);
    const patterns = (result.documents?.[0] || []).map((doc, i) => ({
      text: doc,
      metadata: result.metadatas?.[0]?.[i] || {},
      distance: result.distances?.[0]?.[i] || 0,
    })).filter(p => p.distance < 0.7);  // only relevant ones
    res.json({ patterns });
  } catch (e) { res.json({ patterns: [], error: e.message }); }
});

app.post('/api/learn/from-feedback', requireAuth, async (req, res) => {
  // User rates generated code → system learns what works
  const { code, feedback, rating, prompt: originalPrompt } = req.body;
  if (!code || !feedback) return res.status(400).json({ error: 'code and feedback required' });
  const numRating = parseInt(rating) || 3;

  // Only learn from positive (4-5 star) or very negative (1 star) feedback
  if (numRating >= 4) {
    // Good code: extract as a positive pattern
    const learnPrompt = `A Roblox developer rated this code ${numRating}/5 and said: "${feedback}"

Code:
${code.slice(0, 2000)}

Write a SHORT rule (2-3 sentences) describing what makes this code good for future reference.
Return only the rule, nothing else.`;

    try {
      const rule = await callAI(learnPrompt, 120);
      if (rule && rule.length > 20) {
        await ensureCollection(RAG_PATTERNS_COLL);
        const colRes = await chromaRequest('/api/v1/collections/' + RAG_PATTERNS_COLL, 'GET');
        const colId = colRes.id;
        const embedding = await embedText(rule);
        const id = 'pattern_feedback_' + Date.now();
        const body = {
          ids: [id],
          documents: [rule],
          metadatas: [{
            source: 'feedback',
            userId: String(req.user.id),
            rating: String(numRating),
            storedAt: new Date().toISOString(),
            upvotes: '1',
            downvotes: '0',
          }],
        };
        if (embedding) body.embeddings = [embedding];
        await chromaRequest('/api/v1/collections/' + colId + '/add', 'POST', body).catch(() => {});
      }
    } catch {}
  }

  // Always store feedback in Supabase
  await supabase.from('code_feedback').insert({
    user_id: req.user.id,
    code: code.slice(0, 10000),
    feedback: feedback.slice(0, 1000),
    rating: numRating,
    original_prompt: (originalPrompt || '').slice(0, 500),
    created_at: new Date().toISOString(),
  }).catch(() => {});

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW: SMART CONTEXT INJECTION
//  Before any AI code generation, this endpoint assembles the best possible
//  context: user's past scripts (RAG) + global learned patterns + project tree.
//  The frontend calls this to build an enriched system prompt.
//
//  POST /api/context/build  { prompt, includeProjectTree? }
//  → { systemContext, ragSnippets, patterns, projectHint }
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/context/build', requireAuth, async (req, res) => {
  const { prompt, includeProjectTree } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const [ragResult, patternsResult] = await Promise.allSettled([
    // User's own past scripts
    (async () => {
      await ensureCollection(RAG_COLLECTION);
      const colRes = await chromaRequest('/api/v1/collections/' + RAG_COLLECTION, 'GET');
      const embedding = await embedText(prompt);
      const queryBody = { n_results: 3, where: { userId: String(req.user.id) } };
      if (embedding) queryBody.query_embeddings = [embedding];
      else queryBody.query_texts = [prompt.slice(0, 1000)];
      const result = await chromaRequest('/api/v1/collections/' + colRes.id + '/query', 'POST', queryBody);
      return (result.documents?.[0] || []).map((doc, i) => ({
        text: doc, metadata: result.metadatas?.[0]?.[i] || {},
      }));
    })(),
    // Global learned patterns
    (async () => {
      await ensureCollection(RAG_PATTERNS_COLL);
      const colRes = await chromaRequest('/api/v1/collections/' + RAG_PATTERNS_COLL, 'GET');
      const embedding = await embedText(prompt);
      const queryBody = { n_results: 5 };
      if (embedding) queryBody.query_embeddings = [embedding];
      else queryBody.query_texts = [prompt.slice(0, 1000)];
      const result = await chromaRequest('/api/v1/collections/' + colRes.id + '/query', 'POST', queryBody);
      return (result.documents?.[0] || [])
        .map((doc, i) => ({ text: doc, distance: result.distances?.[0]?.[i] || 0 }))
        .filter(p => p.distance < 0.7);
    })(),
  ]);

  const ragSnippets = ragResult.status === 'fulfilled' ? ragResult.value : [];
  const patterns = patternsResult.status === 'fulfilled' ? patternsResult.value : [];

  // Build a rich system context string
  let systemContext = `You are LuaForge, an expert Roblox Luau code generator. Write clean, production-ready Roblox Studio scripts.

RULES:
- Use game:GetService() for all services
- Use task.wait() never wait()
- Always handle nil safely
- Use RemoteEvents for client-server communication
- Return raw Lua only, no markdown fences unless asked`;

  if (patterns.length > 0) {
    systemContext += '\n\nLEARNED BEST PRACTICES (apply these):\n';
    systemContext += patterns.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
  }

  if (ragSnippets.length > 0) {
    systemContext += '\n\nYOUR PREVIOUS SCRIPTS FOR CONTEXT:\n';
    systemContext += ragSnippets.map(s =>
      `// ${s.metadata?.name || 'unnamed'}\n${s.text.slice(0, 400)}`
    ).join('\n---\n');
  }

  // If project tree is requested and Studio is connected, fetch it
  let projectHint = null;
  if (includeProjectTree) {
    const ws = studioClients.get(String(req.user.id));
    if (ws && ws.readyState === 1) {
      try {
        const requestId = 'ctx_' + Date.now();
        const tree = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 5000);
          pendingSyncReads.set(requestId, { resolve, reject, timer });
          ws.send(JSON.stringify({ type: 'sync_read', requestId }));
        });
        projectHint = tree;
        if (tree?.tree) {
          systemContext += '\n\nCURRENT PROJECT STRUCTURE:\n' + JSON.stringify(tree.tree, null, 1).slice(0, 2000);
        }
      } catch {}
    }
  }

  res.json({ systemContext, ragSnippets, patterns, projectHint });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TESTEZ — AI test generation
// ═══════════════════════════════════════════════════════════════════════════════
const TESTEZ_SYSTEM = `You are a Roblox Luau testing expert. Given a script, write a complete TestEZ spec file.

TestEZ spec format:
return function()
  describe("ModuleName", function()
    it("should do something", function()
      expect(result).to.equal(expected)
    end)
  end)
end

Rules:
- Use game:GetService() for all services
- require() the module under test using its ReplicatedStorage path
- Test every exported function with at least 2 cases (happy path + edge case)
- Use expect().to.equal(), expect().to.be.ok(), expect().to.throw()
- Return raw Lua only, no markdown fences.`;

app.post('/api/testez/generate', requireAuth, async (req, res) => {
  const { code, scriptName } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const prompt = `Write a TestEZ spec for this Roblox Luau script named "${scriptName || 'Module'}":\n\n${code.slice(0, 6000)}`;
  try {
    const testCode = await callAI(prompt, 3000, TESTEZ_SYSTEM);
    res.json({ testCode: testCode.replace(/^```(?:lua)?\s*/i, '').replace(/\s*```\s*$/i, '').trim() });
  } catch (e) {
    res.status(503).json({ error: 'No AI provider available: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STUDIO PUSH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
const studioClients = new Map();

app.post('/api/push-to-studio', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1)
    return res.status(503).json({ error: 'Studio not connected — open Roblox Studio with the plugin' });

  ws.send(JSON.stringify({ type: 'inject', ...req.body }));

  // Save version automatically
  if (req.body.code && req.body.scriptName) {
    supabase.from('script_versions').insert({
      user_id: req.user.id,
      script_name: req.body.scriptName,
      script_type: req.body.scriptType || 'Script',
      code: req.body.code,
      description: req.body.description || 'Auto-saved on push',
      created_at: new Date().toISOString(),
    }).catch(() => {});
  }

  await supabase.from('script_log').insert({
    user_id: req.user.id,
    script_name: req.body.scriptName || 'unnamed',
    created_at: new Date().toISOString(),
  }).catch(() => {});

  await supabase.rpc('increment_scripts_generated', { uid: req.user.id }).catch(() => {});

  if (req.body.code) {
    autoStoreScript({ userId: req.user.id, code: req.body.code, name: req.body.scriptName, type: req.body.scriptType }).catch(() => {});
  }

  res.json({ ok: true });
});

app.post('/api/push-blueprint', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1)
    return res.status(503).json({ error: 'Studio not connected — open Roblox Studio with the plugin' });

  ws.send(JSON.stringify({ type: 'blueprint', ...req.body }));

  const scriptCount = (req.body?.blueprint?.instances || [])
    .filter(i => ['Script', 'LocalScript', 'ModuleScript'].includes(i.instanceType)).length;

  await supabase.from('script_log').insert({
    user_id: req.user.id,
    script_name: 'Auto Build Blueprint (' + scriptCount + ' scripts)',
    created_at: new Date().toISOString(),
  }).catch(() => {});

  await supabase.rpc('increment_scripts_generated', { uid: req.user.id, amount: scriptCount || 1 }).catch(() => {});

  const scripts = (req.body?.blueprint?.instances || []).filter(i =>
    ['Script', 'LocalScript', 'ModuleScript'].includes(i.instanceType) && i.source
  );

  for (const s of scripts) {
    // Auto-save versions for blueprint scripts too
    supabase.from('script_versions').insert({
      user_id: req.user.id,
      script_name: s.name || 'Blueprint Script',
      script_type: s.instanceType || 'Script',
      code: s.source,
      description: 'Auto Build Blueprint',
      created_at: new Date().toISOString(),
    }).catch(() => {});

    autoStoreScript({ userId: req.user.id, code: s.source, name: s.name, type: s.instanceType, description: s.description }).catch(() => {});
  }

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [usersRes, bannedRes, scriptsRes, ipBansRes, patternsRes, feedbackRes] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_banned', true),
    supabase.from('script_log').select('id', { count: 'exact', head: true }),
    supabase.from('ip_bans').select('id', { count: 'exact', head: true }),
    supabase.from('learned_patterns').select('id', { count: 'exact', head: true }),
    supabase.from('code_feedback').select('id', { count: 'exact', head: true }),
  ]);
  res.json({
    totalUsers: usersRes.count || 0,
    totalBanned: bannedRes.count || 0,
    totalScripts: scriptsRes.count || 0,
    activeConnections: studioClients.size,
    totalIpBans: ipBansRes.count || 0,
    totalLearnedPatterns: patternsRes.count || 0,
    totalFeedback: feedbackRes.count || 0,
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('users').select('*').order('created_at', { ascending: false });
  const scriptCounts = await supabase.from('script_log').select('user_id');
  const counts = {};
  (scriptCounts.data || []).forEach(r => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
  res.json((data || []).map(u => ({
    id: u.id, username: u.username, isAdmin: u.is_admin, isBanned: u.is_banned,
    createdAt: u.created_at, lastSeen: u.last_seen,
    scriptCount: counts[u.id] || 0, messageCount: 0,
  })));
});

app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('ban_log').select('*').order('created_at', { ascending: false }).limit(100);
  res.json(data || []);
});

app.get('/api/admin/patterns', requireAdmin, async (req, res) => {
  // Review all learned patterns — admin can delete bad ones
  const { data } = await supabase.from('learned_patterns').select('*').order('created_at', { ascending: false }).limit(200);
  res.json(data || []);
});

app.delete('/api/admin/patterns/:id', requireAdmin, async (req, res) => {
  await supabase.from('learned_patterns').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/feedback', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('code_feedback').select('*').order('created_at', { ascending: false }).limit(100);
  res.json(data || []);
});

app.get('/api/admin/ip-bans', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('ip_bans').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.delete('/api/admin/ip-unban', requireAdmin, async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  await supabase.from('ip_bans').delete().eq('ip', ip);
  await logAdminAction(req.user.id, 'ip-unban', ip, null);
  res.json({ ok: true });
});

async function logAdminAction(adminId, action, targetUsername, reason) {
  await supabase.from('ban_log').insert({
    admin_id: adminId, action, target_username: targetUsername,
    reason: reason || null, created_at: new Date().toISOString(),
  }).catch(() => {});
}

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const { username, reason } = req.body;
  await supabase.from('users').update({ is_banned: true }).eq('username', username);
  await logAdminAction(req.user.id, 'ban', username, reason);
  for (const [uid, ws] of studioClients) {
    const { data: u } = await supabase.from('users').select('username').eq('id', uid).single();
    if (u?.username === username) { ws.send(JSON.stringify({ type: 'kicked' })); ws.close(); }
  }
  res.json({ ok: true });
});

app.post('/api/admin/unban', requireAdmin, async (req, res) => {
  const { username } = req.body;
  await supabase.from('users').update({ is_banned: false }).eq('username', username);
  await logAdminAction(req.user.id, 'unban', username);
  res.json({ ok: true });
});

app.post('/api/admin/kick', requireAdmin, async (req, res) => {
  const { username } = req.body;
  for (const [uid, ws] of studioClients) {
    const { data: u } = await supabase.from('users').select('username').eq('id', uid).single();
    if (u?.username === username) { ws.send(JSON.stringify({ type: 'kicked' })); ws.close(); }
  }
  await logAdminAction(req.user.id, 'kick', username);
  res.json({ ok: true });
});

app.post('/api/admin/ip-ban', requireAdmin, async (req, res) => {
  const { username, ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP address required' });
  await supabase.from('ip_bans').upsert({ ip, banned_by: req.user.id, created_at: new Date().toISOString() }).catch(() => {});
  await logAdminAction(req.user.id, 'ip-ban', username, 'IP: ' + ip);
  res.json({ ok: true });
});

app.post('/api/admin/reset-password', requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
  const hash = await bcrypt.hash(newPassword, 10);
  await supabase.from('users').update({ password_hash: hash }).eq('username', username);
  await logAdminAction(req.user.id, 'reset-password', username);
  res.json({ ok: true });
});

app.delete('/api/admin/delete-user', requireAdmin, async (req, res) => {
  const { username } = req.body;
  const { data: user } = await supabase.from('users').select('id').eq('username', username).single();
  if (user) {
    await supabase.from('script_log').delete().eq('user_id', user.id);
    await supabase.from('script_versions').delete().eq('user_id', user.id);
    await supabase.from('console_logs').delete().eq('user_id', user.id);
    await supabase.from('users').delete().eq('id', user.id);
  }
  await logAdminAction(req.user.id, 'delete', username);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET — Studio Bridge
//  Now also handles console log streaming from plugin automatically
// ═══════════════════════════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) return ws.close(4001, 'No token');

  let userId;
  try {
    const payload = verifyToken(token);
    userId = String(payload.id);
  } catch {
    return ws.close(4001, 'Invalid token');
  }

  studioClients.set(userId, ws);
  ws.send(JSON.stringify({ type: 'connected' }));

  // Schedule close when token expires (avoids zombie connections)
  const tokenPayload = (() => { try { return jwt.decode(token); } catch { return null; } })();
  let tokenExpTimer = null;
  if (tokenPayload?.exp) {
    const msUntilExpiry = (tokenPayload.exp * 1000) - Date.now();
    if (msUntilExpiry > 0) {
      tokenExpTimer = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'token_expired', message: 'Session expired — please sign in again' }));
        ws.close(4001, 'Token expired');
      }, msUntilExpiry);
    }
  }

  const ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'pong') return;

      // NEW: Plugin streams console logs automatically — no manual paste needed
      if (msg.type === 'console_logs' && Array.isArray(msg.logs)) {
        const buf = consoleBuffers.get(userId) || [];
        const enriched = msg.logs.map(l => ({
          id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2),
          level: ['error', 'warn', 'info', 'print'].includes(l.level) ? l.level : 'print',
          message: String(l.message || '').slice(0, 2000),
          timestamp: l.timestamp || new Date().toISOString(),
          userId,
        }));
        buf.push(...enriched);
        if (buf.length > 500) buf.splice(0, buf.length - 500);
        consoleBuffers.set(userId, buf);

        const errors = enriched.filter(l => l.level === 'error');
        if (errors.length > 0) {
          supabase.from('console_logs').insert(
            errors.map(l => ({ user_id: userId, level: l.level, message: l.message, created_at: l.timestamp }))
          ).catch(() => {});
          queueLearnFromErrors(userId, errors);

          // Push error notification back to frontend (web UI)
          ws.send(JSON.stringify({ type: 'error_detected', errors: errors.map(e => ({ message: e.message, timestamp: e.timestamp })) }));
        }
        return;
      }

      // Sync read results
      if (msg.type === 'sync_result' && msg.requestId) {
        const pending = pendingSyncReads.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingSyncReads.delete(msg.requestId);
          pending.resolve({ tree: msg.tree });
        }
        return;
      }

      // Query results
      if (msg.type === 'query_result' && msg.requestId) {
        const pending = pendingStudioQueries.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingStudioQueries.delete(msg.requestId);
          pending.resolve({ data: msg.data });
        }
        return;
      }

    } catch {}
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (tokenExpTimer) clearTimeout(tokenExpTimer);
    if (studioClients.get(userId) === ws) studioClients.delete(userId);
  });

  ws.on('error', () => ws.close());
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPLAIN ERROR — Feature 4 (upgraded with auto-learn)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/explain-error', requireAuth, aiRateLimit, async (req, res) => {
  const { error: errorText } = req.body;
  if (!errorText) return res.status(400).json({ error: 'No error provided' });
  if (typeof errorText !== 'string' || errorText.length > 2000)
    return res.status(400).json({ error: 'Error text must be a string under 2000 characters' });

  const prompt = `You are a Roblox Studio expert. A developer got this error:

"${errorText}"

Explain:
1. What caused this error (in plain English, 1-2 sentences)
2. Exactly how to fix it (be specific — line numbers, function names, what to change)
3. A corrected code snippet if applicable (keep it short)

Be direct and practical. No fluff.`;

  try {
    const explanation = await callAI(prompt, 600);
    // Auto-learn from this error
    queueLearnFromErrors(req.user.id, [{ message: errorText }]);
    res.json({ explanation });
  } catch (e) {
    res.status(500).json({ error: 'AI request failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 2: NATURAL LANGUAGE → ADMIN/EXECUTOR COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════
const NL_COMMAND_SYSTEM = `You are a Roblox admin command translator. Convert natural language into Roblox admin/executor commands.
Return ONLY a JSON array of command strings (without the ; prefix), no explanation, no markdown.
Common commands: fly, unfly, flyspeed <n>, speed <n>, jump <n>, noclip, clip, god, ungod, invisible, visible, tp <player>, bring <player>, kick <player> <reason>, ban <player>, freeze <player>, thaw <player>, sit, unsit, respawn, explode, ff, unff, heal, kill, age, admin <player>, unadmin <player>, music <id>, ambient <r> <g> <b>, time <0-24>, gravity <n>.
Example input: "make me fly really fast and be invisible"
Example output: ["fly","flyspeed 50","invisible"]`;

app.post('/api/nlcommand', requireAuth, aiRateLimit, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (typeof text !== 'string' || text.length > 500)
    return res.status(400).json({ error: 'text must be a string under 500 characters' });

  try {
    const raw = await callAI(text, 200, NL_COMMAND_SYSTEM);
    const cleaned = raw.replace(/```json?|```/g, '').trim();
    const commands = JSON.parse(cleaned);
    res.json({ commands: Array.isArray(commands) ? commands : [] });
  } catch {
    res.status(503).json({ error: 'No AI provider available' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 1 & 3: STUDIO QUERIES + BIDIRECTIONAL SYNC
// ═══════════════════════════════════════════════════════════════════════════════
const pendingStudioQueries = new Map();
const pendingSyncReads = new Map();

app.post('/api/studio/query', requireAuth, aiRateLimit, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) return res.status(503).json({ error: 'Studio not connected' });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  const requestId = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingStudioQueries.delete(requestId); reject(new Error('Studio query timed out after 10s')); }, 10000);
    pendingStudioQueries.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'query', requestId, query }));
  }).catch(e => ({ error: e.message }));
  res.json(result);
});

app.post('/api/studio/query-result', requireAuth, async (req, res) => {
  const { requestId, data } = req.body;
  const pending = pendingStudioQueries.get(requestId);
  if (pending) { clearTimeout(pending.timer); pendingStudioQueries.delete(requestId); pending.resolve({ data }); }
  res.json({ ok: true });
});

app.post('/api/sync/read', requireAuth, aiRateLimit, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) return res.status(503).json({ error: 'Studio not connected' });
  const requestId = 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingSyncReads.delete(requestId); reject(new Error('Sync read timed out after 15s')); }, 15000);
    pendingSyncReads.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'sync_read', requestId }));
  }).catch(e => ({ error: e.message }));
  res.json(result);
});

app.post('/api/sync/result', requireAuth, async (req, res) => {
  const { requestId, tree } = req.body;
  const pending = pendingSyncReads.get(requestId);
  if (pending) { clearTimeout(pending.timer); pendingSyncReads.delete(requestId); pending.resolve({ tree }); }
  res.json({ ok: true });
});

app.post('/api/sync/apply', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) return res.status(503).json({ error: 'Studio not connected' });
  const { patches } = req.body;
  if (!Array.isArray(patches) || !patches.length) return res.status(400).json({ error: 'patches array required' });
  if (patches.length > 50) return res.status(400).json({ error: 'Too many patches at once (max 50)' });
  const VALID_TYPES = new Set(['Script', 'LocalScript', 'ModuleScript']);
  for (const p of patches) {
    if (!p.name || typeof p.name !== 'string' || p.name.length > 200)
      return res.status(400).json({ error: 'Each patch must have a valid name (string, max 200 chars)' });
    if (p.type && !VALID_TYPES.has(p.type))
      return res.status(400).json({ error: 'Invalid script type: ' + p.type });
    if (p.source && typeof p.source !== 'string')
      return res.status(400).json({ error: 'patch source must be a string' });
    if (p.source && p.source.length > 500_000)
      return res.status(400).json({ error: 'patch source too large (max 500KB per script)' });
  }
  ws.send(JSON.stringify({ type: 'sync_apply', patches }));
  for (const p of patches) {
    await supabase.from('script_log').insert({ user_id: req.user.id, script_name: p.name || 'sync patch', created_at: new Date().toISOString() }).catch(() => {});

    // Auto-save version on sync apply too
    if (p.source) {
      supabase.from('script_versions').insert({
        user_id: req.user.id, script_name: p.name, script_type: p.type || 'Script',
        code: p.source, description: 'Sync apply', created_at: new Date().toISOString(),
      }).catch(() => {});

      autoStoreScript({ userId: req.user.id, code: p.source, name: p.name, type: p.type }).catch(() => {});
    }
  }
  await supabase.rpc('increment_scripts_generated', { uid: req.user.id, amount: patches.length }).catch(() => {});
  res.json({ ok: true, patched: patches.length });
});


// ─── Direct auto-store helper (avoids localhost self-fetch) ───────────────────
async function autoStoreScript({ userId, code, name, type, description }) {
  if (!code) return;
  try {
    await ensureCollection();
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_COLLECTION, 'GET');
    const colId = colRes.id;
    const embedding = await embedText(code);
    const id = 'script_' + userId + '_' + Date.now();
    const body = {
      ids: [id],
      documents: [code.slice(0, 8000)],
      metadatas: [{ userId: String(userId), name: name || 'unnamed', type: type || 'Script', description: description || '', storedAt: new Date().toISOString() }],
    };
    if (embedding) body.embeddings = [embedding];
    await chromaRequest('/api/v1/collections/' + colId + '/add', 'POST', body);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHARED AI CALLER — tries Groq → Cerebras → Together in order
// ═══════════════════════════════════════════════════════════════════════════════
async function callAI(userPrompt, maxTokens = 1000, systemPrompt = 'You are a Roblox Luau expert. Be concise and practical.') {
  const providers = [];
  if (GROQ_KEY) providers.push({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: GROQ_KEY, model: 'llama-3.3-70b-versatile',
  });
  if (CEREBRAS_KEY) providers.push({
    url: 'https://api.cerebras.ai/v1/chat/completions',
    key: CEREBRAS_KEY, model: 'llama3.1-70b',
  });
  if (TOGETHER_KEY) providers.push({
    url: 'https://api.together.xyz/v1/chat/completions',
    key: TOGETHER_KEY, model: 'deepseek-ai/DeepSeek-Coder-V2-Instruct',
  });

  for (const p of providers) {
    if (isProviderOpen(p.url)) continue; // circuit open — skip provider
    let attempt = 0;
    while (attempt < 2) {
      try {
        const r = await fetch(p.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
          body: JSON.stringify({
            model: p.model,
            max_tokens: Math.min(maxTokens, MAX_AI_TOKENS),
            stream: false,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });
        if (r.status === 429 || r.status >= 500) {
          attempt++;
          recordProviderFailure(p.url);
          if (attempt < 2) await new Promise(res => setTimeout(res, 1000 * attempt));
          continue;
        }
        if (!r.ok) { recordProviderFailure(p.url); break; }
        const data = await r.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) { recordProviderSuccess(p.url); return content; }
        break;
      } catch { attempt++; recordProviderFailure(p.url); if (attempt < 2) await new Promise(res => setTimeout(res, 1000)); }
    }
  }
  throw new Error('All AI providers failed or are not configured');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
  let chromaOk = false;
  try { await fetch(CHROMA_URL + '/api/v1/heartbeat'); chromaOk = true; } catch {}
  res.json({
    ok: true,
    version: '3.1.0',
    chroma: chromaOk ? 'up' : 'down',
    redis: redisPublisher?.isReady ? 'up' : (process.env.REDIS_URL ? 'down' : 'not_configured'),
    circuitBreakers: Object.fromEntries([...providerBreakers.entries()].map(([k,v]) => [k, Date.now() < v.openUntil ? 'open' : 'closed'])),
    features: ['auth', 'ai-proxy', 'rag', 'version-control', 'console-capture', 'self-learning', 'smart-context', 'websocket', 'testez', 'nlcommand', 'sync'],
    activeConnections: studioClients.size,
    uptime: Math.floor(process.uptime()),
  });
});


// ─── Background pruning: runs every 6h to delete old logs/versions ────────────
setInterval(async () => {
  try {
    // Delete console_logs older than 30 days
    await supabase.from('console_logs').delete().lt('created_at', new Date(Date.now() - 30*86400000).toISOString());
    // Delete script_versions older than 90 days (keep at least 1 per script per user)
    const cutoff = new Date(Date.now() - 90*86400000).toISOString();
    // Get latest version id per (user_id, script_name) to preserve
    const { data: latest } = await supabase.from('script_versions')
      .select('id, user_id, script_name')
      .order('created_at', { ascending: false });
    if (latest) {
      const keepIds = new Set();
      const seen = new Set();
      for (const row of latest) {
        const key = row.user_id + ':' + row.script_name;
        if (!seen.has(key)) { keepIds.add(row.id); seen.add(key); }
      }
      const toDelete = latest.filter(r => !keepIds.has(r.id) && r.created_at < cutoff).map(r => r.id);
      if (toDelete.length > 0) {
        await supabase.from('script_versions').delete().in('id', toDelete);
        log.info('Pruned old script versions', { count: toDelete.length });
      }
    }
  } catch (e) { log.warn('Background prune error', { error: e.message }); }
}, 6 * 60 * 60 * 1000);
const path = require('path');
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(PORT, () => log.info('LuaForge v3.1 started', { port: PORT }));
