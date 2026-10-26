// Tests for the app's maths and rules. Run with: npm test   (or: node --test "tests/*.test.js")
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load');

const app = loadApp();
// Values made inside the sandbox have their own Object and Array, so compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

function set(id, ex, kg, reps, wid, date, extra) {
  return Object.assign({ id: id, ex: ex, kg: kg, reps: reps, wid: wid, date: date, ts: Date.parse(date + 'T18:00:00') + Number(id.replace(/\D/g, '') || 0), type: 'working' }, extra || {});
}

test('estimated one-rep max', () => {
  assert.equal(app.e1rm(100, 1), 100);
  assert.equal(Math.round(app.e1rm(100, 5) * 100) / 100, 116.67);
  assert.equal(app.e1rm(100, 13), null, 'over 12 reps is too far from a max to estimate');
});

test('plan set labels', () => {
  assert.equal(app.slotsLabel(['working', 'working', 'working']), '3 working');
  assert.equal(app.slotsLabel(['working']), '1 working');
  assert.equal(app.slotsLabel(['warmup', 'working', 'working', 'drop']), '1 warmup, 2 working, 1 drop');
  assert.deepEqual(plain(app.planSlots({ sets: 2 })), ['working', 'working'], 'old plans with only a set count');
});

test('usernames', () => {
  assert.deepEqual(plain(app.readUsername('@Lifter_01')), { u: 'lifter_01' });
  assert.ok(app.readUsername('ab').err, 'too short');
  assert.ok(app.readUsername('bad name').err, 'spaces not allowed');
  assert.ok(app.readUsername('émile').err, 'only a-z, 0-9 and _');
  assert.ok(app.readUsername('').err);
});

test('profile checks', () => {
  const ok = app.readProfile('Alex', 'Edwards', '20', 'm', '80', 'kg', 'pf-');
  assert.equal(ok.name, 'Alex Edwards');
  assert.equal(ok.kg, 80);
  assert.equal(app.readProfile('Alex', '', '20', 'm', '80', 'kg', 'pf-').id, 'pf-last');
  assert.equal(app.readProfile('Alex', 'E', '12', 'm', '80', 'kg', 'pf-').id, 'pf-age', 'must be 13 or over');
  assert.ok(Math.abs(app.readProfile('Alex', 'E', '20', 'm', '176', 'lb', 'pf-').kg - 79.83) < 0.01, 'pounds are stored as kg');
});

test('durations in words', () => {
  assert.equal(app.fmtLength(147e3), '2 min');
  assert.equal(app.fmtLength(65 * 60e3), '1 hr 5 min');
  assert.equal(app.fmtLength(120 * 60e3), '2 hr');
  assert.equal(app.fmtLength(20e3), 'under 1 min');
});

test('PRs: the first session is a baseline, later bests are PRs', () => {
  const entries = [
    set('a1', 'Bench press', 80, 5, 'w1', '2026-10-01'),
    set('a2', 'Bench press', 80, 5, 'w1', '2026-10-01'),
    set('b1', 'Bench press', 85, 5, 'w2', '2026-10-05'),
    set('b2', 'Bench press', 80, 8, 'w2', '2026-10-05'),
    set('b3', 'Bench press', 100, 3, 'w2', '2026-10-05', { type: 'warmup' })
  ];
  const flags = app.analyze(entries);
  assert.deepEqual(plain(flags.a1.types), [], 'nothing in the first session is a PR');
  assert.equal(flags.a1.first, true);
  assert.ok(flags.b1.types.some((t) => t.t === 'weight' && t.prev === 80), 'heavier than before is a weight PR');
  assert.ok(flags.b2.types.some((t) => t.t === 'reps' && t.prev === 5), 'more reps at the same weight is a rep PR');
  assert.deepEqual(plain(flags.b3.types), [], 'warmups never count');
});

test('weight moved counts working and drop sets only', () => {
  const s = app.freshState();
  s.entries = [
    set('x1', 'Squat', 100, 5, 'w1', '2026-10-01'),
    set('x2', 'Squat', 60, 10, 'w1', '2026-10-01', { type: 'warmup' }),
    set('x3', 'Squat', 80, 8, 'w1', '2026-10-01', { type: 'drop' }),
    set('x4', 'Treadmill', 0, 0, 'w1', '2026-10-01', { cardio: true, mins: 20 }),
    set('x5', 'Squat', 100, 5, 'other', '2026-10-01')
  ];
  app.setState(s);
  assert.equal(app.volOf('w1'), 100 * 5 + 80 * 8);
});

test('a workout in progress is never sent to the server', () => {
  const s = app.freshState();
  s.workouts = [{ id: 'done', date: '2026-10-01', start: 1, end: 2, plan: null, planId: null }];
  s.active = { id: 'live', start: 3, date: '2026-10-02', exercises: [] };
  s.entries = [set('d1', 'Squat', 100, 5, 'done', '2026-10-01'), set('l1', 'Squat', 100, 5, 'live', '2026-10-02')];
  app.setState(s);
  const rows = app.toRows();
  assert.ok(rows.sets.d1, 'finished workout sets are saved');
  assert.equal(rows.sets.l1, undefined, 'sets of the workout in progress stay on the device');
});

test('exercise list: starts from history, ignores case, remembers new names', () => {
  const s = app.freshState();
  s.plans = [{ id: 'p', name: 'Push', exercises: [{ name: 'Bench press', sets: 3 }, { name: 'Treadmill', cardio: true }] }];
  s.entries = [set('e1', 'bench press', 80, 5, 'w', '2026-10-01'), set('e2', 'Dip', 0, 10, 'w', '2026-10-01')];
  app.setState(s);
  const names = app.exerciseList().map((x) => x.n);
  assert.deepEqual(plain(names), ['Bench press', 'Treadmill', 'Dip'], 'one entry per exercise, whatever the case');
  assert.equal(app.findExercise('TREADMILL').c, true, 'cardio is remembered');
  assert.equal(app.rememberExercise('  Cable   curl ', false), true, 'a new exercise is added, tidied');
  assert.equal(app.rememberExercise('cable curl', false), false, 'the same name again is not');
  assert.ok(app.findExercise('Cable curl'));
});

test('leaderboard week and month start in local time', () => {
  const week = app.periodStart('week'), month = app.periodStart('month');
  assert.match(week, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(week + 'T00:00:00').getDay(), 1, 'weeks start on Monday');
  assert.ok(new Date(week + 'T00:00:00') <= new Date(), 'and not in the future');
  assert.equal(month.slice(8), '01');
  assert.equal(app.periodStart('all'), null);
});

test('leaderboard values', () => {
  assert.deepEqual(plain(app.boardValue({ best_kg: 140 }, 'exercise')), { n: '140', u: 'kg best' });
  assert.deepEqual(plain(app.boardValue({ best_kg: null }, 'exercise')), { n: '-', u: 'not done' });
  assert.deepEqual(plain(app.boardValue({ workouts: 1 }, 'workouts')), { n: '1', u: 'workout' });
});

test('text from people is escaped before it is shown', () => {
  assert.equal(app.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(app.esc('"\'&'), '&quot;&#39;&amp;');
});
