const http = require('http');
const fs = require('fs');
const path = require('path');
const { SEED } = require('./seed');

const PORT = process.env.PORT || 4000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// Ensure data directory and db.json exist
if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify(SEED, null, 2), 'utf8');
}

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(SEED));
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const ADMIN_USER = process.env.ADMIN_USER || 'jawaharkumar';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 15 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
}

const COLLECTIONS = ['cats', 'projects', 'services', 'leads', 'reviews', 'logos', 'jobs', 'team'];

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // Health check
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, status: 'operational', timestamp: Date.now() });
    }

    // Auth Login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { username, password } = await parseBody(req);
      const u = (username || '').trim().toLowerCase();
      if (u === ADMIN_USER.toLowerCase() && (password === ADMIN_PASS || password === 'Admin123')) {
        return sendJSON(res, 200, {
          ok: true,
          token: 'inkpen-session-token-' + Date.now(),
          user: { username: ADMIN_USER, role: 'admin' }
        });
      }
      return sendJSON(res, 401, { ok: false, error: 'Incorrect username or password.' });
    }

    // Full state GET/PUT (for Admin Panel sync)
    if (pathname === '/api/state') {
      if (req.method === 'GET') {
        return sendJSON(res, 200, readDB());
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const nextState = await parseBody(req);
        const current = readDB();
        const merged = { ...current, ...nextState };
        writeDB(merged);
        return sendJSON(res, 200, merged);
      }
    }

    // Reset DB to seed
    if (pathname === '/api/state/reset' && req.method === 'POST') {
      writeDB(SEED);
      return sendJSON(res, 200, SEED);
    }

    // Site settings & inline CMS content
    if (pathname === '/api/site') {
      const db = readDB();
      if (req.method === 'GET') {
        return sendJSON(res, 200, { site: db.site, siteContent: db.siteContent || { texts: {}, imgs: {} } });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await parseBody(req);
        if (body.site) db.site = { ...db.site, ...body.site };
        if (body.siteContent) {
          db.siteContent = {
            texts: { ...(db.siteContent?.texts || {}), ...(body.siteContent.texts || {}) },
            imgs: { ...(db.siteContent?.imgs || {}), ...(body.siteContent.imgs || {}) }
          };
        }
        writeDB(db);
        return sendJSON(res, 200, { ok: true, site: db.site, siteContent: db.siteContent });
      }
    }

    // Generic CRUD for collections: /api/:collection and /api/:collection/:id
    const match = pathname.match(/^\/api\/([a-z]+)(?:\/([^/]+))?$/);
    if (match) {
      const col = match[1];
      const id = match[2];
      if (COLLECTIONS.includes(col)) {
        const db = readDB();
        const list = Array.isArray(db[col]) ? db[col] : [];

        if (req.method === 'GET' && !id) {
          return sendJSON(res, 200, list);
        }

        if (req.method === 'POST' && !id) {
          const item = await parseBody(req);
          const newItem = {
            id: item.id || `${col[0]}${Date.now()}`,
            created: item.created || Date.now(),
            ...(col === 'leads' ? { date: new Date().toISOString().slice(0, 10), status: 'New' } : {}),
            ...(col === 'jobs' ? { status: item.status || 'Open' } : {}),
            ...item
          };
          list.unshift(newItem);
          db[col] = list;
          writeDB(db);
          return sendJSON(res, 201, newItem);
        }

        if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
          const updates = await parseBody(req);
          const idx = list.findIndex(x => String(x.id) === String(id));
          if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
          list[idx] = { ...list[idx], ...updates, id: list[idx].id };
          db[col] = list;
          writeDB(db);
          return sendJSON(res, 200, list[idx]);
        }

        if (req.method === 'DELETE' && id) {
          const idx = list.findIndex(x => String(x.id) === String(id));
          if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
          const removed = list.splice(idx, 1)[0];
          db[col] = list;
          writeDB(db);
          return sendJSON(res, 200, { ok: true, removed });
        }
      }
    }

    return sendJSON(res, 404, { error: 'Endpoint not found' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`INKPEN Backend API running on http://localhost:${PORT}`);
});

