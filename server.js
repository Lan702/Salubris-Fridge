/**
 * 海尔生物超低温冰箱样品管理 - 团队协作服务器 (带用户认证)
 * Node.js + Express + SQLite + JWT + WebSocket
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'freezer_jwt_secret_2024_change_me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';
const PORT = process.env.PORT || 8089;

// ── SQLite ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'freezer.db'));
db.pragma('journal_mode = WAL');

// Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Samples table — add user_id foreign key
db.exec(`
  CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    person TEXT DEFAULT '',
    project TEXT NOT NULL,
    layer INTEGER NOT NULL,
    col INTEGER DEFAULT 0,
    row_val INTEGER DEFAULT 0,
    positions TEXT NOT NULL DEFAULT '[]',
    status TEXT DEFAULT 'keep',
    remark TEXT DEFAULT '',
    user_id INTEGER,
    created_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add user_id column if upgrading from old schema
try { db.exec('ALTER TABLE samples ADD COLUMN user_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE samples ADD COLUMN created_by TEXT DEFAULT ""'); } catch(e) {}

// Seed admin user if no users exist
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?,?,?,?)')
    .run('admin', hash, '管理员', 'admin');
  console.log('👤 已创建管理员账号: admin / admin123');
}

// Seed initial sample data if empty
const sampleCount = db.prepare('SELECT COUNT(*) as n FROM samples').get().n;
if (sampleCount === 0) {
  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  const stmt = db.prepare(
    'INSERT INTO samples (id, date, person, project, layer, col, row_val, positions, status, remark, user_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const init = [
    [1, '2024-03-15', '张三', 'P0001', 2, 1, 1, '[1,2,3]', 'keep', '', adminUser?.id || 1, '管理员'],
    [2, '2024-05-20', '李四', 'P0002', 2, 1, 2, '[1,2,3,4,5]', 'keep', '', adminUser?.id || 1, '管理员'],
    [3, '2024-06-10', '王五', 'P0003', 2, 4, 3, '[1,2,3,4,5]', 'keep', '', adminUser?.id || 1, '管理员'],
    [4, '2024-07-01', '王五', 'P0004', 3, 3, 4, '[1,2]', 'keep', '', adminUser?.id || 1, '管理员'],
    [5, '2024-08-15', '赵六', 'P0005', 4, 6, 5, '[1]', 'clean', '', adminUser?.id || 1, '管理员'],
  ];
  init.forEach(r => stmt.run(...r));
  console.log('📦 已初始化 5 条示例数据');
}

// ── Auth Middleware ─────────────────────────────────────
function authMiddleware(req, res, next) {
  // Allow OPTIONS preflight
  if (req.method === 'OPTIONS') return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// Get display name from user_id
function getCreatorName(userId) {
  if (!userId) return '';
  const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  return u ? u.display_name : '';
}

// ── Middleware ──────────────────────────────────────────
app.use(express.json());

// ── Auth API (no auth required) ─────────────────────────

// Register
app.post('/api/auth/register', (req, res) => {
  const { username, password, display_name, verify_q } = req.body;
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: '用户名、密码和显示名称不能为空' });
  }
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: '用户名至少3位，密码至少6位' });
  }
  if (verify_q !== 'SX') {
    return res.status(400).json({ error: '验证问答错误' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: '用户名已被注册' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, display_name) VALUES (?,?,?)')
    .run(username, hash, display_name);

  const user = { id: result.lastInsertRowid, username, display_name, role: 'user' };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ token, user });
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const payload = { id: user.id, username: user.username, display_name: user.display_name, role: user.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ token, user: payload });
});

// Get current user info
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ── Protected API ───────────────────────────────────────

// GET all users (for admin/user list)
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, created_at FROM users').all();
  res.json(users);
});

// DELETE user (admin only)
app.delete('/api/users/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可删除用户' });
  }
  const id = parseInt(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true, message: `已删除用户 ${user.display_name}` });
});

// GET all samples (all users can see all samples)
app.get('/api/samples', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM samples ORDER BY id').all();
  res.json(rows.map(r => ({
    ...r,
    row: r.row_val,
    positions: JSON.parse(r.positions),
    creator_name: getCreatorName(r.user_id) || r.created_by || ''
  })));
});

// POST new sample
app.post('/api/samples', authMiddleware, (req, res) => {
  const { date, person, project, layer, col, row, positions, status, remark } = req.body;
  const result = db.prepare(
    'INSERT INTO samples (date, person, project, layer, col, row_val, positions, status, remark, user_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(date, person || '', project, layer, col || 0, row || 0, JSON.stringify(positions), status || 'keep', remark || '',
       req.user.id, req.user.display_name);

  const sample = {
    id: result.lastInsertRowid, date, person, project, layer,
    col: col || 0, row: row || 0, positions, status: status || 'keep',
    remark: remark || '', user_id: req.user.id, created_by: req.user.display_name,
    creator_name: req.user.display_name
  };
  broadcast({ type: 'sample_added', sample });
  res.json(sample);
});

// PUT update sample
app.put('/api/samples/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const { status, remark, positions } = req.body;
  const updates = [];
  const vals = [];
  if (status !== undefined) { updates.push('status = ?'); vals.push(status); }
  if (remark !== undefined) { updates.push('remark = ?'); vals.push(remark); }
  if (positions !== undefined) { updates.push('positions = ?'); vals.push(JSON.stringify(positions)); }
  if (updates.length === 0) return res.json({ success: false, message: 'no fields to update' });
  vals.push(id);
  db.prepare(`UPDATE samples SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  broadcast({ type: 'sample_updated', id, status, remark, positions, updated_by: req.user.display_name });
  res.json({ success: true });
});

// DELETE sample
app.delete('/api/samples/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM samples WHERE id = ?').run(id);
  broadcast({ type: 'sample_deleted', id, deleted_by: req.user.display_name });
  res.json({ success: true });
});

// DELETE all samples
app.delete('/api/samples', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM samples').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='samples'").run();
  broadcast({ type: 'samples_cleared', cleared_by: req.user.display_name });
  res.json({ success: true });
});

// ── Static files (serve frontend) ───────────────────────
app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/freezer_manager.html'));
app.get('/index.html', (req, res) => res.redirect('/freezer_manager.html'));

// ── CORS headers for development ────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// ── WebSocket ───────────────────────────────────────────
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

// ── Start ───────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🧊  海尔生物超低温冰箱样品管理 — 团队协作版');
  console.log('══════════════════════════════════════════════');
  console.log(`  本地访问:  http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  局域网访问: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`  API 基础:   http://localhost:${PORT}/api`);
  console.log(`  管理员账号: admin / admin123`);
  console.log('══════════════════════════════════════════════');
  console.log('');
});
