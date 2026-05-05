/**
 * LuaForge Backend — Railway Server
 * Node.js + Express + WebSocket + MongoDB + JWT
 * 
 * Deploy to Railway. Set these environment variables:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   MONGODB_URI=mongodb+srv://...
 *   JWT_SECRET=some_long_random_string_here
 *   ADMIN_USERNAME=your_admin_username
 *   PORT=3000 (Railway sets this automatically)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'luaforge_dev_secret_change_this';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim();

// ═══════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════
app.use(cors({
  origin: '*', // Lock this to your Railway domain in production
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));

// ═══════════════════════════════════════════════
//  MONGODB SCHEMAS
// ═══════════════════════════════════════════════
mongoose.connect(MONGODB_URI).then(() => {
  console.log('[DB] MongoDB connected');
}).catch(err => {
  console.error('[DB] Connection failed:', err.message);
});

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 24 },
  passwordHash: String,
  isAdmin: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  banReason: { type: String, default: '' },
  ipBanned: { type: [String], default: [] }, // list of banned IPs for this user
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  sessionToken: { type: String, default: null }, // tracks current active session
  scriptsGenerated: { type: Number, default: 0 },
  messagesCount: { type: Number, default: 0 },
});

const ScriptHistorySchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  username: String,
  type: String, // 'codegen' | 'explain' | 'debug' | 'chat' | 'ideas'
  prompt: String,
  result: String,
  createdAt: { type: Date, default: Date.now },
});

const BanLogSchema = new mongoose.Schema({
  targetUsername: String,
  adminUsername: String,
  action: String, // 'ban' | 'unban' | 'ip_ban' | 'kick' | 'reset_password'
  reason: String,
  ip: String,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);
const ScriptHistory = mongoose.model('ScriptHistory', ScriptHistorySchema);
const BanLog = mongoose.model('BanLog', BanLogSchema);

// ═══════════════════════════════════════════════
//  AUTH HELPERS
// ═══════════════════════════════════════════════
function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET); // verifies signature + expiry
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned', reason: user.banReason });
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function adminMiddleware(req, res, next) {
  await authMiddleware(req, res, async () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ═══════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3–24 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers, underscores only' });

  const ip = getClientIp(req);

  try {
    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const passwordHash = await bcrypt.hash(password, 12);
    const isAdmin = username.toLowerCase().trim() === ADMIN_USERNAME;
    const user = new User({ username: username.toLowerCase(), passwordHash, isAdmin });
    const token = signToken(user._id);
    await user.save();

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
      }
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const ip = getClientIp(req);

  try {
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned', reason: user.banReason });

    // Check IP ban
    if (user.ipBanned.includes(ip)) {
      return res.status(403).json({ error: 'Your IP is banned from this account' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user._id);
    user.lastSeen = new Date();
    await user.save();

    // Kick existing WebSocket connections for this user
    kickUserWs(user._id.toString());

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  res.json({ ok: true }); // JWT is stateless — client just drops the token
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({
    id: req.user._id,
    username: req.user.username,
    isAdmin: req.user.isAdmin,
    createdAt: req.user.createdAt,
    lastSeen: req.user.lastSeen,
    scriptsGenerated: req.user.scriptsGenerated,
    messagesCount: req.user.messagesCount,
  });
});

// ═══════════════════════════════════════════════
//  ANTHROPIC PROXY
// ═══════════════════════════════════════════════
app.post('/api/claude', authMiddleware, async (req, res) => {
  const { messages, system, stream, max_tokens, type, prompt } = req.body;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  // Update user stats — use updateOne so sessionToken is NEVER touched
  await User.updateOne(
    { _id: req.user._id },
    { $set: { lastSeen: new Date() }, $inc: type === 'chat' ? { messagesCount: 1 } : { scriptsGenerated: 1 } }
  );
  // Save to history (non-blocking)
  if (type && prompt) {
    ScriptHistory.create({
      userId: req.user._id,
      username: req.user.username,
      type,
      prompt: prompt.slice(0, 1000),
      result: '', // updated async isn't practical with streaming — skip result storage or store after
    }).catch(() => {});
  }

  try {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 1500,
      system,
      messages,
      stream: !!stream,
    };

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.json().catch(() => ({}));
      return res.status(anthropicRes.status).json({ error: errBody?.error?.message || 'Anthropic error' });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      anthropicRes.body.pipe(res);
    } else {
      const data = await anthropicRes.json();
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ error: 'Proxy request failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════
//  SCRIPT HISTORY
// ═══════════════════════════════════════════════
app.get('/api/history', authMiddleware, async (req, res) => {
  const history = await ScriptHistory.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json(history);
});

// ═══════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════

// GET /api/admin/users
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const users = await User.find({}, '-passwordHash -sessionToken').sort({ createdAt: -1 }).lean();
  res.json(users);
});

// GET /api/admin/logs
app.get('/api/admin/logs', adminMiddleware, async (req, res) => {
  const logs = await BanLog.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json(logs);
});

// GET /api/admin/stats
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const [totalUsers, totalBanned, totalScripts, totalMessages] = await Promise.all([
    User.countDocuments({ isAdmin: false }),
    User.countDocuments({ isBanned: true }),
    ScriptHistory.countDocuments({ type: { $ne: 'chat' } }),
    ScriptHistory.countDocuments({ type: 'chat' }),
  ]);

  const activeWsCount = [...wsClients.values()].filter(c => c.readyState === WebSocket.OPEN).length;

  res.json({
    totalUsers,
    totalBanned,
    totalScripts,
    totalMessages,
    activeConnections: activeWsCount,
  });
});

// POST /api/admin/ban
app.post('/api/admin/ban', adminMiddleware, async (req, res) => {
  const { username, reason } = req.body;
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isAdmin) return res.status(403).json({ error: 'Cannot ban admin' });

  user.isBanned = true;
  user.banReason = reason || 'Banned by admin';
  await user.save();

  kickUserWs(user._id.toString());

  await BanLog.create({
    targetUsername: username,
    adminUsername: req.user.username,
    action: 'ban',
    reason: reason || '',
  });

  res.json({ ok: true });
});

// POST /api/admin/unban
app.post('/api/admin/unban', adminMiddleware, async (req, res) => {
  const { username } = req.body;
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.isBanned = false;
  user.banReason = '';
  await user.save();

  await BanLog.create({
    targetUsername: username,
    adminUsername: req.user.username,
    action: 'unban',
  });

  res.json({ ok: true });
});

// POST /api/admin/ip-ban
app.post('/api/admin/ip-ban', adminMiddleware, async (req, res) => {
  const { username, ip } = req.body;
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.ipBanned.includes(ip)) {
    user.ipBanned.push(ip);
    await user.save();
  }

  kickUserWs(user._id.toString());

  await BanLog.create({
    targetUsername: username,
    adminUsername: req.user.username,
    action: 'ip_ban',
    ip,
  });

  res.json({ ok: true });
});

// POST /api/admin/kick
app.post('/api/admin/kick', adminMiddleware, async (req, res) => {
  const { username } = req.body;
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });

  await user.save();

  kickUserWs(user._id.toString());

  await BanLog.create({
    targetUsername: username,
    adminUsername: req.user.username,
    action: 'kick',
  });

  res.json({ ok: true });
});

// POST /api/admin/reset-password
app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 chars' });
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();

  kickUserWs(user._id.toString());

  await BanLog.create({
    targetUsername: username,
    adminUsername: req.user.username,
    action: 'reset_password',
  });

  res.json({ ok: true });
});

// DELETE /api/admin/delete-user
app.delete('/api/admin/delete-user', adminMiddleware, async (req, res) => {
  const { username } = req.body;
  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.isAdmin) return res.status(403).json({ error: 'Cannot delete admin' });

  kickUserWs(user._id.toString());
  await User.deleteOne({ _id: user._id });
  await ScriptHistory.deleteMany({ userId: user._id });

  await BanLog.create({
    targetUsername: username,
    adminUsername: req.user.username,
    action: 'delete',
  });

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
//  WEBSOCKET (Studio Plugin Bridge)
// ═══════════════════════════════════════════════
// Map: userId -> WebSocket connection
const wsClients = new Map();

function kickUserWs(userId) {
  const ws = wsClients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'kicked', message: 'You have been disconnected by the server.' }));
    ws.close();
    wsClients.delete(userId);
  }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(1008, 'No token');
    return;
  }

  let user;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    user = await User.findById(decoded.userId);
    if (!user || user.isBanned) {
      ws.close(1008, 'Unauthorized');
      return;
    }
  } catch {
    ws.close(1008, 'Invalid token');
    return;
  }

  const userId = user._id.toString();

  // Close old WS if exists
  if (wsClients.has(userId)) {
    const old = wsClients.get(userId);
    if (old.readyState === WebSocket.OPEN) old.close();
  }

  wsClients.set(userId, ws);
  console.log(`[WS] ${user.username} connected`);

  ws.send(JSON.stringify({ type: 'connected', message: `LuaForge Studio connected as ${user.username}` }));

  ws.on('message', (data) => {
    // Studio plugin can send pings or acks
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  });

  ws.on('close', () => {
    if (wsClients.get(userId) === ws) wsClients.delete(userId);
    console.log(`[WS] ${user.username} disconnected`);
  });
});

// Push generated script to Studio plugin via WebSocket
app.post('/api/push-to-studio', authMiddleware, async (req, res) => {
  const { code, scriptName } = req.body;
  const ws = wsClients.get(req.user._id.toString());

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: 'Studio plugin not connected. Open the LuaForge plugin in Studio and connect.' });
  }

  ws.send(JSON.stringify({
    type: 'inject_script',
    scriptName: scriptName || 'LuaForgeScript',
    code,
  }));

  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
//  ONE-TIME ADMIN FIX (run once then ignore)
// ═══════════════════════════════════════════════
// GET /api/fix-admins?secret=YOUR_JWT_SECRET
// Call this once from browser to strip admin from everyone except ADMIN_USERNAME
app.get('/api/fix-admins', async (req, res) => {
  const { secret } = req.query;
  if (secret !== JWT_SECRET) return res.status(403).json({ error: 'Wrong secret' });

  // Strip admin from everyone who is NOT the admin username
  const stripped = await User.updateMany(
    { username: { $ne: ADMIN_USERNAME }, isAdmin: true },
    { $set: { isAdmin: false } }
  );

  // Make sure the real admin IS admin
  const promoted = await User.updateOne(
    { username: ADMIN_USERNAME },
    { $set: { isAdmin: true } }
  );

  res.json({
    ok: true,
    strippedAdminFrom: stripped.modifiedCount,
    adminUsername: ADMIN_USERNAME,
    adminPromoted: promoted.modifiedCount,
  });
});

// ═══════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ═══════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`[LuaForge] Server running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn('[WARN] ANTHROPIC_API_KEY not set!');
  if (!MONGODB_URI) console.warn('[WARN] MONGODB_URI not set!');
});
