// Workout app Worker: JSON document API on D1, .ics calendar feed, static assets.
const KINDS = new Set(['exercises', 'workouts', 'schedule', 'sessions']);
const SCHEMA = `CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
)`;
const JSONH = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
let ready = null;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSONH });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path.startsWith('/api/');
    const isCal = path === '/calendar.ics' || path.startsWith('/calendar/');
    if (!isApi && !isCal) return env.ASSETS.fetch(request);

    // Optional shared key: set the API_TOKEN secret to require it.
    if (env.API_TOKEN) {
      const h = request.headers.get('Authorization') || '';
      const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
      if (t !== env.API_TOKEN) return json({ error: 'unauthorized' }, 401);
    }

    try {
      ready ??= env.DB.prepare(SCHEMA).run().catch((e) => { ready = null; throw e; });
      await ready;
      return isApi ? await api(request, env, path) : await calendar(env, path);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};

async function api(req, env, path) {
  const [, kind, rawId] = path.split('/').filter(Boolean);
  const id = rawId ? decodeURIComponent(rawId) : null;

  if (kind === 'all' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT kind, data FROM docs').all();
    const out = { exercises: [], workouts: [], schedule: [], sessions: [] };
    for (const r of results) if (out[r.kind]) out[r.kind].push(JSON.parse(r.data));
    return json(out);
  }
  if (!KINDS.has(kind)) return json({ error: 'unknown collection' }, 404);

  if (!id) {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const { results } = await env.DB.prepare('SELECT data FROM docs WHERE kind = ?').bind(kind).all();
    return json(results.map((r) => JSON.parse(r.data)));
  }

  if (req.method === 'GET') {
    const r = await env.DB.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?').bind(kind, id).first();
    return r ? new Response(r.data, { headers: JSONH }) : json({ error: 'not found' }, 404);
  }
  if (req.method === 'PUT') {
    const text = await req.text();
    let doc;
    try { doc = JSON.parse(text); } catch { return json({ error: 'invalid JSON' }, 400); }
    if (!doc || doc.id !== id) return json({ error: 'id mismatch' }, 400);
    await env.DB.prepare(
      `INSERT INTO docs (kind, id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(kind, id, text, Date.now()).run();
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM docs WHERE kind = ? AND id = ?').bind(kind, id).run();
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// ---------- calendar (.ics) ----------
async function calendar(env, path) {
  const { results } = await env.DB
    .prepare("SELECT kind, data FROM docs WHERE kind IN ('workouts', 'schedule', 'exercises')")
    .all();
  const W = new Map(), E = new Map(), sched = [];
  for (const r of results) {
    const d = JSON.parse(r.data);
    if (r.kind === 'workouts') W.set(d.id, d);
    else if (r.kind === 'exercises') E.set(d.id, d);
    else sched.push(d);
  }

  const single = path.match(/^\/calendar\/event\/([^/]+)\.ics$/);
  let entries;
  if (single) {
    const id = decodeURIComponent(single[1]);
    entries = sched.filter((e) => e.id === id);
    if (!entries.length) return new Response('Not found', { status: 404 });
  } else if (path === '/calendar.ics') {
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    entries = sched.filter((e) => e.date >= cutoff);
  } else {
    return new Response('Not found', { status: 404 });
  }

  const tz = entries.find((e) => e.tz)?.tz;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workout App//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Workouts', ...(tz ? [`X-WR-TIMEZONE:${tz}`] : []),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of entries) {
    const w = W.get(e.workoutId);
    const title = w ? w.name : 'Workout';
    const secs = w ? e.plan || w.sections : null;
    const names = secs
      ? [...new Set((secs.main || []).flatMap((b) => b.items.map((i) => E.get(i.exerciseId)?.name).filter(Boolean)))]
      : [];
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@workout-app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${local(e.date, e.time)}`,
      `DTEND:${local(e.date, e.time, e.durationMin || 60)}`,
      `SUMMARY:${icsText(title)}`
    );
    if (names.length) lines.push(`DESCRIPTION:${icsText(names.join(', '))}`);
    if (e.reminderMin !== null && e.reminderMin !== undefined && e.reminderMin !== '') {
      const m = Number(e.reminderMin);
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`,
        m === 0 ? 'TRIGGER:PT0S' : `TRIGGER:-PT${m}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');

  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${single ? 'workout' : 'workouts'}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
}

// Floating local time (no Z) so the phone shows it in its own time zone.
function local(date, time = '07:00', addMin = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '07:00').split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm + addMin)).toISOString().replace(/[-:]/g, '').slice(0, 15);
}
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const enc = new TextEncoder();
function fold(line) {
  let out = '', cur = '', n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > 74) { out += cur + '\r\n '; cur = ''; n = 1; }
    cur += ch; n += b;
  }
  return out + cur;
}
