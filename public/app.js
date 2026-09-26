'use strict';
/* Workout app front end. Vanilla JS, no build step. */

/* ========== helpers ========== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = (o) => JSON.parse(JSON.stringify(o));
const pad = (n) => String(n).padStart(2, '0');
const fmt = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s, o = { weekday: 'short', month: 'short', day: 'numeric' }) => parseDate(s).toLocaleDateString(undefined, o);
const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const byName = (a, b) => a.name.localeCompare(b.name);
const byDateTime = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const setPath = (o, path, v) => { const k = path.split('.'); let t = o; for (let i = 0; i < k.length - 1; i++) t = t[k[i]]; t[k[k.length - 1]] = v; };
const getPath = (o, path) => path.split('.').reduce((t, k) => t?.[k], o);
const SECTIONS = [['warmup', 'Warm-up'], ['main', 'Main'], ['cooldown', 'Cool-down']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REMS = [['', 'No reminder'], [0, 'At start time'], [10, '10 min before'], [15, '15 min before'], [30, '30 min before'], [60, '1 hour before'], [120, '2 hours before']];
const remText = (m) => (m === 0 ? 'at start' : m < 60 ? `${m} min before` : `${m / 60} h before`);

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const I = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="3"/>'),
  note: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  trash: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  play: svg('<path d="M8 5l11 7-11 7z" fill="currentColor"/>'),
  sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
};

/* ========== data store (D1 via Worker, cached locally, queued when offline) ========== */
const KINDS = ['exercises', 'workouts', 'schedule', 'sessions'];
const S = { exercises: [], workouts: [], schedule: [], sessions: [] };
const LS = {
  get(k, d) { try { const v = localStorage.getItem('wk.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wk.' + k, JSON.stringify(v)); } catch {} },
  del(k) { localStorage.removeItem('wk.' + k); },
};

const Store = {
  queue: LS.get('queue', []),
  status: 'idle',
  flushing: false,
  token() { return LS.get('token', ''); },
  async api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { this.status = 'auth'; throw new Error('auth'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },
  init() { const c = LS.get('cache', null); if (c) KINDS.forEach((k) => (S[k] = c[k] || [])); },
  cache() { LS.set('cache', S); },
  get(kind, id) { return S[kind].find((x) => x.id === id); },
  put(kind, doc) {
    doc.updatedAt = Date.now();
    const i = S[kind].findIndex((x) => x.id === doc.id);
    if (i >= 0) S[kind][i] = doc; else S[kind].push(doc);
    this.cache();
    this.enqueue({ op: 'put', kind, id: doc.id });
  },
  remove(kind, id) {
    S[kind] = S[kind].filter((x) => x.id !== id);
    this.cache();
    this.enqueue({ op: 'del', kind, id });
  },
  enqueue(op) {
    this.queue = this.queue.filter((q) => !(q.kind === op.kind && q.id === op.id));
    this.queue.push(op);
    LS.set('queue', this.queue);
    this.flush();
  },
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const q = this.queue[0];
        const path = `/api/${q.kind}/${encodeURIComponent(q.id)}`;
        if (q.op === 'put') { const doc = this.get(q.kind, q.id); if (doc) await this.api('PUT', path, doc); }
        else await this.api('DELETE', path);
        const i = this.queue.indexOf(q); // may have been replaced by a newer edit while sending
        if (i >= 0) this.queue.splice(i, 1);
        LS.set('queue', this.queue);
      }
      this.status = 'ok';
    } catch {
      if (this.status !== 'auth') this.status = 'offline';
    } finally {
      this.flushing = false;
      updateSync();
    }
  },
  async pull() {
    await this.flush();
    if (this.queue.length) return false;
    try {
      const all = await this.api('GET', '/api/all');
      const keep = this.queue.map((q) => ({ q, doc: this.get(q.kind, q.id) })); // edits made during the request
      KINDS.forEach((k) => (S[k] = all[k] || []));
      keep.forEach(({ q, doc }) => {
        S[q.kind] = S[q.kind].filter((x) => x.id !== q.id);
        if (q.op === 'put' && doc) S[q.kind].push(doc);
      });
      this.cache();
      this.status = 'ok';
      return true;
    } catch {
      if (this.status !== 'auth') this.status = 'offline';
      return false;
    } finally { updateSync(); }
  },
};
function syncText() {
  const n = Store.queue.length;
  return { ok: 'Synced', idle: 'Connecting', auth: 'Access key needed to sync', offline: `Offline. ${n} change${n === 1 ? '' : 's'} waiting to sync.` }[Store.status];
}
function updateSync() { document.body.dataset.sync = Store.status; const el = $('#syncStatus'); if (el) el.textContent = syncText(); }

const groups = () => [...new Set(S.exercises.map((e) => (e.group || '').trim()).filter(Boolean))].sort();
const allItems = (sections) => SECTIONS.flatMap(([k]) => (sections?.[k] || []).flatMap((b) => b.items));

/* ========== plan -> ordered steps ========== */
function flatten(sections, inc = {}) {
  const steps = [];
  const blocks = [];
  SECTIONS.forEach(([sec]) => {
    if (sec !== 'main' && inc[sec] === false) return;
    (sections[sec] || []).forEach((b, bi) => blocks.push({ sec, b, bi }));
  });
  const rest = (secs, label, o) => ({ id: uid(), kind: 'rest', secs, label, done: false, note: null, ...o });
  blocks.forEach(({ sec, b, bi }, k) => {
    const solo = b.type === 'solo';
    const R = Math.max(1, +b.rounds || 1);
    for (let r = 1; r <= R; r++) {
      b.items.forEach((it, ii) => {
        const ex = Store.get('exercises', it.exerciseId);
        steps.push({
          id: uid(), kind: 'ex', sec, bi, ii, round: r, rounds: R, split: !solo, exerciseId: it.exerciseId,
          name: ex ? ex.name : 'Exercise', reps: +it.reps || 0, unit: it.unit || 'reps', load: it.load || '', done: false, note: null,
        });
        if (!solo && ii < b.items.length - 1 && +it.rest > 0) steps.push(rest(+it.rest, 'Rest', { sec, bi, round: r, split: true }));
      });
      if (r < R && +b.restRounds > 0) steps.push(rest(+b.restRounds, solo ? 'Rest between sets' : 'Rest between rounds', { sec, bi, round: r, split: !solo }));
    }
    if (k < blocks.length - 1 && +b.restAfter > 0) steps.push(rest(+b.restAfter, 'Rest before next', { sec, bi, round: R, split: false, after: true }));
  });
  return steps;
}
const estimate = (sections, inc) => flatten(sections, inc).reduce((t, s) => t + (s.kind === 'rest' ? s.secs : s.unit === 'sec' ? s.reps + 10 : s.reps * 3 + 15), 0);

/* ========== router ========== */
let R = { name: 'today', args: [], key: '' };
let Ed = null; // draft for the current editor screen
const routes = {
  today: viewToday, plan: viewPlan, workouts: viewWorkouts, workout: viewWorkoutEdit, exercises: viewExercises,
  exercise: viewExerciseEdit, active: viewActive, history: viewHistory, review: viewReview, settings: viewSettings,
};
const TAB_OF = { workout: 'workouts', exercise: 'exercises', review: 'history', settings: 'today', active: 'today' };
const go = (p) => { location.hash = '#/' + p; };
const view = (html) => { $('#view').innerHTML = html; };

function onRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const next = { name: routes[parts[0]] ? parts[0] : 'today', args: parts.slice(1).map(decodeURIComponent) };
  next.key = next.name + '/' + next.args.join('/');
  if (next.key !== R.key) Ed = null;
  R = next;
  render();
  window.scrollTo(0, 0);
}
function render() {
  const active = R.name === 'active';
  document.body.classList.toggle('activeMode', active);
  if (active) keepAwake(); else releaseAwake();
  routes[R.name](...R.args);
  const tab = TAB_OF[R.name] || R.name;
  $$('#tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
}

/* ========== Today ========== */
function viewToday() {
  const t = todayStr();
  const todays = S.schedule.filter((e) => e.date === t).sort(byDateTime);
  const upcoming = S.schedule.filter((e) => e.date > t).sort(byDateTime).slice(0, 5);
  const unrev = S.sessions.filter((s) => !s.reviewed && s.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const d = new Date();
  const aEx = A ? A.steps.filter((x) => x.kind === 'ex') : [];
  view(`
    <header class="vh">
      <h1 class="today-h"><span>${d.toLocaleDateString(undefined, { weekday: 'long' })}</span>${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</h1>
      <button class="icon-btn gear" data-act="go" data-to="settings" aria-label="Settings">${I.sliders}</button>
    </header>
    ${A ? `<section class="card resume">
      <div><b>${esc(A.workoutName)} in progress</b><small>${aEx.filter((x) => x.done).length} of ${aEx.length} done</small></div>
      <div class="row"><button class="btn primary" data-act="go" data-to="active">Resume</button><button class="btn ghost danger" data-act="discard">Discard</button></div>
    </section>` : ''}
    ${unrev ? `<a class="card review-cue" href="#/review/${unrev.id}"><b>Review ${esc(unrev.workoutName)}</b><small>Set up next time from your notes</small></a>` : ''}
    <h2>Today</h2>
    ${todays.length ? todays.map(todayCard).join('') : '<p class="empty">Nothing planned today.</p>'}
    <h2>Start any workout</h2>
    ${S.workouts.length
      ? `<div class="row"><select id="quickPick" aria-label="Workout">${S.workouts.slice().sort(byName).map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select><button class="btn primary" data-act="quickStart">Start</button></div>`
      : `<p class="empty">No workouts yet. <a href="#/workout/new">Create a workout</a></p>`}
    ${upcoming.length ? `<h2>Coming up</h2><ul class="list">${upcoming.map((e) => {
      const w = Store.get('workouts', e.workoutId);
      return `<li><button class="row-link" data-act="planDay" data-date="${e.date}"><span class="rl-main"><b>${esc(w ? w.name : 'Deleted workout')}</b><small>${fmtDate(e.date)}, ${fmtTime(e.time)}</small></span></button></li>`;
    }).join('')}</ul>` : ''}
  `);
}
function todayCard(e) {
  const w = Store.get('workouts', e.workoutId);
  return `<div class="card entry"><div class="entry-h"><div><b>${esc(w ? w.name : 'Deleted workout')}</b><small>${fmtTime(e.time)}${e.plan ? ', adjusted from your last review' : ''}</small></div>
    ${e.sessionId ? `<a class="btn sm" href="#/review/${e.sessionId}">Review</a>` : w ? `<button class="btn primary" data-act="start" data-w="${w.id}" data-e="${e.id}">Start</button>` : ''}</div></div>`;
}

/* ========== Exercises ========== */
const STARTER = [
  ['Scapular pulls', 'Back', 'lower traps, lats', 'Hang from the rings or bar and pull the shoulder blades down without bending the elbows.'],
  ['Pull-up', 'Back', 'lats, biceps, rear delts', 'Hang with straight arms, pull until the chin clears the bar or rings, lower under control.'],
  ['Ring row', 'Back', 'upper back, lats, biceps', 'Body straight under the rings, pull the chest to the hands, keep the hips up.'],
  ['Dip', 'Chest', 'chest, triceps, front delts', 'Support on bars or rings, lower until the shoulders are just below the elbows, press back up.'],
  ['Push-up', 'Chest', 'chest, triceps, front delts', 'Hands under shoulders, body in one straight line, chest to the floor.'],
  ['Ring push-up', 'Chest', 'chest, triceps, shoulder stabilizers', 'Push-up with hands in low rings. Turn the rings out at the top.'],
  ['Ring support hold', 'Shoulders', 'shoulders, triceps, chest', 'Straight-arm support on the rings, rings turned out, shoulders pushed down.'],
  ['Squat', 'Legs', 'quads, glutes', 'Feet about shoulder width, sit down between the heels, knees track over the toes.'],
  ['Bulgarian split squat', 'Legs', 'quads, glutes', 'Rear foot elevated, lower the back knee toward the floor.'],
  ['Nordic curl', 'Legs', 'hamstrings', 'Kneel with ankles anchored and lower the torso slowly, straight from knee to head.'],
  ['Single-leg Romanian deadlift', 'Legs', 'hamstrings, glutes', 'Hinge on one leg with a flat back, reach toward the floor, stand tall.'],
  ['Hollow body hold', 'Core', 'abs, hip flexors', 'Lower back pressed down, arms and legs extended and off the floor.'],
  ['Arch body hold', 'Core', 'spinal erectors, glutes', 'Face down, lift chest, arms and legs off the floor.'],
  ['Plank', 'Core', 'abs, obliques', 'Forearms down, body straight, glutes squeezed.'],
  ['Wrist circles', 'Mobility', 'wrists, forearms', 'Slow circles both ways before pressing and support work.'],
  ['Arm circles', 'Mobility', 'shoulders', 'Small to large circles, forward and back.'],
  ['Leg swings', 'Mobility', 'hips, hamstrings', 'Front-to-back and side-to-side swings while holding a support.'],
  ['Deep squat hold', 'Mobility', 'hips, ankles', 'Sit in the bottom of a squat, heels down, chest up.'],
];

function viewExercises() {
  const byG = {};
  S.exercises.slice().sort(byName).forEach((e) => (byG[e.group || 'Other'] ??= []).push(e));
  view(`
    <header class="vh"><h1>Exercises</h1><button class="btn primary sm" data-act="go" data-to="exercise/new">${I.plus} New</button></header>
    ${S.exercises.length ? `
      <input id="exSearch" class="search" type="search" placeholder="Search exercises or muscles" autocomplete="off" aria-label="Search exercises">
      ${Object.keys(byG).sort().map((g) => `<section class="exgroup"><h2>${esc(g)}</h2><ul class="list">${byG[g].map((e) => `
        <li data-q="${esc((e.name + ' ' + e.group + ' ' + (e.muscles || '')).toLowerCase())}"><a class="row-link" href="#/exercise/${e.id}">
          <span class="rl-main"><b>${esc(e.name)}</b>${e.muscles ? `<small>${esc(e.muscles)}</small>` : ''}</span>${e.videoUrl ? '<span class="tag">Video</span>' : ''}
        </a></li>`).join('')}</ul></section>`).join('')}`
    : `<div class="empty-state"><p>Your exercise library is empty. Add exercises here, then build workouts from them.</p>
        <button class="btn primary" data-act="go" data-to="exercise/new">Add exercise</button>
        <button class="btn" data-act="loadStarter">Load starter exercises</button></div>`}
  `);
}
function filterExercises(q) {
  q = q.trim().toLowerCase();
  $$('[data-q]').forEach((li) => (li.hidden = !!q && !li.dataset.q.includes(q)));
  $$('.exgroup').forEach((s) => (s.hidden = !$$('li', s).some((li) => !li.hidden)));
}

function viewExerciseEdit(id) {
  if (!Ed) {
    const ex = id === 'new' ? { id: uid(), name: '', description: '', group: '', muscles: '', videoUrl: '', notes: '' } : Store.get('exercises', id);
    if (!ex) return go('exercises');
    Ed = { obj: clone(ex), isNew: id === 'new' };
  }
  const e = Ed.obj;
  const used = S.workouts.filter((w) => allItems(w.sections).some((it) => it.exerciseId === e.id));
  const vid = safeUrl(e.videoUrl);
  view(`
    <header class="vh"><button class="icon-btn" data-act="go" data-to="exercises" aria-label="Back to exercises">${I.back}</button><h1>${Ed.isNew ? 'New exercise' : 'Edit exercise'}</h1></header>
    <div class="form">
      <label class="fld"><span>Name</span><input data-path="name" value="${esc(e.name)}" autocomplete="off"></label>
      <label class="fld"><span>Muscle group</span><input data-path="group" list="groupList" value="${esc(e.group)}" placeholder="e.g. Back" autocomplete="off">
        <datalist id="groupList">${groups().map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <label class="fld"><span>Muscles targeted</span><input data-path="muscles" value="${esc(e.muscles)}" placeholder="e.g. lats, biceps"></label>
      <label class="fld"><span>Description</span><textarea data-path="description" rows="3">${esc(e.description)}</textarea></label>
      <label class="fld"><span>Instruction video link</span><input data-path="videoUrl" type="url" inputmode="url" value="${esc(e.videoUrl)}" placeholder="https://"></label>
      ${vid ? `<a class="vid" href="${esc(vid)}" target="_blank" rel="noopener">${I.play} Watch video</a>` : ''}
      <label class="fld"><span>Notes</span><textarea data-path="notes" rows="3">${esc(e.notes)}</textarea></label>
    </div>
    <div class="actions"><button class="btn primary" data-act="saveExercise">Save exercise</button>${Ed.isNew ? '' : '<button class="btn danger" data-act="deleteExercise">Delete</button>'}</div>
    ${used.length ? `<p class="muted small">Used in ${used.map((w) => esc(w.name)).join(', ')}</p>` : ''}
  `);
}

/* ========== Workouts ========== */
const newItem = () => ({ id: uid(), exerciseId: '', group: '', reps: 8, unit: 'reps', load: '', rest: 0 });
const newBlock = (type, sec) => ({
  id: uid(), type, rounds: sec === 'main' ? 3 : 1, restRounds: sec === 'main' ? (type === 'solo' ? 90 : 120) : 0, restAfter: 0,
  items: type === 'solo' ? [newItem()] : [newItem(), newItem()],
});

function viewWorkouts() {
  const ws = S.workouts.slice().sort(byName);
  view(`
    <header class="vh"><h1>Workouts</h1><button class="btn primary sm" data-act="go" data-to="workout/new">${I.plus} New</button></header>
    ${ws.length ? `<ul class="list">${ws.map((w) => {
      const n = allItems(w.sections).length;
      return `<li class="wrow"><a class="row-link" href="#/workout/${w.id}"><span class="rl-main"><b>${esc(w.name)}</b>
        <small>${n} exercise${n === 1 ? '' : 's'}, about ${Math.round(estimate(w.sections) / 60)} min${w.nextOverride ? ', adjusted for next time' : ''}</small></span></a>
        <button class="btn sm primary" data-act="start" data-w="${w.id}">Start</button></li>`;
    }).join('')}</ul>`
    : S.exercises.length
      ? `<div class="empty-state"><p>No workouts yet.</p><button class="btn primary" data-act="go" data-to="workout/new">Create workout</button></div>`
      : `<div class="empty-state"><p>Workouts are built from your exercise library. Add a few exercises first.</p><button class="btn primary" data-act="go" data-to="exercises">Go to exercises</button></div>`}
  `);
}

function viewWorkoutEdit(id) {
  if (!Ed) {
    const w = id === 'new' ? { id: uid(), name: '', notes: '', sections: { warmup: [], main: [], cooldown: [] }, nextOverride: null } : Store.get('workouts', id);
    if (!w) return go('workouts');
    Ed = { obj: clone(w), isNew: id === 'new' };
    if (Ed.isNew && S.exercises.length) Ed.obj.sections.main.push(newBlock('solo', 'main'));
  }
  const w = Ed.obj;
  view(`
    <header class="vh"><button class="icon-btn" data-act="go" data-to="workouts" aria-label="Back to workouts">${I.back}</button><h1>${Ed.isNew ? 'New workout' : 'Edit workout'}</h1></header>
    <div class="form">
      <label class="fld"><span>Name</span><input data-path="name" value="${esc(w.name)}" placeholder="e.g. Rings day A" autocomplete="off"></label>
      <label class="fld"><span>Notes</span><textarea data-path="notes" rows="2">${esc(w.notes || '')}</textarea></label>
    </div>
    ${w.nextOverride ? '<p class="notice">Next time you start this workout, it uses the changes from your last review. <button class="link" data-act="clearOverride">Discard those changes</button></p>' : ''}
    ${SECTIONS.map(([k, label]) => `
      <section class="wsec">
        <div class="wsec-h"><h2>${label}</h2>${k === 'main' ? '' : '<span class="muted small">Optional</span>'}</div>
        ${w.sections[k].map((b, bi) => blockEditor(k, b, bi, w.sections[k].length)).join('')}
        <div class="addrow"><button class="btn sm" data-act="addBlock" data-sec="${k}" data-type="solo">${I.plus} Exercise</button>
          <button class="btn sm" data-act="addBlock" data-sec="${k}" data-type="split">${I.plus} Split</button></div>
      </section>`).join('')}
    <div class="actions sticky"><button class="btn primary" data-act="saveWorkout">Save workout</button>${Ed.isNew ? '' : '<button class="btn danger" data-act="deleteWorkout">Delete</button>'}</div>
  `);
}
const numFld = (label, path, val, attrs = '') =>
  `<label class="fld"><span>${label}</span><input type="number" inputmode="numeric" min="0" data-num data-path="${path}" value="${esc(val ?? '')}" ${attrs}></label>`;

function blockEditor(sec, b, bi, n) {
  const base = `sections.${sec}.${bi}`;
  const solo = b.type === 'solo';
  const d = `data-sec="${sec}" data-bi="${bi}"`;
  return `<div class="blk ${solo ? 'blk-solo' : 'blk-split'}">
    <div class="blk-h"><b>${solo ? 'Exercise' : 'Split'}</b><span class="blk-tools">
      <button class="icon-btn sm" data-act="moveBlock" ${d} data-dir="-1" ${bi === 0 ? 'disabled' : ''} aria-label="Move up">${I.up}</button>
      <button class="icon-btn sm" data-act="moveBlock" ${d} data-dir="1" ${bi === n - 1 ? 'disabled' : ''} aria-label="Move down">${I.down}</button>
      <button class="icon-btn sm" data-act="delBlock" ${d} aria-label="Remove">${I.trash}</button></span></div>
    ${b.items.map((it, ii) => itemEditor(`${base}.items.${ii}`, it, { solo, sec, bi, ii, count: b.items.length })).join('')}
    ${solo ? '' : `<button class="btn sm ghost" data-act="addItem" ${d}>${I.plus} Add exercise to split</button>`}
    <div class="g3">${numFld(solo ? 'Sets' : 'Rounds', base + '.rounds', b.rounds, 'min="1"')}
      ${numFld(solo ? 'Rest between sets (s)' : 'Rest between rounds (s)', base + '.restRounds', b.restRounds)}
      ${numFld('Rest after (s)', base + '.restAfter', b.restAfter)}</div>
  </div>`;
}
function itemEditor(p, it, o) {
  const list = S.exercises.filter((e) => !it.group || e.group === it.group).sort(byName);
  return `<div class="itm">
    ${o.solo ? '' : `<div class="itm-h"><span>${String.fromCharCode(65 + o.ii)}</span>${o.count > 1 ? `<button class="icon-btn sm" data-act="delItem" data-sec="${o.sec}" data-bi="${o.bi}" data-ii="${o.ii}" aria-label="Remove from split">${I.trash}</button>` : ''}</div>`}
    <div class="g2">
      <label class="fld"><span>Muscle group</span><select data-path="${p}.group" data-rerender><option value="">All groups</option>${groups().map((g) => `<option value="${esc(g)}" ${g === it.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
      <label class="fld"><span>Exercise</span><select data-path="${p}.exerciseId"><option value="">Choose</option>${list.map((e) => `<option value="${e.id}" ${e.id === it.exerciseId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
    </div>
    <div class="g3">
      <label class="fld"><span>${it.unit === 'sec' ? 'Seconds' : 'Reps'}</span><input type="number" inputmode="numeric" min="1" data-num data-path="${p}.reps" value="${esc(it.reps)}"></label>
      <label class="fld"><span>Measure</span><select data-path="${p}.unit" data-rerender><option value="reps" ${it.unit !== 'sec' ? 'selected' : ''}>Reps</option><option value="sec" ${it.unit === 'sec' ? 'selected' : ''}>Timed hold</option></select></label>
      <label class="fld"><span>Load or variation</span><input data-path="${p}.load" value="${esc(it.load)}" placeholder="Optional"></label>
    </div>
    ${!o.solo && o.ii < o.count - 1 ? numFld('Rest before next exercise (s)', p + '.rest', it.rest) : ''}
  </div>`;
}

/* ========== Planner ========== */
let cal = null;
function viewPlan() {
  if (!cal) { const d = new Date(); cal = { y: d.getFullYear(), m: d.getMonth(), sel: todayStr() }; }
  const first = new Date(cal.y, cal.m, 1);
  const days = new Date(cal.y, cal.m + 1, 0).getDate();
  const t = todayStr();
  const byDate = {};
  S.schedule.forEach((e) => (byDate[e.date] ??= []).push(e));
  let cells = '<span></span>'.repeat(first.getDay());
  for (let d = 1; d <= days; d++) {
    const ds = `${cal.y}-${pad(cal.m + 1)}-${pad(d)}`;
    const es = byDate[ds] || [];
    cells += `<button class="day ${ds === t ? 'is-today' : ''} ${ds === cal.sel ? 'is-sel' : ''}" data-act="pickDay" data-date="${ds}"
      aria-label="${fmtDate(ds, { weekday: 'long', month: 'long', day: 'numeric' })}${es.length ? `, ${es.length} workout${es.length > 1 ? 's' : ''}` : ''}">
      <span>${d}</span><i>${es.slice(0, 3).map((e) => `<b class="${e.sessionId ? 'done' : ''}"></b>`).join('')}</i></button>`;
  }
  const sel = (byDate[cal.sel] || []).sort(byDateTime);
  view(`
    <header class="vh"><h1>Plan</h1></header>
    <div class="cal-h"><button class="icon-btn" data-act="calMove" data-d="-1" aria-label="Previous month">${I.left}</button>
      <h2>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      <button class="icon-btn" data-act="calMove" data-d="1" aria-label="Next month">${I.right}</button></div>
    <div class="cal-w" aria-hidden="true">${DAYS.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal">${cells}</div>
    <section class="daypanel">
      <h2>${fmtDate(cal.sel, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
      ${sel.map(planEntryCard).join('') || '<p class="empty">No workouts on this day.</p>'}
      ${S.workouts.length ? addEntryForm(!sel.length) : '<p class="empty">Create a workout to schedule it.</p>'}
    </section>
  `);
}
const icsUrl = (path) => { const t = Store.token(); return path + (t ? `?token=${encodeURIComponent(t)}` : ''); };
function planEntryCard(e) {
  const w = Store.get('workouts', e.workoutId);
  const hasW = w?.sections.warmup.length, hasC = w?.sections.cooldown.length;
  const series = e.seriesId && S.schedule.some((x) => x.seriesId === e.seriesId && x.id !== e.id && x.date > e.date);
  const tg = (f, l) => `<label class="tgl"><input type="checkbox" data-change="entryInc" data-id="${e.id}" data-f="${f}" ${e[f] !== false ? 'checked' : ''}> ${l}</label>`;
  return `<div class="card entry">
    <div class="entry-h"><div><b>${esc(w ? w.name : 'Deleted workout')}</b><small>${fmtTime(e.time)}${e.reminderMin != null ? `, reminder ${remText(e.reminderMin)}` : ''}</small></div>
      ${e.sessionId ? `<a class="btn sm" href="#/review/${e.sessionId}">Review</a>` : w ? `<button class="btn sm primary" data-act="start" data-w="${w.id}" data-e="${e.id}">Start</button>` : ''}</div>
    ${hasW || hasC ? `<div class="toggles">${hasW ? tg('warmup', 'Warm-up') : ''}${hasC ? tg('cooldown', 'Cool-down') : ''}</div>` : ''}
    ${e.plan ? `<p class="notice small">Adjusted from your last review. <button class="link" data-act="resetEntry" data-id="${e.id}">Use the saved workout instead</button></p>` : ''}
    <div class="entry-a">
      <a class="btn sm ghost" href="${esc(icsUrl('/calendar/event/' + e.id + '.ics'))}">Add to phone calendar</a>
      <button class="btn sm ghost danger" data-act="removeEntry" data-id="${e.id}">Remove</button>
      ${series ? `<button class="btn sm ghost danger" data-act="removeSeries" data-id="${e.id}">Remove this and later</button>` : ''}
    </div></div>`;
}
function addEntryForm(open) {
  const lastRem = String(LS.get('lastRem', 15));
  return `<details class="addentry" ${open ? 'open' : ''}><summary>Add a workout to this day</summary>
    <div class="form">
      <label class="fld"><span>Workout</span><select id="pfW">${S.workouts.slice().sort(byName).map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>
      <div class="g2">
        <label class="fld"><span>Time</span><input id="pfT" type="time" value="${esc(LS.get('lastTime', '07:00'))}"></label>
        <label class="fld"><span>Reminder</span><select id="pfR">${REMS.map(([v, l]) => `<option value="${v}" ${String(v) === lastRem ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label class="fld"><span>Repeat</span><select id="pfRep"><option value="0">Does not repeat</option><option value="3">Weekly for 4 weeks</option><option value="7">Weekly for 8 weeks</option><option value="11">Weekly for 12 weeks</option></select></label>
      <button class="btn primary" data-act="addEntry">Add to ${fmtDate(cal.sel)}</button>
    </div></details>`;
}

/* ========== Active workout ========== */
let A = LS.get('active', null);
const saveActive = () => LS.set('active', A);
const current = () => A?.steps.find((s) => !s.done);
let doneOpen = false;

function startSession(workoutId, entryId) {
  const w = Store.get('workouts', workoutId);
  if (!w) return toast('That workout no longer exists.');
  if (A && !confirm(`${A.workoutName} is still in progress. Discard it and start ${w.name}?`)) return;
  const entry = entryId ? Store.get('schedule', entryId) : null;
  let plan, usedOverride = false;
  if (entry?.plan) plan = clone(entry.plan);
  else if (w.nextOverride) { plan = clone(w.nextOverride); usedOverride = true; }
  else plan = clone(w.sections);
  const include = entry ? { warmup: entry.warmup !== false, cooldown: entry.cooldown !== false } : { warmup: true, cooldown: true };
  A = { id: uid(), workoutId, workoutName: w.name, entryId: entry?.id || null, startedAt: Date.now(), finishedAt: null, plan, include, usedOverride, steps: flatten(plan, include), reviewed: false };
  doneOpen = false;
  unlockAudio();
  afterChange(false);
  go('active');
}
function afterChange(draw = true) {
  const cur = current();
  A.steps.forEach((s) => { if (!s.done && s !== cur) { s.startedAt = null; s.timerStart = null; } });
  if (cur?.kind === 'rest' && !cur.startedAt) cur.startedAt = Date.now();
  saveActive();
  if (draw) render();
}
function toggleDone(id) {
  const s = A?.steps.find((x) => x.id === id);
  if (!s) return;
  if (!s.done) {
    s.done = true; s.doneAt = Date.now();
    if (s.kind === 'rest') s.rested = s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0;
  } else {
    s.done = false; s.doneAt = null; s.startedAt = null; s.rested = null;
  }
  buzz(15);
  afterChange();
}

function viewActive() {
  if (!A) return go('today');
  const cur = current();
  const exs = A.steps.filter((s) => s.kind === 'ex');
  const dn = exs.filter((s) => s.done).length;
  const pending = A.steps.filter((s) => !s.done);
  const done = A.steps.filter((s) => s.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const MAX = 12;
  const multiSec = new Set(A.steps.map((s) => s.sec)).size > 1;
  view(`<div class="active">
    <header class="a-head">
      <button class="icon-btn" data-act="go" data-to="today" aria-label="Leave workout screen">${I.back}</button>
      <div class="a-title"><h1>${esc(A.workoutName)}</h1><p><span id="elapsed">${fmt((Date.now() - A.startedAt) / 1000)}</span><button class="lockbadge" id="lockBadge" data-act="retryLock"></button></p></div>
      <button class="btn sm primary" data-act="finish">Finish</button>
    </header>
    <div class="prog" role="progressbar" aria-label="Exercises done" aria-valuemin="0" aria-valuemax="${exs.length}" aria-valuenow="${dn}"><i style="width:${exs.length ? (dn / exs.length) * 100 : 0}%"></i></div>
    ${cur && multiSec ? `<p class="seclabel">${SECTIONS.find(([k]) => k === cur.sec)[1]}</p>` : ''}
    ${cur ? splitCard(cur) : ''}
    ${cur
      ? `<ol class="queue">${pending.slice(0, MAX).map((s, i) => pillHTML(s, i === 0)).join('')}</ol>${pending.length > MAX ? `<p class="muted small center">${pending.length - MAX} more after these</p>` : ''}`
      : `<div class="card alldone"><h2>All done</h2><p>${dn} of ${exs.length} exercises checked in ${dur(Date.now() - A.startedAt)}.</p><button class="btn primary" data-act="finish">Finish and review</button></div>`}
    ${done.length ? `<details class="donelist" ${doneOpen ? 'open' : ''}><summary>Done (${done.length})</summary><ol class="queue">${done.map((s) => pillHTML(s, false)).join('')}</ol></details>` : ''}
    <p class="hint">Swipe left to check off. Swipe right to add a note.</p>
  </div>`);
  updateLockBadge();
  tick();
}
function splitCard(cur) {
  if (!cur.split || cur.after) return '';
  const bs = A.steps.filter((s) => s.sec === cur.sec && s.bi === cur.bi && !s.after);
  const names = [...new Set(bs.filter((s) => s.kind === 'ex').map((s) => s.name))];
  let rb = '';
  for (let r = 1; r <= cur.rounds; r++) {
    const d = bs.filter((s) => s.round === r && s.kind === 'ex').every((s) => s.done);
    rb += `<button class="rnd ${d ? 'on' : ''} ${r === cur.round ? 'cur' : ''}" data-act="round" data-r="${r}" role="checkbox" aria-checked="${d}" aria-label="Round ${r}">${d ? I.check : r}</button>`;
  }
  return `<div class="splitcard"><div><b>Split, round ${cur.round} of ${cur.rounds}</b><small>${names.map(esc).join(' + ')}</small></div><div class="rounds">${rb}</div></div>`;
}
function notePreview(n) {
  return [n.repsDone != null && `Did ${n.repsDone}`, n.harder && 'Harder', n.easier && 'Easier', n.moreReps && 'More reps', n.fewerReps && 'Fewer reps', n.text]
    .filter(Boolean).join(', ');
}
function pillHTML(s, top) {
  const nb = `<button class="notebox ${s.note ? 'has' : ''}" data-act="note" data-id="${s.id}" aria-label="${s.note ? 'Edit note' : 'Add note'}">${s.note ? `<span>${esc(notePreview(s.note))}</span>` : I.note + (s.kind === 'ex' ? '<span>Note</span>' : '')}</button>`;
  const chk = `<button class="chk" data-act="toggle" data-id="${s.id}" role="checkbox" aria-checked="${s.done}" aria-label="${s.done ? 'Mark not done' : 'Mark done'}">${s.done ? I.check : ''}</button>`;
  let inner;
  if (s.kind === 'rest') {
    const total = s.secs + (s.extra || 0);
    const el = s.done ? s.rested ?? total : s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;
    inner = `<i class="fill" style="width:${s.done ? 100 : Math.min(100, (el / total) * 100)}%"></i>${chk}
      <span class="t" data-rested>${fmt(Math.floor(el))}</span>
      <span class="p-mid"><b>${esc(s.label)}</b>${top && !s.done ? `<button class="plus" data-act="plus15" data-id="${s.id}">+15 s</button>` : ''}</span>
      <span class="t t-right" data-remain>${s.done ? '' : '−' + fmt(Math.ceil(total - el))}</span>${nb}`;
  } else {
    const setTxt = s.rounds > 1 ? `${s.split ? 'Round' : 'Set'} ${s.round} of ${s.rounds}` : '';
    const ex = Store.get('exercises', s.exerciseId);
    const vid = top && safeUrl(ex?.videoUrl);
    let timer = '', fillW = 0;
    if (s.unit === 'sec' && top && !s.done) {
      if (s.timerStart) {
        const e = (Date.now() - s.timerStart) / 1000;
        fillW = Math.min(100, (e / s.reps) * 100);
        timer = `<span class="t" data-hold>${fmt(Math.ceil(s.reps - e))}</span>`;
      } else timer = `<button class="plus" data-act="startHold" data-id="${s.id}">${I.play} ${s.timerEnded ? 'Again' : 'Start'}</button>`;
    }
    inner = `${s.unit === 'sec' ? `<i class="fill hold" style="width:${fillW}%"></i>` : ''}${chk}
      <span class="p-main"><b class="p-name">${esc(s.name)}</b><span class="p-sub"><span>${s.unit === 'sec' ? `${s.reps} s hold` : `${s.reps} reps`}</span>${setTxt ? `<span>${setTxt}</span>` : ''}${s.load ? `<span>${esc(s.load)}</span>` : ''}${vid ? `<a href="${esc(vid)}" target="_blank" rel="noopener" class="vidlink">Video</a>` : ''}</span></span>
      ${timer}${nb}`;
  }
  return `<li class="swipe" data-step="${s.id}">
    <div class="under under-note">${I.note} Note</div><div class="under under-done">${s.done ? 'Undo' : 'Done'} ${I.check}</div>
    <div class="pill ${s.kind} ${top ? 'top' : ''} ${s.done ? 'done' : ''}" data-pill>${inner}</div></li>`;
}

// Timer loop: updates only the top pill between renders.
function tick() {
  if (!A || R.name !== 'active') return;
  const now = Date.now();
  const el = $('#elapsed');
  if (el) el.textContent = fmt((now - A.startedAt) / 1000);
  const cur = current();
  if (!cur) return;
  const li = $(`[data-step="${cur.id}"]`);
  if (cur.kind === 'rest' && cur.startedAt) {
    const total = cur.secs + (cur.extra || 0), e = (now - cur.startedAt) / 1000, left = total - e;
    if (left <= 0) {
      cur.done = true; cur.doneAt = now; cur.rested = Math.round(total);
      chime(); buzz([250, 120, 250]);
      return afterChange();
    }
    if (li) {
      $('.fill', li).style.width = (e / total) * 100 + '%';
      $('[data-rested]', li).textContent = fmt(Math.floor(e));
      $('[data-remain]', li).textContent = '−' + fmt(Math.ceil(left));
    }
    const sec = Math.ceil(left);
    if (sec <= 3 && cur._beep !== sec) { cur._beep = sec; tone(740, 0.09); }
  } else if (cur.kind === 'ex' && cur.timerStart) {
    const e = (now - cur.timerStart) / 1000, left = cur.reps - e;
    if (left <= 0) {
      cur.timerStart = null; cur.timerEnded = true;
      chime(); buzz([250, 120, 250]); saveActive();
      return render();
    }
    if (li) { $('.fill', li).style.width = (e / cur.reps) * 100 + '%'; const h = $('[data-hold]', li); if (h) h.textContent = fmt(Math.ceil(left)); }
  }
}
setInterval(tick, 250);

function finishSession() {
  if (!A) return;
  const left = A.steps.filter((s) => !s.done && s.kind === 'ex').length;
  if (left && !confirm(`${left} exercise${left > 1 ? 's are' : ' is'} not checked off. Finish anyway?`)) return;
  const s = A;
  s.finishedAt = Date.now();
  Store.put('sessions', s);
  if (s.entryId) { const en = Store.get('schedule', s.entryId); if (en) { en.sessionId = s.id; Store.put('schedule', en); } }
  if (s.usedOverride) { const w = Store.get('workouts', s.workoutId); if (w?.nextOverride) { w.nextOverride = null; Store.put('workouts', w); } }
  A = null; LS.del('active');
  go('review/' + s.id);
}

/* ----- screen wake lock, sound, haptics ----- */
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; updateLockBadge(); }); } } catch {}
  updateLockBadge();
}
function releaseAwake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
function updateLockBadge() {
  const b = $('#lockBadge'); if (!b) return;
  b.textContent = !('wakeLock' in navigator) ? 'Screen lock not supported' : wakeLock ? 'Screen stays on' : 'Tap to keep screen on';
  b.classList.toggle('on', !!wakeLock);
}
let AC = null;
function unlockAudio() { try { AC ??= new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch {} }
function tone(freq = 880, len = 0.15, when = 0) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime + when;
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(AC.destination);
  o.start(t); o.stop(t + len + 0.02);
}
const chime = () => { tone(660, 0.18); tone(990, 0.3, 0.2); };
const buzz = (p) => navigator.vibrate?.(p);

/* ----- swipe gestures on pills ----- */
let sw = null, suppressClick = 0;
const THRESH = 80;
document.addEventListener('pointerdown', (e) => {
  unlockAudio();
  const pill = e.target.closest('[data-pill]');
  if (!pill) return;
  sw = { pill, li: pill.closest('.swipe'), x0: e.clientX, y0: e.clientY, dx: 0, lock: null, pid: e.pointerId };
});
document.addEventListener('pointermove', (e) => {
  if (!sw || e.pointerId !== sw.pid) return;
  const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
  if (!sw.lock) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    sw.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (sw.lock === 'x') { try { sw.pill.setPointerCapture(e.pointerId); } catch {} sw.pill.classList.add('dragging'); }
  }
  if (sw.lock !== 'x') return;
  sw.dx = dx;
  sw.pill.style.transform = `translateX(${dx}px)`;
  sw.li.dataset.dir = dx < 0 ? 'left' : 'right';
  sw.li.classList.toggle('armed', Math.abs(dx) > THRESH);
});
function endSwipe(e) {
  if (!sw || e.pointerId !== sw.pid) return;
  const { pill, li, dx, lock } = sw;
  sw = null;
  if (lock !== 'x') return;
  suppressClick = Date.now() + 350;
  pill.classList.remove('dragging');
  const id = li.dataset.step;
  if (e.type === 'pointerup' && dx < -THRESH) {
    pill.style.transform = 'translateX(-110%)';
    buzz(10);
    setTimeout(() => toggleDone(id), 160);
  } else {
    pill.style.transform = '';
    setTimeout(() => { li.removeAttribute('data-dir'); li.classList.remove('armed'); }, 220);
    if (e.type === 'pointerup' && dx > THRESH) openNote(id);
  }
}
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);
document.addEventListener('toggle', (e) => { if (e.target.classList?.contains('donelist')) doneOpen = e.target.open; }, true);

/* ----- note sheet ----- */
let ND = null;
const NOTE_PAIRS = { harder: 'easier', easier: 'harder', moreReps: 'fewerReps', fewerReps: 'moreReps' };
function openNote(id) {
  const s = A?.steps.find((x) => x.id === id);
  if (!s) return;
  ND = { id, n: Object.assign({ text: '', harder: false, easier: false, moreReps: false, fewerReps: false, repsDone: null }, clone(s.note || {})) };
  const n = ND.n, ex = s.kind === 'ex';
  const chip = (f, l) => `<button class="chip ${n[f] ? 'on' : ''}" data-act="noteChip" data-f="${f}" aria-pressed="${n[f]}">${l}</button>`;
  $('#sheet').innerHTML = `<div class="backdrop" data-act="noteClose"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
      <div><h2 id="sheetTitle">${esc(ex ? s.name : s.label)}</h2><p class="muted small">${ex ? `${s.rounds > 1 ? `${s.split ? 'Round' : 'Set'} ${s.round} of ${s.rounds}, ` : ''}${s.reps} ${s.unit === 'sec' ? 's hold' : 'reps'}` : 'Note on this rest'}</p></div>
      ${ex ? `<div class="chips">${chip('harder', 'Make harder')}${chip('easier', 'Make easier')}${chip('moreReps', 'Add reps next time')}${chip('fewerReps', 'Fewer reps next time')}</div>
        <div class="repsdone"><span>${s.unit === 'sec' ? 'Seconds held' : 'Reps completed'}</span><div class="stepper">
          <button class="icon-btn" data-act="repsStep" data-d="-1" aria-label="One fewer">−</button>
          <input id="repsDone" type="number" inputmode="numeric" min="0" value="${n.repsDone ?? ''}" placeholder="${s.reps}" aria-label="${s.unit === 'sec' ? 'Seconds held' : 'Reps completed'}">
          <button class="icon-btn" data-act="repsStep" data-d="1" aria-label="One more">+</button></div></div>` : ''}
      <label class="fld"><span>Note</span><textarea id="noteText" rows="3" placeholder="How did it feel?">${esc(n.text)}</textarea></label>
      <div class="row"><button class="btn primary" data-act="noteSave">Save note</button><button class="btn" data-act="noteClose">Cancel</button>${s.note ? '<button class="btn ghost danger" data-act="noteClear">Clear note</button>' : ''}</div>
    </div>`;
  document.body.classList.add('sheet-open');
}
function closeNote() { $('#sheet').innerHTML = ''; document.body.classList.remove('sheet-open'); ND = null; }

/* ========== Review ========== */
function suggest(p, s) {
  SECTIONS.forEach(([k]) => (p[k] || []).forEach((b, bi) => b.items.forEach((it, ii) => {
    const ns = s.steps.filter((x) => x.kind === 'ex' && x.sec === k && x.bi === bi && x.ii === ii && x.note).map((x) => x.note);
    const up = ns.filter((n) => n.moreReps).length, down = ns.filter((n) => n.fewerReps).length;
    const step = it.unit === 'sec' ? 5 : 1;
    if (up > down) it.reps = (+it.reps || 0) + step;
    else if (down > up) it.reps = Math.max(1, (+it.reps || 0) - step);
  })));
}
function viewReview(id) {
  const s = Store.get('sessions', id);
  if (!s) return go('history');
  if (!Ed) { const p = clone(s.plan); suggest(p, s); Ed = { obj: p, applyAll: false }; }
  const p = Ed.obj;
  const exs = s.steps.filter((x) => x.kind === 'ex'), dn = exs.filter((x) => x.done).length;
  const inc = s.include || {};
  const secs = SECTIONS.filter(([k]) => (p[k] || []).length && (k === 'main' || inc[k] !== false));
  view(`
    <header class="vh"><button class="icon-btn" data-act="go" data-to="history" aria-label="Back to history">${I.back}</button><h1>Review</h1></header>
    <div class="rv-top"><h2>${esc(s.workoutName)}</h2>
      <p class="muted">${new Date(s.startedAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${dur((s.finishedAt || s.startedAt) - s.startedAt)}, ${dn} of ${exs.length} checked</p>
      ${s.reviewed ? '<p class="notice small">Already reviewed. Saving again applies these values again.</p>' : ''}
      <p class="muted small">Change anything below for next time. Highlighted values differ from this session, including suggestions from your notes.</p></div>
    ${secs.map(([k, label]) => `<section><h2>${label}</h2>${p[k].map((b, bi) => reviewBlock(s, k, b, bi)).join('')}</section>`).join('')}
    <div class="rv-save">
      <label class="tgl"><input type="checkbox" data-change="applyAll" ${Ed.applyAll ? 'checked' : ''}> Also update every future workout named “${esc(s.workoutName)}”</label>
      <div class="row"><button class="btn primary" data-act="reviewSave" data-id="${s.id}">Save for next time</button><button class="btn" data-act="reviewSkip" data-id="${s.id}">Keep as is</button></div>
    </div>
    <button class="btn ghost danger" data-act="deleteSession" data-id="${s.id}">Delete this session</button>
  `);
}
function rvFld(label, path, val, orig, num = true) {
  const ch = String(val ?? '') !== String(orig ?? '');
  return `<label class="fld"><span>${label}</span><input ${num ? 'type="number" inputmode="numeric" min="0" data-num' : ''} data-path="${path}" data-orig="${esc(orig ?? '')}" value="${esc(val ?? '')}" class="${ch ? 'changed' : ''}"></label>`;
}
function reviewBlock(s, sec, b, bi) {
  const ob = s.plan[sec][bi];
  const base = `${sec}.${bi}`, solo = b.type === 'solo';
  const restNotes = s.steps.filter((x) => x.kind === 'rest' && x.sec === sec && x.bi === bi && x.note?.text);
  return `<div class="blk ${solo ? 'blk-solo' : 'blk-split'}">
    ${solo ? '' : '<div class="blk-h"><b>Split</b></div>'}
    ${b.items.map((it, ii) => reviewItem(s, sec, bi, ii, it, ob.items[ii], `${base}.items.${ii}`, solo, b.items.length)).join('')}
    ${restNotes.length ? `<ul class="rv-notes">${restNotes.map((x) => `<li><span class="tag">${esc(x.label)}</span><p>${esc(x.note.text)}</p></li>`).join('')}</ul>` : ''}
    <div class="g3">${rvFld(solo ? 'Sets' : 'Rounds', base + '.rounds', b.rounds, ob.rounds)}
      ${rvFld(solo ? 'Rest between sets (s)' : 'Rest between rounds (s)', base + '.restRounds', b.restRounds, ob.restRounds)}
      ${rvFld('Rest after (s)', base + '.restAfter', b.restAfter, ob.restAfter)}</div>
  </div>`;
}
function reviewItem(s, sec, bi, ii, it, oi, p, solo, count) {
  const steps = s.steps.filter((x) => x.kind === 'ex' && x.sec === sec && x.bi === bi && x.ii === ii);
  const name = Store.get('exercises', it.exerciseId)?.name || steps[0]?.name || 'Exercise';
  const u = (x) => (x.unit === 'sec' ? ' s' : '');
  const sets = steps.map((x) => `<span class="setchip ${x.done ? '' : 'miss'}"><b>${x.round}</b>${x.note?.repsDone != null ? x.note.repsDone + u(x) : x.done ? x.reps + u(x) : 'skipped'}</span>`).join('');
  const noted = steps.filter((x) => x.note);
  const notes = noted.map((x) => {
    const n = x.note;
    const tags = [n.harder && 'Make harder', n.easier && 'Make easier', n.moreReps && 'Add reps next time', n.fewerReps && 'Fewer reps next time'].filter(Boolean);
    return `<li><span class="muted small">${solo ? 'Set' : 'Round'} ${x.round}</span>${n.repsDone != null ? `<span class="tag">Did ${n.repsDone}${u(x)}</span>` : ''}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}${n.text ? `<p>${esc(n.text)}</p>` : ''}</li>`;
  }).join('');
  const harder = noted.some((x) => x.note.harder), easier = noted.some((x) => x.note.easier);
  const earlier = S.sessions.filter((o) => o.id !== s.id && o.startedAt < s.startedAt).sort((a, b) => b.startedAt - a.startedAt)
    .flatMap((o) => o.steps.filter((x) => x.exerciseId === it.exerciseId && x.note && (x.note.text || x.note.repsDone != null)).map((x) => ({ o, x }))).slice(0, 5);
  return `<div class="rv-item">
    <h3>${esc(name)}</h3>
    <div class="sets" aria-label="Results by set">${sets}</div>
    ${notes ? `<ul class="rv-notes">${notes}</ul>` : ''}
    ${earlier.length ? `<details class="earlier"><summary>Earlier notes</summary><ul>${earlier.map(({ o, x }) => `<li><span class="muted small">${new Date(o.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span> ${x.note.repsDone != null ? `did ${x.note.repsDone}${u(x)}. ` : ''}${esc(x.note.text || '')}</li>`).join('')}</ul></details>` : ''}
    ${harder || easier ? `<p class="hint-flag">You asked to make this ${harder && easier ? 'harder on some sets and easier on others' : harder ? 'harder' : 'easier'}. Change the load or variation below.</p>` : ''}
    <div class="g3">
      ${rvFld(it.unit === 'sec' ? 'Seconds' : 'Reps', p + '.reps', it.reps, oi.reps)}
      <label class="fld"><span>Measure</span><select data-path="${p}.unit" data-orig="${esc(oi.unit || 'reps')}" class="${(it.unit || 'reps') !== (oi.unit || 'reps') ? 'changed' : ''}"><option value="reps" ${it.unit !== 'sec' ? 'selected' : ''}>Reps</option><option value="sec" ${it.unit === 'sec' ? 'selected' : ''}>Timed hold</option></select></label>
      ${rvFld('Load or variation', p + '.load', it.load, oi.load, false)}
    </div>
    ${!solo && ii < count - 1 ? rvFld('Rest before next exercise (s)', p + '.rest', it.rest, oi.rest) : ''}
  </div>`;
}

// Changes are recorded as field edits keyed by block/item id, so they apply cleanly to templates and future plans.
const BF = ['rounds', 'restRounds', 'restAfter'], IF = ['reps', 'unit', 'load', 'rest'];
function diffPlan(a, b) {
  const d = [];
  SECTIONS.forEach(([sec]) => (b[sec] || []).forEach((bl, bi) => {
    const ob = a[sec]?.[bi]; if (!ob) return;
    BF.forEach((f) => { if (String(bl[f] ?? '') !== String(ob[f] ?? '')) d.push({ sec, bi, blockId: bl.id, f, v: bl[f] }); });
    bl.items.forEach((it, ii) => {
      const oi = ob.items[ii]; if (!oi) return;
      IF.forEach((f) => { if (String(it[f] ?? '') !== String(oi[f] ?? '')) d.push({ sec, bi, blockId: bl.id, ii, itemId: it.id, exerciseId: it.exerciseId, f, v: it[f] }); });
    });
  }));
  return d;
}
function applyDiff(plan, d) {
  d.forEach((c) => {
    const list = plan[c.sec] || [];
    const bl = list.find((x) => x.id === c.blockId) || list[c.bi];
    if (!bl) return;
    if (c.ii == null) { bl[c.f] = c.v; return; }
    const it = bl.items.find((x) => x.id === c.itemId) || bl.items[c.ii];
    if (it && it.exerciseId === c.exerciseId) it[c.f] = c.v;
  });
  return plan;
}
function saveReview(id) {
  const s = Store.get('sessions', id);
  if (!s || !Ed) return;
  const d = diffPlan(s.plan, Ed.obj);
  let msg = 'Review saved';
  if (d.length) {
    const nm = s.workoutName.trim().toLowerCase();
    const templates = S.workouts.filter((w) => w.name.trim().toLowerCase() === nm);
    const t = todayStr();
    const future = S.schedule.filter((e) => !e.sessionId && e.date >= t && e.id !== s.entryId && templates.some((w) => w.id === e.workoutId)).sort(byDateTime);
    if (Ed.applyAll) {
      templates.forEach((w) => { applyDiff(w.sections, d); if (w.nextOverride) applyDiff(w.nextOverride, d); Store.put('workouts', w); });
      future.forEach((e) => { if (e.plan) { applyDiff(e.plan, d); Store.put('schedule', e); } });
      msg = templates.length ? `Updated every future “${s.workoutName}”` : 'The saved workout no longer exists, so nothing was updated.';
    } else if (future[0]) {
      const e = future[0], w = Store.get('workouts', e.workoutId);
      e.plan = applyDiff(e.plan || clone(w.sections), d);
      Store.put('schedule', e);
      msg = `Saved for ${fmtDate(e.date)}`;
    } else {
      const w = Store.get('workouts', s.workoutId) || templates[0];
      if (w) { w.nextOverride = applyDiff(w.nextOverride || clone(w.sections), d); Store.put('workouts', w); msg = `Saved for the next time you start ${w.name}`; }
      else msg = 'The saved workout no longer exists, so nothing was updated.';
    }
  }
  s.reviewed = true; s.nextChanges = d;
  Store.put('sessions', s);
  toast(msg);
  go('history');
}

/* ========== History & settings ========== */
function viewHistory() {
  const ss = S.sessions.slice().sort((a, b) => b.startedAt - a.startedAt);
  view(`<header class="vh"><h1>History</h1></header>
    ${ss.length ? `<ul class="list">${ss.map((s) => {
      const ex = s.steps.filter((x) => x.kind === 'ex'), dn = ex.filter((x) => x.done).length;
      return `<li><a class="row-link" href="#/review/${s.id}"><span class="rl-main"><b>${esc(s.workoutName)}</b>
        <small>${new Date(s.startedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${dur((s.finishedAt || s.startedAt) - s.startedAt)}, ${dn} of ${ex.length} done</small></span>
        ${s.reviewed ? '' : '<span class="tag warn">Review</span>'}</a></li>`;
    }).join('')}</ul>` : '<p class="empty">Finished workouts show up here for review.</p>'}`);
}
function viewSettings() {
  const feed = location.origin + icsUrl('/calendar.ics');
  view(`
    <header class="vh"><button class="icon-btn" data-act="go" data-to="today" aria-label="Back">${I.back}</button><h1>Settings</h1></header>
    <section class="card"><h2>Sync</h2><p id="syncStatus" class="muted">${syncText()}</p>
      <label class="fld"><span>Access key</span><input id="tokIn" type="password" value="${esc(Store.token())}" autocomplete="off" placeholder="Only needed if you set API_TOKEN"></label>
      <div class="row"><button class="btn primary" data-act="saveToken">Save key</button><button class="btn" data-act="syncNow">Sync now</button></div></section>
    <section class="card"><h2>Reminders</h2>
      <p class="muted small">Reminders come from your phone's calendar. Subscribe once and every planned workout appears with its reminder, or add single workouts from the Plan tab.</p>
      <div class="row"><a class="btn" href="${esc(feed.replace(/^https?:/, 'webcal:'))}">Subscribe on this device</a><button class="btn ghost" data-act="copyFeed" data-url="${esc(feed)}">Copy calendar link</button></div></section>
    <section class="card"><h2>Backup</h2>
      <div class="row"><button class="btn" data-act="exportData">Export JSON</button><label class="btn">Import JSON<input id="importFile" type="file" accept="application/json,.json" hidden></label></div></section>
    <section class="card"><h2>Exercise library</h2><button class="btn" data-act="loadStarter">Add starter exercises</button></section>
  `);
}
async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    let n = 0;
    KINDS.forEach((k) => (data[k] || []).forEach((d) => { if (d?.id) { Store.put(k, d); n++; } }));
    toast(`Imported ${n} items`);
    render();
  } catch { toast('That file is not a valid backup.'); }
}

/* ========== toast ========== */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ========== actions ========== */
const ACT = {
  go: (el) => go(el.dataset.to),
  quickStart: () => startSession($('#quickPick').value),
  start: (el) => startSession(el.dataset.w, el.dataset.e),
  discard: () => { if (A && confirm(`Discard ${A.workoutName}? Checked sets and notes will be lost.`)) { A = null; LS.del('active'); render(); } },
  planDay: (el) => { const d = parseDate(el.dataset.date); cal = { y: d.getFullYear(), m: d.getMonth(), sel: el.dataset.date }; go('plan'); },

  loadStarter: () => {
    const have = new Set(S.exercises.map((e) => e.name.toLowerCase()));
    let n = 0;
    STARTER.forEach(([name, group, muscles, description]) => {
      if (have.has(name.toLowerCase())) return;
      Store.put('exercises', { id: uid(), name, group, muscles, description, videoUrl: '', notes: '' });
      n++;
    });
    toast(n ? `Added ${n} exercises` : 'You already have all the starter exercises');
    if (R.name === 'exercises') render(); else go('exercises');
  },
  saveExercise: () => {
    const e = Ed.obj;
    e.name = e.name.trim(); e.group = (e.group || '').trim();
    if (!e.name) return toast('Give the exercise a name.');
    Store.put('exercises', e);
    toast('Exercise saved');
    go('exercises');
  },
  deleteExercise: () => {
    const e = Ed.obj;
    const used = S.workouts.filter((w) => allItems(w.sections).some((it) => it.exerciseId === e.id)).length;
    if (!confirm(used ? `${e.name} is used in ${used} workout${used > 1 ? 's' : ''}. Delete it anyway?` : `Delete ${e.name}?`)) return;
    Store.remove('exercises', e.id);
    go('exercises');
  },

  addBlock: (el) => { Ed.obj.sections[el.dataset.sec].push(newBlock(el.dataset.type, el.dataset.sec)); render(); },
  moveBlock: (el) => {
    const a = Ed.obj.sections[el.dataset.sec], i = +el.dataset.bi, j = i + +el.dataset.dir;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    render();
  },
  delBlock: (el) => { Ed.obj.sections[el.dataset.sec].splice(+el.dataset.bi, 1); render(); },
  addItem: (el) => { Ed.obj.sections[el.dataset.sec][+el.dataset.bi].items.push(newItem()); render(); },
  delItem: (el) => { Ed.obj.sections[el.dataset.sec][+el.dataset.bi].items.splice(+el.dataset.ii, 1); render(); },
  clearOverride: () => { Ed.obj.nextOverride = null; render(); },
  saveWorkout: () => {
    const w = Ed.obj;
    w.name = w.name.trim();
    if (!w.name) return toast('Give the workout a name.');
    SECTIONS.forEach(([k]) => {
      w.sections[k] = w.sections[k].map((b) => ({ ...b, rounds: Math.max(1, +b.rounds || 1), items: b.items.filter((it) => it.exerciseId) })).filter((b) => b.items.length);
    });
    if (!w.sections.main.length) { render(); return toast('Add at least one exercise to the main section.'); }
    Store.put('workouts', w);
    toast('Workout saved');
    go('workouts');
  },
  deleteWorkout: () => {
    const w = Ed.obj;
    const planned = S.schedule.filter((e) => e.workoutId === w.id && !e.sessionId && e.date >= todayStr());
    if (!confirm(planned.length ? `Delete ${w.name} and remove it from ${planned.length} planned day${planned.length > 1 ? 's' : ''}?` : `Delete ${w.name}?`)) return;
    planned.forEach((e) => Store.remove('schedule', e.id));
    Store.remove('workouts', w.id);
    go('workouts');
  },

  calMove: (el) => { const d = new Date(cal.y, cal.m + +el.dataset.d, 1); cal.y = d.getFullYear(); cal.m = d.getMonth(); render(); },
  pickDay: (el) => { cal.sel = el.dataset.date; render(); },
  addEntry: () => {
    const w = Store.get('workouts', $('#pfW').value);
    if (!w) return;
    const time = $('#pfT').value || '07:00', r = $('#pfR').value, rep = +$('#pfRep').value;
    const seriesId = rep ? uid() : null;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const durationMin = Math.max(15, Math.round(estimate(w.sections) / 300) * 5);
    for (let i = 0; i <= rep; i++) {
      const d = parseDate(cal.sel);
      d.setDate(d.getDate() + 7 * i);
      Store.put('schedule', { id: uid(), workoutId: w.id, date: todayStr(d), time, reminderMin: r === '' ? null : +r, warmup: true, cooldown: true, plan: null, sessionId: null, seriesId, tz, durationMin });
    }
    LS.set('lastTime', time); LS.set('lastRem', r);
    toast(rep ? `Added ${rep + 1} workouts` : `Added ${w.name}`);
    render();
  },
  removeEntry: (el) => { Store.remove('schedule', el.dataset.id); render(); },
  removeSeries: (el) => {
    const e = Store.get('schedule', el.dataset.id);
    if (!e) return;
    S.schedule.filter((x) => x.seriesId === e.seriesId && x.date >= e.date && !x.sessionId).forEach((x) => Store.remove('schedule', x.id));
    render();
  },
  resetEntry: (el) => { const e = Store.get('schedule', el.dataset.id); if (e) { e.plan = null; Store.put('schedule', e); render(); } },

  toggle: (el) => toggleDone(el.dataset.id),
  note: (el) => openNote(el.dataset.id),
  plus15: (el) => { const s = A.steps.find((x) => x.id === el.dataset.id); if (s) { s.extra = (s.extra || 0) + 15; saveActive(); render(); } },
  startHold: (el) => { const s = A.steps.find((x) => x.id === el.dataset.id); if (s) { unlockAudio(); s.timerStart = Date.now(); s.timerEnded = false; saveActive(); render(); } },
  round: (el) => {
    const cur = current(); if (!cur) return;
    const r = +el.dataset.r;
    const rs = A.steps.filter((s) => s.sec === cur.sec && s.bi === cur.bi && !s.after && s.round === r);
    const all = rs.filter((s) => s.kind === 'ex').every((s) => s.done);
    rs.forEach((s) => {
      s.done = !all; s.doneAt = s.done ? Date.now() : null;
      if (s.kind === 'rest') s.rested = s.done ? (s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0) : null;
    });
    buzz(15);
    afterChange();
  },
  finish: () => finishSession(),
  retryLock: () => keepAwake(),

  noteChip: (el) => {
    const f = el.dataset.f;
    ND.n[f] = !ND.n[f];
    if (ND.n[f]) ND.n[NOTE_PAIRS[f]] = false;
    $$('.chip').forEach((c) => { const on = !!ND.n[c.dataset.f]; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
  },
  repsStep: (el) => {
    const s = A.steps.find((x) => x.id === ND.id), inp = $('#repsDone');
    inp.value = Math.max(0, (inp.value === '' ? s.reps : +inp.value) + +el.dataset.d);
  },
  noteSave: () => {
    const s = A.steps.find((x) => x.id === ND.id), n = ND.n;
    n.text = $('#noteText').value.trim();
    const r = $('#repsDone');
    n.repsDone = r && r.value !== '' ? +r.value : null;
    s.note = n.text || n.repsDone != null || n.harder || n.easier || n.moreReps || n.fewerReps ? n : null;
    saveActive(); closeNote(); render();
  },
  noteClear: () => { const s = A.steps.find((x) => x.id === ND.id); s.note = null; saveActive(); closeNote(); render(); },
  noteClose: () => closeNote(),

  reviewSave: (el) => saveReview(el.dataset.id),
  reviewSkip: (el) => { const s = Store.get('sessions', el.dataset.id); if (s) { s.reviewed = true; Store.put('sessions', s); } go('history'); },
  deleteSession: (el) => {
    const s = Store.get('sessions', el.dataset.id);
    if (!s || !confirm('Delete this session and its notes?')) return;
    S.schedule.filter((e) => e.sessionId === s.id).forEach((e) => { e.sessionId = null; Store.put('schedule', e); });
    Store.remove('sessions', s.id);
    go('history');
  },

  saveToken: () => { LS.set('token', $('#tokIn').value.trim()); Store.status = 'idle'; Store.pull().then((ok) => { toast(ok ? 'Synced' : syncText()); render(); }); },
  syncNow: () => Store.pull().then((ok) => { toast(ok ? 'Synced' : syncText()); render(); }),
  copyFeed: (el) => navigator.clipboard?.writeText(el.dataset.url).then(() => toast('Calendar link copied'), () => toast(el.dataset.url)),
  exportData: () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `workouts-backup-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

/* ========== event wiring ========== */
document.addEventListener('click', (e) => {
  if (Date.now() < suppressClick && e.target.closest('[data-pill]')) { e.preventDefault(); e.stopPropagation(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
}, true);

function bindValue(el) {
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if ('num' in el.dataset) v = v === '' ? 0 : Number(v);
  setPath(Ed.obj, el.dataset.path, v);
  if ('orig' in el.dataset) el.classList.toggle('changed', String(v) !== el.dataset.orig);
}
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'exSearch') return filterExercises(el.value);
  if (el.dataset.path && Ed) bindValue(el);
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'importFile') return importData(el.files[0]);
  const c = el.dataset.change;
  if (c === 'entryInc') { const en = Store.get('schedule', el.dataset.id); if (en) { en[el.dataset.f] = el.checked; Store.put('schedule', en); } return; }
  if (c === 'applyAll') { if (Ed) Ed.applyAll = el.checked; return; }
  if (el.dataset.path && Ed && el.tagName === 'SELECT') {
    bindValue(el);
    if (el.dataset.path.endsWith('.group')) {
      const it = getPath(Ed.obj, el.dataset.path.replace(/\.group$/, ''));
      const ex = Store.get('exercises', it.exerciseId);
      if (it.exerciseId && it.group && ex?.group !== it.group) it.exerciseId = '';
    }
    if ('rerender' in el.dataset) render();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ND) closeNote(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (R.name === 'active') { keepAwake(); tick(); }
  else Store.pull().then((ok) => { if (ok && ['today', 'plan', 'workouts', 'exercises', 'history'].includes(R.name)) render(); });
});
window.addEventListener('online', () => Store.pull());
window.addEventListener('hashchange', onRoute);

/* ========== boot ========== */
Store.init();
onRoute();
updateSync();
Store.pull().then((ok) => {
  if (ok && ['today', 'plan', 'workouts', 'exercises', 'history'].includes(R.name)) render();
  if (Store.status === 'auth') toast('Enter your access key in Settings to sync.');
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
