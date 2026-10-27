// ICS parsing, ported from server.js — keep the two in sync.

export interface DeadlineEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  date: string;
  endDate: string | null;
  allDay: boolean;
}

export function parseICS(text: string, fallbackName: string): { calName: string; items: DeadlineEvent[] } {
  text = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const calNameMatch = text.match(/X-WR-CALNAME[^:]*:([^\r\n]+)/i);
  const calName = calNameMatch ? calNameMatch[1].trim() : fallbackName;

  const items: DeadlineEvent[] = [];
  text.split('BEGIN:VEVENT').slice(1).forEach(block => {
    const get = (key: string) => {
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
    });
  });

  items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return { calName, items };
}

export function parseICSDate(s: string): Date | null {
  s = s.replace(/^[^:]*:/, '').trim();
  if (/^\d{8}$/.test(s))
    // All-day: noon UTC, so the date stays the same in any European/American timezone
    return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12));
  if (/^\d{8}T\d{6}Z?$/.test(s)) {
    const [y, mo, d, h, mi, sec] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8), s.slice(9, 11), s.slice(11, 13), s.slice(13, 15)];
    return s.endsWith('Z')
      ? new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`)
      : new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}`);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Minimal parser for presets.yaml (same rules as loadPresets() in server.js):
// top-level "name:" keys, each followed by "- url" items.
export function parsePresets(text: string): { name: string; urls: string[] }[] {
  const presets: { name: string; urls: string[] }[] = [];
  let current: { name: string; urls: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const key = line.match(/^(\S[^:]*):\s*$/);
    const item = line.match(/^\s*-\s+(.+)$/);
    if (key) {
      current = { name: key[1].trim().replace(/^["']|["']$/g, ''), urls: [] };
      presets.push(current);
    } else if (item && current) {
      const url = item[1].trim().replace(/^["']|["']$/g, '');
      if (!current.urls.includes(url)) current.urls.push(url); // skip duplicate links
    }
  }
  return presets;
}
