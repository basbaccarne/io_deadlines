const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CALENDARS_FILE = path.join(__dirname, 'calendars.json');
const PRESETS_FILE = path.join(__dirname, 'presets.yaml');
const ESTIMATES_FILE = path.join(__dirname, 'estimates.json');
const PHASES = ['before', 'after'];
const BUCKET_COUNT = 5; // <1h, 1–3h, 3–8h, 8–20h, 20h+ (labels live in index.html)

// ── Effort estimates: Postgres when DATABASE_URL is set, else a local JSON file ──
const estimates = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore(ESTIMATES_FILE);

function pgStore(connectionString) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new Pool({ connectionString, ssl: local ? false : { rejectUnauthorized: false } });
  // Poolers such as Supabase's drop idle connections; without this handler that would crash the server
  pool.on('error', err => console.error('Postgres pool error:', err.message));

  // Create the table on first use; retry on the next request if the database was unreachable
  let tableReady = null;
  const ready = () => tableReady ||= pool.query(`
    CREATE TABLE IF NOT EXISTS effort_estimates (
      task_id    TEXT NOT NULL,
      voter_id   TEXT NOT NULL,
      phase      TEXT NOT NULL CHECK (phase IN ('before', 'after')),
      bucket     SMALLINT NOT NULL CHECK (bucket BETWEEN 0 AND ${BUCKET_COUNT - 1}),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, voter_id, phase)
    );
    -- Supabase exposes public tables through its REST API; with RLS on and no policies only this server (the owner) can access it
    ALTER TABLE effort_estimates ENABLE ROW LEVEL SECURITY;
  `).catch(err => { tableReady = null; throw err; });

  ready().then(
    () => console.log('   Effort estimates: Postgres connected'),
    err => console.error('   Effort estimates: Postgres unreachable:', err.message));

  return {
    async save({ taskId, voterId, phase, bucket }) {
      await ready();
      if (bucket === null) {
        await pool.query('DELETE FROM effort_estimates WHERE task_id=$1 AND voter_id=$2 AND phase=$3', [taskId, voterId, phase]);
      } else {
        await pool.query(`INSERT INTO effort_estimates (task_id, voter_id, phase, bucket) VALUES ($1, $2, $3, $4)
          ON CONFLICT (task_id, voter_id, phase) DO UPDATE SET bucket = EXCLUDED.bucket, updated_at = now()`,
          [taskId, voterId, phase, bucket]);
      }
    },
    async summary(voterId) {
      await ready();
      const { rows } = await pool.query(`SELECT task_id, phase, bucket, count(*)::int AS n, bool_or(voter_id = $1) AS mine
        FROM effort_estimates GROUP BY task_id, phase, bucket`, [voterId]);
      return buildSummary(rows);
    },
  };
}

function fileStore(file) {
  console.log('   Effort estimates: local file (set DATABASE_URL to use Postgres)');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  return {
    async save({ taskId, voterId, phase, bucket }) {
      const rows = load().filter(r => !(r.taskId === taskId && r.voterId === voterId && r.phase === phase));
      if (bucket !== null) rows.push({ taskId, voterId, phase, bucket });
      fs.writeFileSync(file, JSON.stringify(rows));
    },
    async summary(voterId) {
      const groups = new Map();
      load().forEach(r => {
        const k = JSON.stringify([r.taskId, r.phase, r.bucket]);
        const g = groups.get(k) || { task_id: r.taskId, phase: r.phase, bucket: r.bucket, n: 0, mine: false };
        g.n++; g.mine ||= r.voterId === voterId;
        groups.set(k, g);
      });
      return buildSummary([...groups.values()]);
    },
  };
}

// → { taskId: { before: { counts: [..5], mine: bucket|null }, after: {...} } }
function buildSummary(rows) {
  const out = {};
  rows.forEach(r => {
    const task = out[r.task_id] ||= {};
    const ph = task[r.phase] ||= { counts: Array(BUCKET_COUNT).fill(0), mine: null };
    ph.counts[r.bucket] = r.n;
    if (r.mine) ph.mine = r.bucket;
  });
  return out;
}

function validEstimate({ taskId, voterId, phase, bucket }) {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 500
    && typeof voterId === 'string' && /^[\w-]{8,64}$/.test(voterId)
    && PHASES.includes(phase)
    && (bucket === null || (Number.isInteger(bucket) && bucket >= 0 && bucket < BUCKET_COUNT));
}

function loadCalendars() {
  try { return JSON.parse(fs.readFileSync(CALENDARS_FILE, 'utf8')); } catch { return []; }
}

