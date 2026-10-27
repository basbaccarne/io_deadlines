# Hosting: Render and the UGent webshare

The dashboard runs in two places from the same `index.html`:

| | Render | UGent webshare |
|---|---|---|
| URL | https://io-deadlines.onrender.com | https://industrialdesign.ugent.be/deadlines/ |
| Page | served by `server.js` | `index.html` copied to the share by hand |
| Feeds, presets, estimates | `/api/…` in `server.js` | Supabase Edge Function `deadlines` |
| Estimates database | Supabase Postgres via `DATABASE_URL` | the same table, through the function |
| Custom feed list | `localStorage` in the visitor's browser | the same |
| Updating | push to GitHub (Render redeploys) | `npm run deploy:fn`, then copy `index.html` |

`index.html` picks its backend at startup: on `industrialdesign.ugent.be`, or with `?supabase`
in the URL, it calls the function; everywhere else it calls `/api`. Both backends return the same
JSON, so the rest of the page doesn't know which one it talks to.

## Why the webshare needs Supabase

A page can't fetch the Ufora feeds itself: Ufora sends no CORS headers, so the browser blocks
cross-site reads. Something server-side has to fetch them. On Render that's `server.js`; the
webshare can't do it (see below), so a Supabase Edge Function does it instead.

## What the webshare can and can't do

Tested October 2026 with temporary PHP probe pages.

**Works**

- Static files (HTML, JS, images, audio). No Content-Security-Policy or similar headers are sent,
  so pages can call other domains from the browser (this is how the dashboard reaches Supabase).
- PHP 8.4 on Apache, including reading JSON request bodies.
- `.htaccess` with `mod_rewrite` rules.
- PHP can write files into a subfolder; such a folder is not publicly listable.
- SQLite through PDO.

**Doesn't work**

- **No outgoing requests from the server.** All outbound traffic goes through a UGent filtering
  proxy that denies it: plain HTTP gets "Access Denied", HTTPS fails at the TLS handshake. So
  PHP can't fetch Ufora feeds or call any external API. Changing this would need UGent ICT to
  allow specific destinations.
- `curl_exec` and the shell functions (`exec`, `system`, …) are disabled; calling one stops the
  script without an error message.
- No Postgres driver for PHP.

**Practical**

- Copy files onto the mounted share; there's no automatic deploy. Don't overwrite the share's own
  `.htaccess` and `.default.html`.
- PHP errors aren't shown on the page; they go to the error log on the share.
- Anything that needs external data has to come from the visitor's browser, from a service that
  allows CORS (like the Supabase function).

## The Supabase function

`supabase/functions/deadlines/` mirrors `server.js`'s routes:

| Route | Does |
|---|---|
| `GET /presets` | the sets from `presets.yaml` |
| `POST /fetch` `{ urls: [{ url, name? }] }` | fetches and parses the feeds (in parallel) |
| `GET /estimates?voter=…` | vote counts per deadline, plus this visitor's own votes |
| `POST /estimates` `{ taskId, voterId, phase, bucket }` | saves, changes or (with `bucket: null`) removes a vote |

- `ics.ts` is a copy of `server.js`'s ICS and presets parsers. Change both together.
- The function can't read files outside its folder, so `scripts/build-presets.mjs` copies
  `presets.yaml` into it (`presets.generated.ts`, not committed) on every `npm run deploy:fn`.
- It connects to the database as the table owner, so row-level security (on, with no policies)
  keeps the public API keys out of the table while the function still has access.
- CORS is limited to the webshare and `localhost`. Sign-in is off (`supabase/config.toml`), like
  `/api` on Render.
- Deploy one `npm run deploy:fn` at a time; two at once both time out.

## Security notes

- Ufora feed URLs contain a personal token that gives read access to that calendar. The ones in
  `presets.yaml` are public (this repo is public). Custom lists are therefore kept only in the
  visitor's browser; `server.js` still has `/api/calendars`, but the page no longer uses it.
- No database credentials are in the repo: Render gets `DATABASE_URL` from its environment, the
  function gets its connection from Supabase.
- Votes are anonymous and unauthenticated (a random id per browser), on both backends.
- `/fetch` accepts any http(s) URL so custom lists can include non-Ufora calendars; it only
  returns parsed events, never the raw response.
