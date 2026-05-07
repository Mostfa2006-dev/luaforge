const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'https://rluaforge.netlify.app',
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

const JWT_SECRET      = process.env.JWT_SECRET        || 'change_me_in_railway_env';
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const CEREBRAS_KEY    = process.env.CEREBRAS_API_KEY   || '';
const TOGETHER_KEY    = process.env.TOGETHER_API_KEY   || '';
const CHROMA_URL      = process.env.CHROMA_URL         || 'http://localhost:8000';
const PORT            = process.env.PORT               || 3001;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = verifyToken(header.slice(7));
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
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fill in all fields' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const ip = getClientIp(req);
  if (ip) {
    const { data: ipBanned } = await supabase.from('ip_bans').select('ip').eq('ip', ip).maybeSingle();
    if (ipBanned) return res.status(403).json({ error: 'Registration not allowed from this network' });
  }

  const { data: existing } = await supabase
    .from('users').select('id').eq('username', username.toLowerCase()).single();
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({
    username: username.toLowerCase(),
    password_hash: hash,
    is_admin: false,
    is_banned: false,
    created_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: 'Registration failed' });

  const user = { id: data.id, username: data.username, isAdmin: data.is_admin };
  res.json({ token: signToken(user), user });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fill in all fields' });

  const ip = getClientIp(req);
  if (ip) {
    const { data: ipBanned } = await supabase.from('ip_bans').select('ip').eq('ip', ip).maybeSingle();
    if (ipBanned) return res.status(403).json({ error: 'Login not allowed from this network' });
  }

  const { data, error } = await supabase
    .from('users').select('*').eq('username', username.toLowerCase()).single();

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
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI PROXY — Cerebras
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/cerebras', requireAuth, async (req, res) => {
  if (!CEREBRAS_KEY) {
    return res.status(503).json({ error: 'Cerebras not configured on server' });
  }

  const { messages, model, max_tokens, stream } = req.body;
  const cerebrasModel = model || 'llama3.1-70b';

  try {
    const upstream = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CEREBRAS_KEY,
      },
      body: JSON.stringify({
        model: cerebrasModel,
        max_tokens: max_tokens || 4000,
        messages,
        stream: !!stream,
      }),
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
      const data = await upstream.json();
      res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AI PROXY — Together.ai (DeepSeek Coder + other open models)
//  Set TOGETHER_API_KEY in Railway env — free $25 credit on signup
//  Models: deepseek-ai/DeepSeek-Coder-V2-Instruct, meta-llama/Llama-3-70b-chat-hf
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/together', requireAuth, async (req, res) => {
  if (!TOGETHER_KEY) {
    return res.status(503).json({ error: 'Together.ai not configured — add TOGETHER_API_KEY to Railway env' });
  }

  const { messages, model, max_tokens, stream } = req.body;
  const togetherModel = model || 'deepseek-ai/DeepSeek-Coder-V2-Instruct';

  try {
    const upstream = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOGETHER_KEY,
      },
      body: JSON.stringify({
        model: togetherModel,
        max_tokens: max_tokens || 4000,
        messages,
        stream: !!stream,
      }),
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
      const data = await upstream.json();
      res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RAG MEMORY — ChromaDB vector store
//  Requires ChromaDB running (Railway service or local).
//  Set CHROMA_URL in Railway env (e.g. http://my-chroma-service:8000)
//
//  Endpoints:
//    POST /api/rag/store  — embed and store a code snippet + metadata
//    POST /api/rag/query  — find the N most relevant stored snippets for a prompt
//
//  The client sends a query before Phase 1 of Auto Build; the server returns
//  the top-3 relevant past scripts so the AI has project context (closes the
//  SuperbulletAI gap).
// ═══════════════════════════════════════════════════════════════════════════════

const RAG_COLLECTION = 'luaforge_scripts';

async function chromaRequest(path, method, body) {
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
}

async function ensureCollection() {
  try {
    await chromaRequest('/api/v1/collections', 'POST', {
      name: RAG_COLLECTION,
      metadata: { 'hnsw:space': 'cosine' },
    });
  } catch (e) {
    if (!e.message.includes('already exists') && !e.message.includes('409')) throw e;
  }
}