// Minimal parser for presets.yaml: top-level "name:" keys, each followed by "- url" items.
function loadPresets() {
  let text;
  try { text = fs.readFileSync(PRESETS_FILE, 'utf8'); } catch { return []; }
  const presets = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const key = line.match(/^(\S[^:]*):\s*$/);
    const item = line.match(/^\s*-\s+(.+)$/);
    if (key) {
      current = { name: key[1].trim().replace(/^["']|["']$/g, ''), urls: [] };
      presets.push(current);
    } else if (item && current) {
      current.urls.push(item[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return presets;
}

function saveCalendars(cals) {
  fs.writeFileSync(CALENDARS_FILE, JSON.stringify(cals, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost`);

  try {
    if (pathname === '/api/calendars' && req.method === 'GET') {
      return json(res, 200, loadCalendars());
    }
    if (pathname === '/api/presets' && req.method === 'GET') {
      return json(res, 200, loadPresets());
    }
    if (pathname === '/api/estimates' && req.method === 'GET') {
      const voterId = new URL(req.url, 'http://localhost').searchParams.get('voter') || '';
      return json(res, 200, await estimates.summary(voterId));
    }
    if (pathname === '/api/estimates' && req.method === 'POST') {
      const body = await readBody(req);
      if (!validEstimate(body)) return json(res, 400, { error: 'Invalid estimate' });
      await estimates.save(body);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/calendars' && req.method === 'POST') {
      const { calendars } = await readBody(req);
      if (!Array.isArray(calendars)) return json(res, 400, { error: 'Expected { calendars: [] }' });
      saveCalendars(calendars);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/fetch' && req.method === 'POST') {
      const { urls } = await readBody(req);
      if (!Array.isArray(urls) || !urls.length) return json(res, 400, { error: 'Provide an array of URLs' });
      const results = [];
      for (let i = 0; i < urls.length; i++) {
        const { url, name } = typeof urls[i] === 'string' ? { url: urls[i], name: null } : urls[i];
        try {
          const text = await fetchUrl(url);
          const events = parseICS(text, name || `Calendar ${i + 1}`);
          results.push({ url, name: events.calName, events: events.items, error: null });
        } catch (err) {
          results.push({ url, name: name || `Calendar ${i + 1}`, events: [], error: err.message });
        }
      }
      return json(res, 200, results);
    }
    serveFile(res, path.join(__dirname, 'index.html'));
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}).listen(PORT, () => {
  console.log(`\n   ICS Deadline Dashboard`);
  console.log(`   Running at http://localhost:${PORT}\n`);
});

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'ICS-Dashboard/1.0', 'Accept': 'text/calendar, */*' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, redirectCount + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function parseICS(text, fallbackName) {
  text = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const calNameMatch = text.match(/X-WR-CALNAME[^:]*:([^\r\n]+)/i);
  const calName = calNameMatch ? calNameMatch[1].trim() : fallbackName;

  const items = [];
  text.split('BEGIN:VEVENT').slice(1).forEach(block => {
    const get = key => {
      const m = block.match(new RegExp(key + '[^:]*:([^\\r\\n]+)', 'i'));
      return m ? m[1].replace(/\\n/g, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').trim() : '';
    };

    const rawDate = get('DTSTART') || get('DUE') || get('DTEND') || '';
    if (!rawDate) return;
    const date = parseICSDate(rawDate);
    if (!date || isNaN(date.getTime())) return;

    const rawEnd = get('DTEND');
    const endDate = rawEnd ? parseICSDate(rawEnd) : null;
    const allDay = /^\d{8}$/.test(rawDate.replace(/^.*:/, '').trim());

    const summary = get('SUMMARY') || '(no title)';
    const uid = (block.match(/(?:^|\n)UID[^:]*:([^\r\n]+)/) || [])[1]?.trim();

    items.push({
      id: uid || `${calName}|${summary}|${date.toISOString()}`,
      summary,
      description: get('DESCRIPTION') || null,
      location: get('LOCATION') || null,
      date: date.toISOString(),
      endDate: endDate ? endDate.toISOString() : null,
      allDay,
      timeStr: allDay ? null : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    });
  });

  items.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { calName, items };
}

function parseICSDate(s) {
  s = s.replace(/^[^:]*:/, '').trim();
  if (/^\d{8}$/.test(s))
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  if (/^\d{8}T\d{6}Z?$/.test(s)) {
    const [y, mo, d, h, mi, sec] = [s.slice(0,4), s.slice(4,6), s.slice(6,8), s.slice(9,11), s.slice(11,13), s.slice(13,15)];
    return s.endsWith('Z')
      ? new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`)
      : new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}`);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
