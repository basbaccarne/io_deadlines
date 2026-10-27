// The Supabase version of server.js's /api routes, for the dashboard on the UGent webshare
// (which can't fetch feeds itself). Routes, request and response shapes match server.js:
//   GET  /deadlines/presets
//   POST /deadlines/fetch        { urls: [{ url, name? }] }
//   GET  /deadlines/estimates?voter=…
//   POST /deadlines/estimates    { taskId, voterId, phase, bucket }
// Saved custom feed lists (/api/calendars) live in the browser instead.
import { parseICS } from './ics.ts';

export const PHASES = ['before', 'after'];
export const BUCKET_COUNT = 5; // <1h, 1–3h, 3–8h, 8–20h, 20h+ (labels live in index.html)
const MAX_FEEDS = 40;
const MAX_FEED_BYTES = 5_000_000;

const ALLOWED_ORIGINS: (string | RegExp)[] = [
  'https://industrialdesign.ugent.be',
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

export interface Estimate { taskId: string; voterId: string; phase: string; bucket: number | null }
export interface SummaryRow { task_id: string; phase: string; bucket: number; n: number; mine: boolean }
export interface Store {
  save(e: Estimate): Promise<void>;
  rows(voterId: string): Promise<SummaryRow[]>;
}

interface Options {
  presets: { name: string; urls: string[] }[];
  store: Store;
  fetchText?: (url: string) => Promise<string>;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.some(o => typeof o === 'string' ? o === origin : o.test(origin));
  if (!allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// → { taskId: { before: { counts: [..5], mine: bucket|null }, after: {...} } }
export function buildSummary(rows: SummaryRow[]) {
  const out: Record<string, Record<string, { counts: number[]; mine: number | null }>> = {};
  rows.forEach(r => {
    const task = out[r.task_id] ||= {};
    const ph = task[r.phase] ||= { counts: Array(BUCKET_COUNT).fill(0), mine: null };
    ph.counts[r.bucket] = r.n;
    if (r.mine) ph.mine = r.bucket;
  });
  return out;
}

export function validEstimate(e: any): e is Estimate {
  return !!e && typeof e.taskId === 'string' && e.taskId.length > 0 && e.taskId.length <= 500
    && typeof e.voterId === 'string' && /^[\w-]{8,64}$/.test(e.voterId)
    && PHASES.includes(e.phase)
    && (e.bucket === null || (Number.isInteger(e.bucket) && e.bucket >= 0 && e.bucket < BUCKET_COUNT));
}

async function defaultFetchText(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'ICS-Dashboard/1.0', Accept: 'text/calendar, */*' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error((err as Error).name === 'TimeoutError' ? 'Request timed out' : (err as Error).message);
  }
  if (res.status !== 200) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('Feed too large');
  return text;
}

export function createHandler({ presets, store, fetchText = defaultFetchText }: Options) {
  return async function handler(req: Request): Promise<Response> {
    const cors = corsHeaders(req.headers.get('Origin'));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/deadlines/, '').replace(/\/+$/, '');
    const body = async () => { try { return await req.json(); } catch { return undefined; } };

    try {
      if (route === '/presets' && req.method === 'GET') return json(200, presets);

      if (route === '/estimates' && req.method === 'GET') {
        return json(200, buildSummary(await store.rows(url.searchParams.get('voter') || '')));
      }
      if (route === '/estimates' && req.method === 'POST') {
        const e = await body();
        if (!validEstimate(e)) return json(400, { error: 'Invalid estimate' });
        await store.save(e);
        return json(200, { ok: true });
      }

      if (route === '/fetch' && req.method === 'POST') {
        const urls = (await body())?.urls;
        if (!Array.isArray(urls) || !urls.length) return json(400, { error: 'Provide an array of URLs' });
        if (urls.length > MAX_FEEDS) return json(400, { error: `At most ${MAX_FEEDS} URLs` });
        // In parallel (server.js fetches one by one); results keep the order of the request
        const results = await Promise.all(urls.map(async (u: any, i: number) => {
          const { url, name } = typeof u === 'string' ? { url: u, name: null } : (u || {});
          const fallback = name || `Calendar ${i + 1}`;
          try {
            if (typeof url !== 'string') throw new Error('Missing URL');
            const events = parseICS(await fetchText(url), fallback);
            return { url, name: events.calName, events: events.items, error: null };
          } catch (err) {
            return { url, name: fallback, events: [], error: (err as Error).message };
          }
        }));
        return json(200, results);
      }

      return json(404, { error: 'Not found' });
    } catch (err) {
      return json(500, { error: (err as Error).message });
    }
  };
}