async function embedText(text) {
  // Use Together.ai's embedding endpoint if available, else fall back to a
  // simple TF-IDF-style bag-of-words hash (good enough for keyword search).
  if (TOGETHER_KEY) {
    try {
      const res = await fetch('https://api.together.xyz/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOGETHER_KEY },
        body: JSON.stringify({ model: 'togethercomputer/m2-bert-80M-8k-retrieval', input: text.slice(0, 4000) }),
      });
      if (res.ok) {
        const data = await res.json();
        return data?.data?.[0]?.embedding || null;
      }
    } catch {}
  }
  return null;
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rag/query', requireAuth, async (req, res) => {
  const { query, n = 3 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    await ensureCollection();
    const colRes = await chromaRequest('/api/v1/collections/' + RAG_COLLECTION, 'GET');
    const colId = colRes.id;

    const embedding = await embedText(query);
    const queryBody = {
      n_results: Math.min(n, 5),
      where: { userId: String(req.user.id) },
    };
    if (embedding) {
      queryBody.query_embeddings = [embedding];
    } else {
      queryBody.query_texts = [query.slice(0, 1000)];
    }

    const result = await chromaRequest('/api/v1/collections/' + colId + '/query', 'POST', queryBody);

    const docs = (result.documents?.[0] || []).map((doc, i) => ({
      text: doc,
      metadata: result.metadatas?.[0]?.[i] || {},
      distance: result.distances?.[0]?.[i] || 0,
    }));

    res.json({ results: docs });
  } catch (e) {
    // Return empty results gracefully — RAG is optional, not critical
    res.json({ results: [], error: e.message });
  }
});

// Auto-store scripts after every successful push
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
//  TESTEZ — AI test generation endpoint
//  POST /api/testez/generate  { code, scriptName }
//  Returns a complete TestEZ spec file for the given Lua code.
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

  // Try Cerebras → Together → error
  const providers = [];
  if (CEREBRAS_KEY) providers.push({ name: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: CEREBRAS_KEY, model: 'llama3.1-70b' });
  if (TOGETHER_KEY) providers.push({ name: 'together', url: 'https://api.together.xyz/v1/chat/completions', key: TOGETHER_KEY, model: 'deepseek-ai/DeepSeek-Coder-V2-Instruct' });

  for (const p of providers) {
    try {
      const r = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
        body: JSON.stringify({ model: p.model, max_tokens: 3000, messages: [{ role: 'system', content: TESTEZ_SYSTEM }, { role: 'user', content: prompt }], stream: false }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const testCode = data?.choices?.[0]?.message?.content || '';
      return res.json({ testCode: testCode.replace(/^```(?:lua)?\s*/i, '').replace(/\s*```\s*$/i, '').trim() });
    } catch {}
  }

  res.status(503).json({ error: 'No AI provider available for test generation. Configure CEREBRAS_API_KEY or TOGETHER_API_KEY.' });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STUDIO PUSH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
const studioClients = new Map();

app.post('/api/push-to-studio', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Studio not connected — open Roblox Studio with the plugin' });
  }
  ws.send(JSON.stringify({ type: 'inject', ...req.body }));

  await supabase.from('script_log').insert({
    user_id: req.user.id,
    script_name: req.body.scriptName || 'unnamed',
    created_at: new Date().toISOString(),
  }).catch(() => {});

  await supabase.rpc('increment_scripts_generated', { uid: req.user.id }).catch(() => {});

  // Auto-store in RAG
  if (req.body.code) {
    fetch(`http://localhost:${PORT}/api/rag/auto-store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({ code: req.body.code, name: req.body.scriptName, type: req.body.scriptType }),
    }).catch(() => {});
  }

  res.json({ ok: true });
});

app.post('/api/push-blueprint', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Studio not connected — open Roblox Studio with the plugin' });
  }
  ws.send(JSON.stringify({ type: 'blueprint', ...req.body }));

  const scriptCount = (req.body?.blueprint?.instances || [])
    .filter(i => i.instanceType === 'Script' || i.instanceType === 'LocalScript' || i.instanceType === 'ModuleScript')
    .length;

  await supabase.from('script_log').insert({
    user_id: req.user.id,
    script_name: 'Auto Build Blueprint (' + scriptCount + ' scripts)',
    created_at: new Date().toISOString(),
  }).catch(() => {});

  await supabase.rpc('increment_scripts_generated', { uid: req.user.id, amount: scriptCount || 1 }).catch(() => {});

  // Auto-store each script in RAG
  const scripts = (req.body?.blueprint?.instances || []).filter(i =>
    (i.instanceType === 'Script' || i.instanceType === 'LocalScript' || i.instanceType === 'ModuleScript') && i.source
  );
  for (const s of scripts) {
    fetch(`http://localhost:${PORT}/api/rag/auto-store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({ code: s.source, name: s.name, type: s.instanceType, description: s.description }),
    }).catch(() => {});
  }

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [usersRes, bannedRes, scriptsRes, ipBansRes] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_banned', true),
    supabase.from('script_log').select('id', { count: 'exact', head: true }),
    supabase.from('ip_bans').select('id', { count: 'exact', head: true }),
  ]);
  res.json({
    totalUsers: usersRes.count || 0,
    totalBanned: bannedRes.count || 0,
    totalScripts: scriptsRes.count || 0,
    activeConnections: studioClients.size,
    totalIpBans: ipBansRes.count || 0,
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
    await supabase.from('users').delete().eq('id', user.id);
  }
  await logAdminAction(req.user.id, 'delete', username);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET — Studio Bridge
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

  const ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'pong') {}
    } catch {}
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (studioClients.get(userId) === ws) studioClients.delete(userId);
  });

  ws.on('error', () => ws.close());
});

