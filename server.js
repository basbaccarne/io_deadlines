const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CALENDARS_FILE = path.join(__dirname, 'calendars.json');

function loadCalendars() {
  try { return JSON.parse(fs.readFileSync(CALENDARS_FILE, 'utf8')); } catch { return []; }
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

    items.push({
      summary: get('SUMMARY') || '(no title)',
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