server.listen(PORT, () => console.log(`LuaForge server running on port ${PORT}`));

// ═══════════════════════════════════════════════
//  EXPLAIN ERROR — Feature 4
// ═══════════════════════════════════════════════
app.post('/api/explain-error', requireAuth, async (req, res) => {
  const { error: errorText } = req.body;
  if (!errorText) return res.status(400).json({ error: 'No error provided' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'AI not configured' });

  try {
    const prompt = `You are a Roblox Studio expert. A developer got this error:

"${errorText}"

Explain:
1. What caused this error (in plain English, 1-2 sentences)
2. Exactly how to fix it (be specific — line numbers, function names, what to change)
3. A corrected code snippet if applicable (keep it short)

Be direct and practical. No fluff.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'You are a Roblox Lua expert. Be concise and practical.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await groqRes.json();
    const explanation = data?.choices?.[0]?.message?.content || 'Could not generate explanation.';
    res.json({ explanation });
  } catch(e) {
    res.status(500).json({ error: 'AI request failed: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 1: LIVE DEBUGGING — MCP-style Studio DataModel queries
//  Plugin sends query results to server; AI responds with analysis.
//  POST /api/studio/query  { query }  → AI interprets live Studio data
//  POST /api/studio/query-result { userId, requestId, data } — plugin posts back
// ═══════════════════════════════════════════════════════════════════════════════
const pendingStudioQueries = new Map(); // requestId → { resolve, reject, timer }

app.post('/api/studio/query', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Studio not connected' });
  }
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const requestId = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStudioQueries.delete(requestId);
      reject(new Error('Studio query timed out after 10s'));
    }, 10000);
    pendingStudioQueries.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'query', requestId, query }));
  }).catch(e => ({ error: e.message }));

  res.json(result);
});

app.post('/api/studio/query-result', requireAuth, async (req, res) => {
  const { requestId, data } = req.body;
  const pending = pendingStudioQueries.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingStudioQueries.delete(requestId);
    pending.resolve({ data });
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 2: NATURAL LANGUAGE → ADMIN/EXECUTOR COMMANDS
//  POST /api/nlcommand { text } → { commands: ["fly", "flyspeed 5"] }
//  Uses DeepSeek/Together for best command understanding.
// ═══════════════════════════════════════════════════════════════════════════════
const NL_COMMAND_SYSTEM = `You are a Roblox admin command translator. Convert natural language into Roblox admin/executor commands.
Return ONLY a JSON array of command strings (without the ; prefix), no explanation, no markdown.
Common commands: fly, unfly, flyspeed <n>, speed <n>, jump <n>, noclip, clip, god, ungod, invisible, visible, tp <player>, bring <player>, kick <player> <reason>, ban <player>, freeze <player>, thaw <player>, sit, unsit, respawn, explode, ff, unff, heal, kill, age, admin <player>, unadmin <player>, music <id>, ambient <r> <g> <b>, time <0-24>, gravity <n>.
Example input: "make me fly really fast and be invisible"
Example output: ["fly","flyspeed 50","invisible"]`;

app.post('/api/nlcommand', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const providers = [];
  if (TOGETHER_KEY) providers.push({ url: 'https://api.together.xyz/v1/chat/completions', key: TOGETHER_KEY, model: 'deepseek-ai/DeepSeek-Coder-V2-Instruct' });
  if (CEREBRAS_KEY) providers.push({ url: 'https://api.cerebras.ai/v1/chat/completions', key: CEREBRAS_KEY, model: 'llama3.1-70b' });

  for (const p of providers) {
    try {
      const r = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
        body: JSON.stringify({
          model: p.model, max_tokens: 200, stream: false,
          messages: [{ role: 'system', content: NL_COMMAND_SYSTEM }, { role: 'user', content: text }],
        }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      let raw = data?.choices?.[0]?.message?.content || '[]';
      raw = raw.replace(/```json?|```/g, '').trim();
      const commands = JSON.parse(raw);
      return res.json({ commands: Array.isArray(commands) ? commands : [] });
    } catch {}
  }
  res.status(503).json({ error: 'No AI provider available' });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 3: BIDIRECTIONAL SYNC — read full project, apply multi-file patches
//  POST /api/sync/read   → asks plugin to send back full project tree + sources
//  POST /api/sync/result { requestId, tree } — plugin posts project snapshot
//  POST /api/sync/apply  { patches: [{name,type,location,source}] } → inject all
// ═══════════════════════════════════════════════════════════════════════════════
const pendingSyncReads = new Map();

app.post('/api/sync/read', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Studio not connected' });
  }
  const requestId = 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSyncReads.delete(requestId);
      reject(new Error('Sync read timed out after 15s'));
    }, 15000);
    pendingSyncReads.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'sync_read', requestId }));
  }).catch(e => ({ error: e.message }));

  res.json(result);
});

app.post('/api/sync/result', requireAuth, async (req, res) => {
  const { requestId, tree } = req.body;
  const pending = pendingSyncReads.get(requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSyncReads.delete(requestId);
    pending.resolve({ tree });
  }
  res.json({ ok: true });
});

app.post('/api/sync/apply', requireAuth, async (req, res) => {
  const ws = studioClients.get(String(req.user.id));
  if (!ws || ws.readyState !== 1) {
    return res.status(503).json({ error: 'Studio not connected' });
  }
  const { patches } = req.body;
  if (!Array.isArray(patches) || !patches.length) {
    return res.status(400).json({ error: 'patches array required' });
  }
  ws.send(JSON.stringify({ type: 'sync_apply', patches }));

  for (const p of patches) {
    await supabase.from('script_log').insert({
      user_id: req.user.id,
      script_name: p.name || 'sync patch',
      created_at: new Date().toISOString(),
    }).catch(() => {});
    if (p.source) {
      fetch(`http://localhost:${PORT}/api/rag/auto-store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
        body: JSON.stringify({ code: p.source, name: p.name, type: p.type }),
      }).catch(() => {});
    }
  }

  await supabase.rpc('increment_scripts_generated', { uid: req.user.id, amount: patches.length }).catch(() => {});
  res.json({ ok: true, patched: patches.length });
});
