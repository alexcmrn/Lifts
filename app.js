(function () {
  'use strict';

  var LB = 2.20462262;
  var EPS = 0.001;
  var LS_KEY = 'gymlog.v1';
  var REP_TARGETS = [1, 3, 5, 8, 10];

  function shareDefaults() { return { workouts: 'friends', meals: 'private', plans: 'friends', body: 'private' }; }

  // Everything that is saved to the account.
  function freshState() {
    return {
      entries: [], workouts: [], plans: [], schedule: [], meals: [],
      calTarget: 0, targets: {}, bench: {}, bodyKg: 0, unit: 'kg',
      calc: { sex: 'm', imp: false, act: 2, goal: 'lose', age: null, cm: null, kg: null },
      active: null,
      loaded: false,
      // Social features. Each *Ready flag is false until its SQL file has been run in Supabase.
      username: '', unameReady: false,
      sharing: shareDefaults(), socialReady: false, verified: false,
      postsReady: false,
      avatar: '', avatarsReady: false
    };
  }
  var state = freshState();

  // What is on screen right now. Nothing here is saved.
  function freshUi() {
    return {
      tab: 'plans', focus: null, err: null, armed: null, policy: false,
      importOffer: null, importMsg: '',
      // workout
      summary: null, drafts: {}, newEx: '', newCardio: false, benchAsk: null, benchMsg: '',
      // plans and calendar
      edit: null, planSaved: null, addPlan: null, month: null, selDay: null, addDay: null, repeat: false,
      // meals
      mealDay: null, mealErr: '', mealCat: null, mealDraft: { name: '', kcal: '', p: '', c: '', f: '', d: {} },
      openMeal: {}, moreOpen: false, dayAll: false, tgtOpen: false, tgtMore: false, scan: null, scanAll: false,
      calcOpen: false, calcShown: false, calcErr: '', calcDraft: { age: '', h: '', hin: '', w: '' },
      // profile and records
      rc: { per: 'week', off: 0 }, sel: null, histShown: 15, open: {}, shareErr: '', avBusy: false, avErr: '',
      // photo posts
      post: null, posted: {},
      // friends tab
      pp: 'posts', plp: 'plans', viewPost: null, myStats: null,
      fr: {
        pane: 'feed',
        q: '', results: null, searching: false, searchErr: '',
        list: null, loading: false, err: '', busy: {},
        view: null, viewLoading: false, viewU: null, shown: 10,
        lists: { feed: { items: null, loading: false, err: '', more: false }, mine: { items: null, loading: false, err: '', more: false } },
        board: null, boardLoading: false, boardErr: '', metric: 'volume', period: 'week'
      }
    };
  }
  var ui = freshUi();
  var writeQueue = Promise.resolve();

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function key(name) { return String(name).trim().toLowerCase().replace(/\s+/g, ' '); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function toDisp(kg) { return state.unit === 'kg' ? kg : kg * LB; }
  function toKg(v) { return state.unit === 'kg' ? v : v / LB; }
  function fmtNum(v) { return String(+v.toFixed(state.unit === 'kg' ? 2 : 1)); }
  function fmtW(kg) { return fmtNum(toDisp(kg)); }
  function fmtDate(s, long) {
    var d = new Date(s + 'T00:00:00');
    var opts = { day: 'numeric', month: 'short' };
    if (long) opts.weekday = 'short';
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-GB', opts);
  }
  function fmtDur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }
  // Time of day with am or pm, e.g. "6:05 pm".
  function fmtClock(ms) { return new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }); }
  // How long something lasted in words, e.g. "1 hr 5 min" or "45 min".
  function fmtLength(ms) {
    var m = Math.round(ms / 60000), h = Math.floor(m / 60);
    if (m < 1) return 'under 1 min';
    return (h ? h + ' hr' : '') + (h && m % 60 ? ' ' : '') + (m % 60 ? (m % 60) + ' min' : '');
  }
  function e1rm(kg, reps) {
    if (reps > 12) return null;
    return reps === 1 ? kg : kg * (1 + reps / 30);
  }
  function uid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function cmpEntries(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.ts - b.ts; }
  function grp(e) { return e.wid || ('d:' + e.date); }
  function groupByEx(sets) {
    var order = [], map = {};
    sets.forEach(function (e) {
      var k = key(e.ex);
      if (!map[k]) { map[k] = { k: k, name: e.ex, sets: [] }; order.push(k); }
      map[k].sets.push(e);
    });
    return order.map(function (k) { return map[k]; });
  }

  /* ---------- Supabase: accounts and storage ---------- */
  var SB_URL = 'https://opmkdaqsvjsvonrxjlpp.supabase.co';
  var SB_KEY = 'sb_publishable_4D_NLbafqCRulCFEw1fSkg_KIvJQHhD';
  var sb = null, user = null;
  var auth = { agree: false, policy: false, mode: 'in', email: '', pw: '', first: '', last: '', uname: '', age: '', gender: '', wt: '', wunit: 'kg', msg: '', err: '', busy: false, checking: true, recovery: false, fatal: '', loadErr: '', focusId: null };
  var snap = emptySnap();
  var retryTimer = null;
  var TABLES_UP = ['plans', 'workouts', 'schedule', 'sets', 'meals'];
  var TABLES_DEL = ['sets', 'schedule', 'meals', 'workouts', 'plans'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function emptySnap() { return { plans: {}, workouts: {}, schedule: {}, sets: {}, meals: {}, profile: '' }; }
  function iso(ms) { var d = new Date(Number(ms)); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); }
  function num(v, dflt) { v = Number(v); return isFinite(v) ? v : dflt; }
  function chk(res) { if (res && res.error) throw res.error; return res; }

  /* The workout in progress only lives on this device until it is finished. */
  function activeKey() { return 'gymlog.active.' + user.id; }
  function saveLocal() {
    if (!user) return;
    try {
      if (state.active) {
        var id = state.active.id;
        localStorage.setItem(activeKey(), JSON.stringify({ active: state.active, entries: state.entries.filter(function (e) { return e.wid === id; }) }));
      } else localStorage.removeItem(activeKey());
    } catch (e) { /* storage can be blocked */ }
  }
  function readActive() {
    try {
      var d = JSON.parse(localStorage.getItem(activeKey()) || 'null');
      if (d && d.active && d.active.id && !state.workouts.some(function (w) { return w.id === d.active.id; })) {
        state.active = d.active;
        state.entries = state.entries.concat(Array.isArray(d.entries) ? d.entries : []);
      }
    } catch (e) { /* ignore */ }
  }

  /* ---- state <-> database rows ---- */
  function toRows() {
    var rows = { plans: {}, workouts: {}, schedule: {}, sets: {}, meals: {} };
    var activeId = state.active ? state.active.id : null;
    state.plans.forEach(function (p) { rows.plans[p.id] = { id: p.id, name: p.name, exercises: p.exercises }; });
    state.workouts.forEach(function (w) {
      rows.workouts[w.id] = { id: w.id, plan_id: w.planId && rows.plans[w.planId] ? w.planId : null, plan_name: w.plan || null,
        workout_date: w.date, started_at: iso(w.start), ended_at: iso(w.end) };
    });
    state.schedule.forEach(function (s) {
      if (!rows.plans[s.planId]) return;
      rows.schedule[s.id] = { id: s.id, plan_id: s.planId, on_date: s.date, repeat_weekly: !!s.repeat };
    });
    state.entries.forEach(function (e) {
      if (e.wid === activeId || !rows.workouts[e.wid]) return;
      rows.sets[e.id] = { id: e.id, workout_id: e.wid, exercise: e.ex, weight_kg: e.kg || 0, reps: e.reps || 0,
        minutes: e.cardio ? num(e.mins, 0) : null, is_cardio: !!e.cardio, set_type: typeOf(e), logged_at: iso(e.ts) };
    });
    state.meals.forEach(function (m) {
      rows.meals[m.id] = { id: m.id, meal_date: m.date, category: m.cat || null, name: m.name, kcal: m.kcal || 0, protein: m.p || 0,
        carbs: m.c || 0, fats: m.f || 0, nutrients: m.d || null, product_info: m.info || null, amount_g: m.amt || null, logged_at: iso(m.ts) };
    });
    return rows;
  }
  function profileRow() {
    return { user_id: user.id, unit: state.unit, body_kg: state.bodyKg > 0 ? state.bodyKg : null,
      cal_target: state.calTarget > 0 ? Math.round(state.calTarget) : null, targets: state.targets, calc: state.calc, bench: state.bench };
  }
  function snapFromState(hasProfile) {
    var rows = toRows();
    snap = emptySnap();
    TABLES_UP.forEach(function (t) {
      Object.keys(rows[t]).forEach(function (id) { snap[t][id] = JSON.stringify(rows[t][id]); });
    });
    snap.profile = hasProfile ? JSON.stringify(profileRow()) : '';
  }

  /* ---- saving: only what changed is sent ---- */
  function chunkRun(items, size, fn) {
    var p = Promise.resolve();
    for (var i = 0; i < items.length; i += size) {
      (function (c) { p = p.then(function () { return fn(c); }).then(chk); })(items.slice(i, i + size));
    }
    return p;
  }
  function setSyncFail(f) {
    var m = $('syncmsg');
    if (m) {
      m.hidden = !f;
      m.textContent = f ? 'Could not save your latest changes. Trying again shortly.' : '';
    }
    if (f && !retryTimer) {
      retryTimer = setTimeout(function () { retryTimer = null; writeQueue = writeQueue.then(syncNow); }, 8000);
    }
  }
  function syncNow() {
    if (!sb || !user || !state.loaded) return Promise.resolve();
    var rows = toRows();
    var p = Promise.resolve();
    TABLES_UP.forEach(function (t) {
      var up = [];
      Object.keys(rows[t]).forEach(function (id) { if (snap[t][id] !== JSON.stringify(rows[t][id])) up.push(rows[t][id]); });
      if (!up.length) return;
      p = p.then(function () { return chunkRun(up, 300, function (c) { return sb.from(t).upsert(c); }); })
        .then(function () { up.forEach(function (r) { snap[t][r.id] = JSON.stringify(r); }); });
    });
    TABLES_DEL.forEach(function (t) {
      var gone = Object.keys(snap[t]).filter(function (id) { return !rows[t][id]; });
      if (!gone.length) return;
      p = p.then(function () { return chunkRun(gone, 80, function (c) { return sb.from(t).delete().in('id', c); }); })
        .then(function () { gone.forEach(function (id) { delete snap[t][id]; }); });
    });
    var pr = profileRow(), ps = JSON.stringify(pr);
    if (ps !== snap.profile) {
      p = p.then(function () { return sb.from('profiles').upsert(pr, { onConflict: 'user_id' }); }).then(chk).then(function () { snap.profile = ps; });
    }
    return p.then(function () { setSyncFail(false); }).catch(function () { setSyncFail(true); });
  }
  function persist() {
    saveLocal();
    if (!sb || !user || !state.loaded) return;
    writeQueue = writeQueue.then(syncNow);
  }

  /* ---- loading ---- */
  function fetchAll(t) {
    var out = [], from = 0;
    function page() {
      return sb.from(t).select('*').order('id').range(from, from + 999).then(chk).then(function (r) {
        out = out.concat(r.data || []);
        if ((r.data || []).length === 1000) { from += 1000; return page(); }
        return out;
      });
    }
    return page();
  }
  // The sign-up answers travel with the login, so they are copied into the profile the first time the account loads.
  function seedProfile() {
    var md = (user && user.user_metadata) || {};
    if (state.calc.name || !md.name) return;
    state.calc.name = String(md.name).slice(0, 81);
    if (md.first_name) state.calc.first = String(md.first_name).slice(0, 40);
    if (md.last_name) state.calc.last = String(md.last_name).slice(0, 40);
    if (num(md.age, 0) > 0) state.calc.age = Math.round(num(md.age, 0));
    if (md.gender === 'm' || md.gender === 'f' || md.gender === 'o') { state.calc.gender = md.gender; if (md.gender !== 'o') state.calc.sex = md.gender; }
    if (!(state.bodyKg > 0) && num(md.weight_kg, 0) > 0) state.bodyKg = num(md.weight_kg, 0);
    if (md.unit === 'kg' || md.unit === 'lb') state.unit = md.unit;
    persist();
  }
  /* ---- usernames (kept unique by the usernames table, see supabase/schema.sql) ---- */
  var UNAME_RE = /^[a-z0-9_]{3,20}$/;
  function readUsername(v) {
    var u = String(v || '').trim().replace(/^@/, '').toLowerCase();
    if (!u) return { err: 'Choose a username.' };
    if (!UNAME_RE.test(u)) return { err: 'Use 3 to 20 letters, numbers or underscores for your username.' };
    return { u: u };
  }
  function claimUsername(u) {
    return sb.from('usernames').upsert({ user_id: user.id, username: u, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).then(function (r) {
      if (!r.error) { state.username = u; return {}; }
      if (r.error.code === '23505') return { err: 'That username is taken. Try another one.' };
      return { err: friendly(r.error) };
    }, function (e) { return { err: friendly(e) }; });
  }
  // Accounts made before the usernames table existed get the name they chose at sign-up, if it is still free.
  function seedUsername() {
    var md = (user && user.user_metadata) || {};
    if (!state.unameReady || state.username || !md.username) return;
    var un = readUsername(md.username);
    if (un.u) claimUsername(un.u).then(function (x) { if (!x.err) render(); });
  }
  function unameField(p, v) {
    return '<div class="field"><label for="' + p + 'uname">Username</label><div class="ufield"><span aria-hidden="true">@</span>' +
      '<input id="' + p + 'uname" data-' + p.slice(0, 2) + '="uname" autocomplete="nickname" autocapitalize="none" spellcheck="false" maxlength="21" aria-describedby="' + p + 'uhint" value="' + esc(v) + '"></div>' +
      '<span class="hint" id="' + p + 'uhint">3 to 20 letters, numbers or underscores</span></div>';
  }
  // For tables that only exist once an optional SQL file has been run: a failure becomes { error } instead of stopping the load.
  function soft(q) { return q.then(function (x) { return x; }, function (e) { return { error: e }; }); }
  function loadRemote() {
    return Promise.all([fetchAll('plans'), fetchAll('workouts'), fetchAll('schedule'), fetchAll('sets'), fetchAll('meals'),
      sb.from('profiles').select('*').limit(1).then(chk),
      soft(sb.from('usernames').select('username').eq('user_id', user.id).limit(1)),
      soft(sb.from('sharing').select('workouts, meals, plans, body').eq('user_id', user.id).limit(1)),
      soft(sb.rpc('am_i_verified')),
      soft(sb.from('posts').select('id').limit(1)),
      soft(sb.from('profiles').select('avatar_path').eq('user_id', user.id).limit(1))]).then(function (r) {
      var rows = { plans: r[0], workouts: r[1], schedule: r[2], sets: r[3], meals: r[4] };
      var prof = (r[5].data || [])[0], un = r[6], sh = r[7], verified = r[8], posts = r[9], av = r[10];
      var s = freshState();
      var planName = {};
      s.plans = rows.plans.map(function (p) { planName[p.id] = p.name; return { id: p.id, name: p.name, exercises: Array.isArray(p.exercises) ? p.exercises : [] }; });
      var wDate = {};
      rows.workouts.forEach(function (w) {
        if (!w.ended_at) return;
        wDate[w.id] = w.workout_date;
        s.workouts.push({ id: w.id, date: w.workout_date, start: Date.parse(w.started_at), end: Date.parse(w.ended_at), plan: w.plan_name || null, planId: w.plan_id || null });
      });
      rows.schedule.forEach(function (x) {
        s.schedule.push({ id: x.id, date: x.on_date, planId: x.plan_id, name: planName[x.plan_id] || '', repeat: !!x.repeat_weekly });
      });
      rows.sets.forEach(function (x) {
        if (!wDate[x.workout_id]) return;
        var e = { id: x.id, ex: x.exercise, kg: Number(x.weight_kg) || 0, reps: x.reps || 0, type: x.set_type || 'working',
          date: wDate[x.workout_id], ts: Date.parse(x.logged_at), wid: x.workout_id };
        if (x.is_cardio) { e.cardio = true; e.mins = Number(x.minutes) || 0; }
        s.entries.push(e);
      });
      rows.meals.forEach(function (x) {
        var m = { id: x.id, date: x.meal_date, name: x.name, kcal: Number(x.kcal) || 0, p: Number(x.protein) || 0,
          c: Number(x.carbs) || 0, f: Number(x.fats) || 0, ts: Date.parse(x.logged_at) };
        if (x.category) m.cat = x.category;
        if (x.nutrients) m.d = x.nutrients;
        if (x.product_info) m.info = x.product_info;
        if (x.amount_g) m.amt = Number(x.amount_g);
        s.meals.push(m);
      });
      if (prof) {
        if (prof.unit === 'kg' || prof.unit === 'lb') s.unit = prof.unit;
        s.bodyKg = Number(prof.body_kg) > 0 ? Number(prof.body_kg) : 0;
        s.calTarget = Number(prof.cal_target) > 0 ? Number(prof.cal_target) : 0;
        s.targets = prof.targets && typeof prof.targets === 'object' ? prof.targets : {};
        s.calc = Object.assign(s.calc, prof.calc && typeof prof.calc === 'object' ? prof.calc : {});
        s.bench = prof.bench && typeof prof.bench === 'object' ? prof.bench : {};
      }
      s.unameReady = !un.error;
      s.username = !un.error && un.data && un.data[0] ? String(un.data[0].username) : '';
      var shRow = !sh.error && sh.data && sh.data[0];
      s.socialReady = !sh.error;
      SHARE_KEYS.forEach(function (k) { if (shRow && SHARE_LV[shRow[k[0]]]) s.sharing[k[0]] = shRow[k[0]]; });
      s.verified = !verified.error && verified.data === true;
      s.postsReady = !posts.error;
      s.avatarsReady = !av.error;
      s.avatar = !av.error && av.data && av.data[0] && av.data[0].avatar_path ? String(av.data[0].avatar_path) : '';
      state = s;
      snapFromState(!!prof);
      state.loaded = true;
      readActive();
      seedProfile();
      seedUsername();
      return { empty: !rows.plans.length && !rows.workouts.length && !rows.meals.length };
    });
  }

  /* ---- bringing over data saved in this browser before accounts ---- */
  function readLegacy() {
    try {
      var d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (!d || typeof d !== 'object') return null;
      var n = { workouts: (d.workouts || []).length, plans: (d.plans || []).length, meals: (d.meals || []).length, sets: (d.entries || []).length };
      return n.workouts || n.plans || n.meals || n.sets ? { data: d, n: n } : null;
    } catch (e) { return null; }
  }
  function importLegacy() {
    var lg = readLegacy();
    if (!lg) return;
    var d = lg.data, map = {};
    function id2(k) { return map[k] || (map[k] = uid()); }
    var plans = (d.plans || []).filter(function (p) { return p && p.id; }).map(function (p) {
      return { id: id2('p' + p.id), name: String(p.name || 'Plan'), exercises: Array.isArray(p.exercises) ? p.exercises : [] };
    });
    var wks = [], byOld = {};
    (d.workouts || []).forEach(function (w) {
      if (!w || !w.id || !DATE_RE.test(w.date || '')) return;
      var st = num(w.start, Date.now());
      var nw = { id: id2('w' + w.id), date: w.date, start: st, end: num(w.end, st), plan: w.plan || null, planId: w.planId && map['p' + w.planId] ? map['p' + w.planId] : null };
      wks.push(nw); byOld[w.id] = nw;
    });
    var legacyDay = {}, ents = [];
    (d.entries || []).forEach(function (e) {
      if (!e || !e.ex || !DATE_RE.test(e.date || '')) return;
      var wk;
      if (e.wid) { wk = byOld[e.wid]; if (!wk) return; }
      else {
        wk = legacyDay[e.date];
        if (!wk) {
          var st = new Date(e.date + 'T12:00:00').getTime();
          wk = legacyDay[e.date] = { id: uid(), date: e.date, start: st, end: st, plan: null, planId: null };
          wks.push(wk);
        }
      }
      var ne = { id: uid(), ex: String(e.ex), kg: Math.max(0, num(e.kg, 0)), reps: Math.min(100, Math.max(0, Math.round(num(e.reps, 0)))),
        type: typeOf(e), date: wk.date, ts: num(e.ts, wk.start), wid: wk.id };
      if (e.cardio) { ne.cardio = true; ne.mins = Math.max(0, num(e.mins, 0)); }
      ents.push(ne);
    });
    var sched = (d.schedule || []).filter(function (s) { return s && map['p' + s.planId] && DATE_RE.test(s.date || ''); }).map(function (s) {
      return { id: uid(), date: s.date, planId: map['p' + s.planId], name: s.name || '', repeat: !!s.repeat };
    });
    var CATS = { breakfast: 1, lunch: 1, dinner: 1, snack: 1 };
    var meals = (d.meals || []).filter(function (m) { return m && m.name && DATE_RE.test(m.date || ''); }).map(function (m) {
      var nm = { id: uid(), date: m.date, name: String(m.name), kcal: num(m.kcal, 0), p: num(m.p, 0), c: num(m.c, 0), f: num(m.f, 0), ts: num(m.ts, Date.now()) };
      if (CATS[m.cat]) nm.cat = m.cat;
      if (m.d && typeof m.d === 'object') nm.d = m.d;
      if (m.info && typeof m.info === 'object') nm.info = m.info;
      if (num(m.amt, 0) > 0) nm.amt = num(m.amt, 0);
      return nm;
    });
    state.plans = state.plans.concat(plans);
    state.workouts = state.workouts.concat(wks);
    state.entries = state.entries.concat(ents);
    state.schedule = state.schedule.concat(sched);
    state.meals = state.meals.concat(meals);
    if (d.unit === 'kg' || d.unit === 'lb') state.unit = d.unit;
    if (num(d.bodyKg, 0) > 0) state.bodyKg = num(d.bodyKg, 0);
    if (num(d.calTarget, 0) > 0) state.calTarget = Math.round(num(d.calTarget, 0));
    if (d.calc && typeof d.calc === 'object') state.calc = Object.assign({}, state.calc, d.calc);
    if (d.bench && typeof d.bench === 'object') state.bench = d.bench;
    if (d.targets && typeof d.targets === 'object') state.targets = d.targets;
    ui.importOffer = null;
    ui.importMsg = 'Imported ' + wks.length + (wks.length === 1 ? ' workout, ' : ' workouts, ') + meals.length + (meals.length === 1 ? ' meal and ' : ' meals and ') + plans.length + (plans.length === 1 ? ' plan.' : ' plans.');
    persist();
    setTimeout(function () { ui.importMsg = ''; var n = $('notice'); if (n) n.innerHTML = noticeHTML(); }, 8000);
  }
  function noticeHTML() {
    if (ui.importOffer) {
      var n = ui.importOffer;
      return '<div class="card"><h3>Bring over your saved data?</h3><p class="sub" style="margin:4px 0 12px">This browser has ' +
        n.workouts + (n.workouts === 1 ? ' workout, ' : ' workouts, ') + n.meals + (n.meals === 1 ? ' meal and ' : ' meals and ') + n.plans + (n.plans === 1 ? ' plan' : ' plans') +
        ' from before accounts. Add them to your account?</p><div class="benchbtns"><button type="button" class="primary" data-a="auth-import">Import</button>' +
        '<button type="button" class="secondary" data-a="auth-skipimport">Skip</button></div></div>';
    }
    return ui.importMsg ? '<p class="sub">' + esc(ui.importMsg) + '</p>' : '';
  }

  /* ---- sign up, log in, log out ---- */
  function friendly(e) {
    var m = (e && e.message) || '';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Could not reach the server. Check your connection.';
    if (/invalid login/i.test(m)) return 'That email and password do not match.';
    if (/not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link.';
    if (/already registered/i.test(m)) return 'That email already has an account. Try logging in.';
    if (/database error saving new user/i.test(m)) return 'That username was just taken. Try another one.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a few minutes and try again.';
    return m || 'Something went wrong. Try again.';
  }
  function resetAll() {
    user = null;
    state = freshState();
    ui = freshUi();
    snap = emptySnap();
    auth.checking = false; auth.busy = false; auth.mode = 'in'; auth.pw = ''; auth.err = ''; auth.loadErr = '';
    render();
  }
  function startSession(u) {
    if (user && user.id === u.id) return;
    user = u;
    auth.checking = true; auth.loadErr = '';
    render();
    loadRemote().then(function (res) {
      auth.checking = false;
      var lg = res.empty ? readLegacy() : null;
      ui.importOffer = lg ? lg.n : null;
      ui.tab = state.active ? 'workout' : 'plans';
      if (state.socialReady && state.username) { loadFriends(); loadMyStats(); }
      render();
    }).catch(function () {
      auth.checking = false;
      auth.loadErr = 'Could not load your data. Check your connection and try again.';
      render();
    });
  }
  function initAuth() {
    if (!window.supabase || !window.supabase.createClient) {
      auth.fatal = 'Could not load the sign-in service. Check your connection and reload the page.';
      auth.checking = false; render(); return;
    }
    try { sb = window.supabase.createClient(SB_URL, SB_KEY); }
    catch (e) { auth.fatal = 'Could not start the sign-in service.'; auth.checking = false; render(); return; }
    sb.auth.onAuthStateChange(function (event, session) {
      setTimeout(function () {
        if (event === 'PASSWORD_RECOVERY') { auth.recovery = true; auth.checking = false; render(); }
        if (event === 'SIGNED_OUT') { resetAll(); return; }
        if (session && session.user) startSession(session.user);
        else if (event === 'INITIAL_SESSION') { auth.checking = false; render(); }
      }, 0);
    });
  }
  function authSubmit() {
    if (auth.busy || !sb) return;
    var email = String(auth.email || '').trim(), pw = auth.pw || '';
    auth.err = ''; auth.msg = '';
    function fail(msg, id) { auth.err = msg; auth.focusId = id; render(); }
    if (auth.recovery) {
      if (pw.length < 8) return fail('Use at least 8 characters.', 'au-pw');
      auth.busy = true; render();
      sb.auth.updateUser({ password: pw }).then(function (r) {
        auth.busy = false;
        if (r.error) auth.err = friendly(r.error); else { auth.recovery = false; auth.pw = ''; }
        render();
      });
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.', 'au-email');
    if (auth.mode === 'reset') {
      auth.busy = true; render();
      sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) {
        auth.busy = false;
        if (r.error) auth.err = friendly(r.error); else { auth.msg = 'If that email has an account, a reset link is on its way.'; auth.mode = 'in'; }
        render();
      });
      return;
    }
    if (!pw) return fail('Enter your password.', 'au-pw');
    if (auth.mode === 'up' && pw.length < 8) return fail('Use at least 8 characters.', 'au-pw');
    var pr = null, un = null;
    if (auth.mode === 'up') {
      un = readUsername(auth.uname);
      if (un.err) return fail(un.err, 'au-uname');
      pr = readProfile(auth.first, auth.last, auth.age, auth.gender, auth.wt, auth.wunit, 'au-');
      if (pr.err) return fail(pr.err, pr.id);
      if (!auth.agree) return fail('Agree to the Privacy Policy to create an account.', 'au-agree');
    }
    auth.busy = true; render();
    // A quick check gives a friendly message; the database still has the final say when the account is created.
    var free = un ? sb.rpc('username_available', { name: un.u }).then(function (r) { return r.error ? true : r.data !== false; }, function () { return true; }) : Promise.resolve(true);
    free.then(function (ok) {
    if (!ok) { auth.busy = false; return fail('That username is taken. Try another one.', 'au-uname'); }
    var req = auth.mode === 'up'
      ? sb.auth.signUp({ email: email, password: pw, options: { emailRedirectTo: location.origin + location.pathname,
          data: { username: un.u, name: pr.name, first_name: pr.first, last_name: pr.last, age: pr.age, gender: pr.gender, weight_kg: Math.round(pr.kg * 1000) / 1000, unit: auth.wunit, privacy_accepted: new Date().toISOString() } } })
      : sb.auth.signInWithPassword({ email: email, password: pw });
    req.then(function (r) {
      auth.busy = false; auth.pw = '';
      if (r.error) auth.err = friendly(r.error);
      else if (auth.mode === 'up' && !(r.data && r.data.session)) { auth.msg = 'Check your email for a confirmation link, then log in.'; auth.mode = 'in'; }
      render();
    });
    });
  }
  function authAction(a, t) {
    if (a === 'auth-mode') { auth.mode = t.dataset.v; auth.err = ''; auth.msg = ''; auth.pw = ''; auth.focusId = 'au-email'; render(); }
    else if (a === 'auth-out') {
      if (sb) sb.auth.signOut({ scope: 'local' }).then(function () { if (user) resetAll(); });
    } else if (a === 'auth-policy') { if (user) ui.policy = true; else auth.policy = true; render(); window.scrollTo(0, 0); }
    else if (a === 'auth-policyback') { if (user) ui.policy = false; else auth.policy = false; render(); window.scrollTo(0, 0); }
    else if (a === 'auth-retry') { var u = user; user = null; if (u) startSession(u); }
    else if (a === 'auth-delask') { ui.delOpen = true; ui.delText = ''; ui.delErr = ''; render(); var di = $('del-confirm'); if (di) { di.focus(); di.scrollIntoView({ block: 'center' }); } }
    else if (a === 'auth-delcancel') { ui.delOpen = false; ui.delText = ''; ui.delErr = ''; render(); }
    else if (a === 'auth-delgo') deleteAccount();
    else if (a === 'auth-import') { importLegacy(); render(); }
    else if (a === 'auth-skipimport') { ui.importOffer = null; var n = $('notice'); if (n) n.innerHTML = ''; }
  }
  /* ---- deleting an account (runs the delete_my_account function in Supabase) ---- */
  function footHTML() {
    if (!ui.delOpen) return '<div class="dzone"><button type="button" class="linkbtn mute" data-a="auth-delask">Delete account</button></div>';
    return '<div class="card" style="margin-top:28px"><h3>Delete your account?</h3><p class="sub" style="margin:4px 0 12px">This permanently deletes your login and everything saved: workouts, plans, meals, records and targets. It cannot be undone.</p>' +
      '<div class="field"><label for="del-confirm">Type DELETE to confirm</label><input id="del-confirm" autocomplete="off" autocapitalize="characters" value="' + esc(ui.delText || '') + '"></div>' +
      (ui.delErr ? '<p class="err">' + esc(ui.delErr) + '</p>' : '') +
      '<div class="benchbtns" style="margin-top:12px"><button type="button" class="primary delbtn" id="del-go" data-a="auth-delgo"' +
      ((ui.delText || '').trim().toUpperCase() === 'DELETE' && !ui.delBusy ? '' : ' disabled') + '>' + (ui.delBusy ? 'Deleting...' : 'Delete everything') + '</button>' +
      '<button type="button" class="secondary" data-a="auth-delcancel">Cancel</button></div></div>';
  }
  function deleteAccount() {
    if (!sb || !user || ui.delBusy || (ui.delText || '').trim().toUpperCase() !== 'DELETE') return;
    ui.delBusy = true; ui.delErr = '';
    render();
    writeQueue.then(removeMyPhotos).then(function () { return sb.rpc('delete_my_account'); }).then(function (r) {
      if (r && r.error) throw r.error;
      try { localStorage.removeItem(activeKey()); } catch (e) { /* ignore */ }
      state.loaded = false;
      auth.msg = 'Your account and all its data have been deleted.';
      auth.email = '';
      var done = function () { if (user) resetAll(); };
      sb.auth.signOut({ scope: 'local' }).then(done, done);
    }).catch(function (e) {
      ui.delBusy = false;
      ui.delErr = /does not exist|function/i.test((e && e.message) || '') ? 'Account deletion is not set up in Supabase yet. Run the delete_my_account SQL first.' : friendly(e);
      render();
    });
  }

    /* ---------- Privacy policy ---------- */
  var POLICY_DATE = '21 October 2026';
  var POLICY_CONTACT = ''; // put an email address here to show it in the policy
  function policyHTML() {
    var li = function (a) { return '<ul>' + a.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>'; };
    return '<h2>Privacy policy</h2><p class="upd">Last updated ' + POLICY_DATE + '</p>' +
      '<p>Lifts is a free app for logging workouts and meals. This policy explains what it stores about you, where it goes and what you can do about it. The person who runs Lifts is the controller of your data under UK data protection law.</p>' +
      '<h3>What we collect</h3>' + li([
        '<b>Your account:</b> your email address and password. Your password is handled by our sign-in provider and stored in scrambled form. We never see it.',
        '<b>About you:</b> your @username, first and last name, age, gender and weight, which you give when you sign up. Later you may add your height, activity level and calorie goal to the calorie calculator.',
        '<b>What you log:</b> workouts, sets, reps, weights, cardio, plans, schedule, meals and nutrition details, targets and benchmarks.',
        '<b>What you share:</b> your friends list, your privacy settings, your profile photo if you add one, and any photos and captions you post.',
        '<b>On your device:</b> a sign-in token and any workout you are halfway through are kept in your browser storage so the app works between visits.']) +
      '<p>Some of this, such as your weight, what you eat and your gender, is information about your health. We only collect it because you choose to enter it, and by creating an account you agree to us using it to run the app for you.</p>' +
      '<h3>How we use it</h3>' + li([
        'To show your own workouts, meals, records, recaps and targets back to you, on any device you log in on.',
        'To work out estimates such as calories burned, maintenance calories and nutrient targets.',
        'To show your friends the parts of your profile your Privacy settings allow, and to show posts and leaderboards to you and your friends.',
        'To sign you in and keep your account secure.']) +
      '<p>Your name, @username, profile photo and any verified tick can be seen by anyone signed in to Lifts who searches for you. Everything else follows your Privacy settings in the Profile page: each part can be public, friends only, or only you. Photos you post are only shown to you and your friends.</p>' +
      '<p>We do not sell your data, show adverts, build advertising profiles or use analytics trackers. We do not share your data with anyone except the people your Privacy settings allow and the services below that make the app work.</p>' +
      '<h3>Who handles your data</h3>' + li([
        '<b>Supabase</b> stores your account and everything you log in its database and handles sign-in. Your data is only readable by your own login, apart from what your Privacy settings share. Photos are stored privately and reached only through short-lived links.',
        '<b>GitHub Pages</b> hosts the app\'s page. Like any website host, it can see technical details such as your IP address when you load the page.',
        '<b>jsDelivr</b> and <b>Google Fonts</b> deliver code and fonts the app needs, so they also see your IP address when the page loads.',
        '<b>Open Food Facts</b> is asked about a barcode number when you scan or type one. Only the number is sent, never your account details.']) +
      '<p>Scanning uses your camera on your device. Camera images from scanning are not recorded, saved or uploaded. Photos you choose to post are shrunk on your device first, which also removes hidden details such as location, and then uploaded.</p>' +
      '<h3>How long we keep it</h3><p>Until you delete your account. Deleting your account from the Profile page permanently removes your login and everything you saved, straight away. It cannot be undone. Anything stored only in your own browser can be cleared in your browser settings.</p>' +
      '<h3>Your rights</h3><p>Under UK GDPR you can see your data (it is all shown in the app), correct it (edit it in the app), delete it (Delete account), ask for a copy of it, object to how it is used, or withdraw your agreement at any time by deleting your account. If you are unhappy with how your data is handled you can complain to the Information Commissioner\'s Office at ico.org.uk.' +
      (POLICY_CONTACT ? ' To ask for a copy or anything else, email ' + esc(POLICY_CONTACT) + '.' : '') + '</p>' +
      '<h3>Where it is stored</h3><p>Supabase and the other services above may process data outside the UK. They are responsible for protecting it to the standards they publish.</p>' +
      '<h3>Children</h3><p>Lifts is for people aged 13 and over. Do not create an account if you are younger than 13.</p>' +
      '<h3>Not medical advice</h3><p>Calorie, nutrient and calorie-burn figures are estimates. They are not medical advice. Speak to a doctor or dietitian before making big changes to your diet or exercise.</p>' +
      '<h3>Changes</h3><p>If this policy changes, the date at the top will change. We will not use your data for anything new without asking you first.</p>';
  }
  function policyPage(backAct) {
    return policyHTML() + '<div class="benchbtns" style="margin-top:14px"><button type="button" class="secondary" data-a="' + backAct + '">Back</button></div>';
  }
  var GENDERS = [['m', 'Male'], ['f', 'Female'], ['o', 'Other']];
  function genderOpts(sel) { return GENDERS.map(function (g) { return '<option value="' + g[0] + '"' + (sel === g[0] ? ' selected' : '') + '>' + g[1] + '</option>'; }).join(''); }
  function genderName(v) { var g = GENDERS.filter(function (x) { return x[0] === v; })[0]; return g ? g[1] : ''; }
  // Checks the four profile answers. Returns { err, id } or { name, age, gender, kg }.
  function readProfile(first, last, age, gender, wt, unit, p) {
    first = String(first || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    last = String(last || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    var a = Number(String(age).trim()), w = Number(String(wt).trim().replace(',', '.'));
    if (!first) return { err: 'Enter your first name.', id: p + 'first' };
    if (!last) return { err: 'Enter your last name.', id: p + 'last' };
    if (!(a >= 13 && a <= 100) || a !== Math.round(a)) return { err: 'Enter your age as a whole number from 13 to 100.', id: p + 'age' };
    if (!gender) return { err: 'Choose a gender.', id: p + 'gender' };
    var kg = unit === 'lb' ? w / LB : w;
    if (!isFinite(w) || !(kg >= 25 && kg <= 400)) return { err: 'Enter your weight, for example ' + (unit === 'lb' ? '165' : '75') + '.', id: p + 'wt' };
    return { first: first, last: last, name: (first + ' ' + last).slice(0, 81), age: a, gender: gender, kg: kg };
  }

  function renderAuth() {
    if (auth.policy && !auth.fatal) { $('auth').innerHTML = '<div class="authcard policy">' + policyPage('auth-policyback') + '</div>'; return; }
    var h = '<div class="authcard">';
    if (auth.fatal) h += '<h2>Lifts</h2><p class="err">' + esc(auth.fatal) + '</p>';
    else if (auth.loadErr) h += '<h2>Lifts</h2><p class="err">' + esc(auth.loadErr) + '</p><div class="benchbtns"><button type="button" class="primary" data-a="auth-retry">Try again</button><button type="button" class="secondary" data-a="auth-out">Log out</button></div>';
    else if (auth.checking) h += '<p class="sub">Loading...</p>';
    else {
      var rec = auth.recovery, up = auth.mode === 'up', reset = auth.mode === 'reset';
      h += '<form id="authform" novalidate><h2>' + (rec ? 'Choose a new password' : up ? 'Create account' : reset ? 'Reset password' : 'Log in') + '</h2>';
      if (!rec) h += '<div class="field"><label for="au-email">Email</label><input id="au-email" type="email" data-au="email" autocomplete="email" inputmode="email" value="' + esc(auth.email) + '"></div>';
      if (!reset) h += '<div class="field"><label for="au-pw">' + (rec ? 'New password' : 'Password') + '</label><input id="au-pw" type="password" data-au="pw" autocomplete="' + (up || rec ? 'new-password' : 'current-password') + '"></div>';
      if (up) {
        h += unameField('au-', auth.uname) + nameFields('au-', auth) +
          '<div class="frow"><div class="field"><label for="au-age">Age</label><input id="au-age" data-au="age" inputmode="numeric" autocomplete="off" value="' + esc(auth.age) + '"></div>' +
          '<div class="field"><label for="au-gender">Gender</label><select id="au-gender" data-au="gender"><option value=""></option>' + genderOpts(auth.gender) + '</select></div></div>' +
          '<div class="frow"><div class="field"><label for="au-wt">Weight</label><input id="au-wt" data-au="wt" inputmode="decimal" autocomplete="off" value="' + esc(auth.wt) + '"></div>' +
          '<div class="field"><label for="au-wunit">Unit</label><select id="au-wunit" data-au="wunit"><option value="kg"' + (auth.wunit === 'kg' ? ' selected' : '') + '>kg</option><option value="lb"' + (auth.wunit === 'lb' ? ' selected' : '') + '>lb</option></select></div></div>';
      }
      if (up) h += '<div class="agree"><input type="checkbox" id="au-agree"' + (auth.agree ? ' checked' : '') + '><label for="au-agree">I agree to the</label><button type="button" class="linkbtn" data-a="auth-policy">Privacy Policy</button></div>';
      if (auth.err) h += '<p class="err">' + esc(auth.err) + '</p>';
      if (auth.msg) h += '<p class="msg">' + esc(auth.msg) + '</p>';
      h += '<button class="submit" type="submit"' + (auth.busy ? ' disabled' : '') + '>' + (auth.busy ? 'Please wait...' : rec ? 'Save password' : up ? 'Create account' : reset ? 'Send reset link' : 'Log in') + '</button></form>';
      if (!rec) {
        h += '<div class="authlinks">' + (up || reset ? '<button type="button" class="linkbtn" data-a="auth-mode" data-v="in">Back to log in</button>'
          : '<button type="button" class="linkbtn" data-a="auth-mode" data-v="up">Create an account</button><button type="button" class="linkbtn" data-a="auth-mode" data-v="reset">Forgot password?</button>') +
          '<button type="button" class="linkbtn mute" data-a="auth-policy">Privacy Policy</button></div>';
      }
    }
    $('auth').innerHTML = h + '</div>';
    if (auth.focusId) { var f = $(auth.focusId); if (f) f.focus(); auth.focusId = null; }
  }

  /* ---------- PR analysis ---------- */
  // Walks every set in date order. A lift's first session is its baseline, so nothing in it counts as a PR.
  function analyze(entries) {
    var out = {};
    var per = {};
    entries.slice().sort(cmpEntries).forEach(function (e) {
      if (!counts(e)) { out[e.id] = { first: false, types: [] }; return; }
      var k = key(e.ex);
      var s = per[k] || (per[k] = { base: grp(e), maxKg: -1, maxE: -1, sets: [] });
      var res = { first: grp(e) === s.base, types: [] };
      var ee = e1rm(e.kg, e.reps);
      if (!res.first) {
        if (e.kg > s.maxKg + EPS) res.types.push({ t: 'weight', prev: s.maxKg });
        if (ee !== null && s.maxE > 0 && ee > s.maxE + 0.05) res.types.push({ t: 'e1rm', prev: s.maxE });
        var atOrAbove = s.sets.filter(function (x) { return x.kg >= e.kg - EPS; });
        if (atOrAbove.length) {
          var mr = Math.max.apply(null, atOrAbove.map(function (x) { return x.reps; }));
          if (e.reps > mr) res.types.push({ t: 'reps', prev: mr });
        }
      }
      s.maxKg = Math.max(s.maxKg, e.kg);
      if (ee !== null) s.maxE = Math.max(s.maxE, ee);
      s.sets.push({ kg: e.kg, reps: e.reps });
      out[e.id] = res;
    });
    return out;
  }
  // Collapses the flagged sets of one lift in one workout into one line per PR type.
  function exPRs(sets, flags) {
    var res = { lines: [], base: false };
    var by = { weight: [], e1rm: [], reps: [] };
    sets.forEach(function (e) {
      var f = flags[e.id];
      if (!f) return;
      if (f.first) res.base = true;
      f.types.forEach(function (t) { by[t.t].push({ e: e, t: t }); });
    });
    var u = state.unit;
    if (by.weight.length) {
      var w0 = by.weight[0], w1 = by.weight[by.weight.length - 1];
      res.lines.push('Weight PR: ' + fmtW(w1.e.kg) + ' ' + u + ', up from ' + fmtW(w0.t.prev) + ' ' + u);
    }
    if (by.e1rm.length) {
      var q0 = by.e1rm[0], q1 = by.e1rm[by.e1rm.length - 1];
      res.lines.push('Est. 1RM PR: ' + fmtW(e1rm(q1.e.kg, q1.e.reps)) + ' ' + u + ', up from ' + fmtW(q0.t.prev) + ' ' + u);
    }
    if (by.reps.length) {
      var r1 = by.reps[by.reps.length - 1];
      res.lines.push('Rep PR: ' + r1.e.reps + ' reps at ' + fmtW(r1.e.kg) + ' ' + u + ' (previous best ' + r1.t.prev + ')');
    }
    return res;
  }
  function bests(k) {
    var heavy = null, est = null, estVal = -1;
    state.entries.forEach(function (e) {
      if (key(e.ex) !== k || !counts(e)) return;
      if (!heavy || e.kg > heavy.kg + EPS || (Math.abs(e.kg - heavy.kg) <= EPS && e.reps > heavy.reps)) heavy = e;
      var v = e1rm(e.kg, e.reps);
      if (v !== null && v > estVal) { estVal = v; est = e; }
    });
    return { heavy: heavy, est: est, estVal: estVal };
  }
  function lastSession(k, exWid) {
    var best = null;
    state.entries.forEach(function (e) {
      if (key(e.ex) !== k || e.type === 'warmup' || (exWid && e.wid === exWid)) return;
      if (!best || cmpEntries(best, e) < 0) best = e;
    });
    if (!best) return [];
    var g = grp(best);
    return state.entries.filter(function (e) { return key(e.ex) === k && e.type !== 'warmup' && grp(e) === g; }).sort(cmpEntries);
  }
  /* ---------- shared bits of markup ---------- */
  var TYPES = [['warmup', 'Warmup'], ['working', 'Working'], ['drop', 'Drop']];
  // Only working sets of strength lifts count towards PRs and records.
  function counts(e) { return !e.cardio && e.type !== 'warmup' && e.type !== 'drop'; }
  function typeOf(e) { return e.type === 'warmup' || e.type === 'drop' ? e.type : 'working'; }
  function fmtMins(m) { return String(+Number(m).toFixed(1)); }
  function setText(e) {
    return e.cardio ? fmtMins(e.mins) + ' min' : fmtW(e.kg) + ' ' + state.unit + ' \u00D7 ' + e.reps;
  }
  function chips(info) {
    if (!info || !info.types.length) return '';
    var map = { weight: 'Weight PR', e1rm: 'Est. 1RM PR', reps: 'Rep PR' };
    return info.types.map(function (t) { return '<span class="chip pr">' + map[t.t] + '</span>'; }).join('');
  }
  function typeChip(e) {
    if (e.cardio) return '';
    var t = typeOf(e);
    return '<span class="tchip ' + t + '">' + (t === 'warmup' ? 'Warmup' : t === 'drop' ? 'Drop' : 'Working') + '</span>';
  }
  function setLine(sets, flags) {
    return '<div class="setline">' + sets.map(function (e) {
      return '<span class="s">' + setText(e) + typeChip(e) + chips(flags[e.id]) + '</span>';
    }).join('') + '</div>';
  }
  function recapRows(sets, flags) {
    return groupByEx(sets).map(function (g) {
      var p = exPRs(g.sets, flags);
      return '<div class="exrow"><span class="name">' + esc(g.name) + '</span>' +
        (g.sets[0].cardio ? '<span class="chip">Cardio</span>' : '') +
        (p.base ? '<span class="chip">Baseline</span>' : '') + setLine(g.sets, flags) + '</div>';
    }).join('');
  }

  /* ---------- Workout tab ---------- */
  function getDraft(k) { return ui.drafts[k] || (ui.drafts[k] = { w: '', r: '', m: '', type: 'working', manual: false }); }

  // What to compare against: the saved benchmark if there is one, otherwise the last session.
  function reference(k, exWid) {
    var b = state.bench[k];
    if (b && b.sets && b.sets.length) return { label: 'Benchmark', date: b.date, sets: b.sets };
    var s = lastSession(k, exWid);
    if (!s.length) return null;
    return {
      label: 'Last time', date: s[0].date,
      sets: s.map(function (e) { return { kg: e.kg, reps: e.reps, mins: e.mins || 0, cardio: !!e.cardio, type: typeOf(e) }; })
    };
  }
  function refText(sets) {
    return sets.slice(0, 8).map(function (s) {
      return s.cardio ? fmtMins(s.mins) + ' min' : fmtW(s.kg) + ' \u00D7 ' + s.reps + (s.type === 'drop' ? ' (drop)' : '');
    }).join(', ');
  }
  function prefill(name) {
    var k = key(name), d = getDraft(k);
    var ref = reference(k, state.active ? state.active.id : null);
    if (!ref) return;
    var pool = ref.sets.filter(function (s) { return s.type !== 'drop'; });
    var last = (pool.length ? pool : ref.sets)[(pool.length ? pool : ref.sets).length - 1];
    if (last.cardio) d.m = fmtMins(last.mins);
    else { d.w = fmtW(last.kg); d.r = String(last.reps); }
  }

  function unitToggleHTML() {
    return '<div class="unit" role="group" aria-label="Weight unit">' + ['kg', 'lb'].map(function (u) {
      return '<button type="button" data-a="unit" data-unit="' + u + '" aria-pressed="' + (state.unit === u) + '">' + u + '</button>';
    }).join('') + '</div>';
  }

  // Planned sets are slots like ['warmup', 'working', 'working', 'drop']. A logged set fills the first
  // open slot of its own type; whatever is left open is still to do.
  function exStatus(a, name) {
    var k = key(name);
    var sets = state.entries.filter(function (e) { return e.wid === a.id && key(e.ex) === k; }).sort(cmpEntries);
    var cardio = !!(a.cardio && a.cardio[k]);
    var tg = (a.targets || {})[k];
    var slots = tg ? (cardio ? ['working'] : planSlots(tg)) : [];
    var have = { warmup: 0, working: 0, drop: 0 };
    sets.forEach(function (e) { have[cardio ? 'working' : typeOf(e)]++; });
    var seen = { warmup: 0, working: 0, drop: 0 };
    var pending = [], filled = 0;
    slots.forEach(function (t) {
      seen[t]++;
      if (seen[t] <= have[t]) filled++; else pending.push(t);
    });
    return { k: k, sets: sets, cardio: cardio, slots: slots, pending: pending, next: pending[0] || null,
      filled: filled, target: slots.length, done: slots.length > 0 && !pending.length };
  }
  function activeHTML() {
    var a = state.active;
    var withT = a.exercises.map(function (n) { return exStatus(a, n); }).filter(function (s) { return s.target > 0; });
    var doneN = withT.filter(function (s) { return s.done; }).length;
    var html = '<div class="wkhead"><div><div class="elapsed num" id="elapsed">' + fmtDur(Date.now() - a.start) + '</div>' +
      '<div class="sub">' + esc((a.plan ? a.plan + ' in progress' : 'Workout in progress') + (withT.length ? ' \u00B7 ' + doneN + ' of ' + withT.length + ' done' : '')) + '</div></div>' +
      '<div class="wkright">' + unitToggleHTML() + '</div></div>';

    a.exercises.forEach(function (name, i) {
      var st = exStatus(a, name);
      var d = getDraft(st.k);
      var ref = reference(st.k, a.id);
      if (!d.manual) d.type = st.next || 'working';
      html += '<div class="ex' + (st.done ? ' done' : '') + '"><div class="exhead"><h3>' +
        (st.done ? '<span class="tick" aria-label="All sets done">\u2713</span> ' : '') + esc(name) +
        (st.cardio ? ' <span class="chip">Cardio</span>' : '') + '</h3>' +
        (st.sets.length ? '' : '<button type="button" class="linkbtn mute" data-a="rmex" data-i="' + i + '">Remove</button>') + '</div>';
      if (st.target) {
        html += '<p class="tgt">' + (st.cardio ? 'Cardio planned' : 'Plan: ' + slotsLabel(st.slots)) + ' \u00B7 ' +
          st.filled + ' of ' + st.target + ' done</p>';
      }
      if (ref) {
        html += '<p class="last">' + ref.label + ' (' + fmtDate(ref.date) + '): ' + esc(refText(ref.sets)) +
          (st.cardio ? '' : ' ' + state.unit) + '</p>';
      }

      st.sets.forEach(function (e) {
        var t = typeOf(e);
        html += '<div class="srow ' + t + '"><span class="load">' + setText(e) + '</span>' +
          typeChip(e) + '<span class="tick" role="img" aria-label="Completed">\u2713</span>' +
          '<button type="button" class="linkbtn" data-a="rmset" data-id="' + e.id + '" aria-label="Remove this ' + (e.cardio ? 'cardio' : typeName(t).toLowerCase()) + ' set of ' + esc(name) + '">Remove</button></div>';
      });
      st.pending.forEach(function (t) {
        html += '<div class="srow pending ' + t + '"><span class="load">' +
          (st.cardio ? 'Cardio' : t === 'warmup' ? 'Warmup set' : t === 'drop' ? 'Drop set' : 'Working set') +
          '</span></div>';
      });

      if (st.cardio) {
        html += '<div class="entry c1"><div class="field"><label for="m' + i + '">Minutes</label><input id="m' + i + '" data-dm="' + i + '" inputmode="decimal" autocomplete="off" value="' + esc(d.m) + '"></div>' +
          '<button type="button" class="primary" data-a="addset" data-i="' + i + '">Add</button></div>';
      } else {
        html += '<div class="typesel" role="group" aria-label="Set type">' + TYPES.map(function (t) {
          return '<button type="button" class="tbtn ' + t[0] + '" data-a="settype" data-i="' + i + '" data-v="' + t[0] + '" aria-pressed="' + (d.type === t[0]) + '">' + t[1] + '</button>';
        }).join('') + '</div>' +
          '<div class="entry">' +
          '<div class="field"><label for="w' + i + '">Weight (' + state.unit + ')</label><input id="w' + i + '" data-dw="' + i + '" inputmode="decimal" autocomplete="off" value="' + esc(d.w) + '"></div>' +
          '<div class="field"><label for="r' + i + '">Reps</label><input id="r' + i + '" data-dr="' + i + '" inputmode="numeric" autocomplete="off" value="' + esc(d.r) + '"></div>' +
          '<button type="button" class="primary" data-a="addset" data-i="' + i + '">Add set</button></div>';
      }
      if (ui.err && ui.err.i === i) html += '<p class="err">' + esc(ui.err.msg) + '</p>';
      html += '</div>';
    });

    html += '<div class="addex"><div class="row"><div class="field"><label for="newex">Add exercise</label>' +
      '<input id="newex" autocomplete="off" value="' + esc(ui.newEx) + '"></div>' +
      '<button type="button" class="secondary" data-a="addex" style="align-self:flex-end">Add</button></div>' +
      '<label class="chk" style="margin-top:8px"><input type="checkbox" data-a="newcardio"' + (ui.newCardio ? ' checked' : '') + '> Cardio (log minutes instead of reps)</label></div>';

    html += '<div class="endrow">' + (ui.err && ui.err.i === -1 ? '<p class="err" role="alert">' + esc(ui.err.msg) + '</p>' : '') +
      '<button type="button" class="submit" data-a="finish">Finish workout</button>' +
      '<button type="button" class="linkbtn danger mute' + (ui.armed === 'discard' ? ' armed' : '') + '" data-a="discard">' +
      (ui.armed === 'discard' ? 'Tap again to discard this workout' : 'Discard workout') + '</button></div>';
    return html;
  }

  /* ---------- calories burned (estimate: MET x body weight x hours) ---------- */
  var STRENGTH_MET = 4.0;
  function metFor(name) {
    var n = String(name).toLowerCase();
    if (/sprint/.test(n)) return 12;
    if (/skip|jump rope/.test(n)) return 11;
    if (/run|jog/.test(n)) return 9.8;
    if (/stair|step ?mill|climb/.test(n)) return 9;
    if (/hiit|circuit/.test(n)) return 8;
    if (/cycl|bike|spin/.test(n)) return 7.5;
    if (/row/.test(n)) return 7;
    if (/swim/.test(n)) return 7;
    if (/elliptic|cross.?trainer/.test(n)) return 5;
    if (/walk|hike/.test(n)) return 3.8;
    return 7;
  }
  function bodyKg() {
    if (state.bodyKg > 0) return state.bodyKg;
    if (state.calc && state.calc.kg > 0) return state.calc.kg;
    return 75;
  }
  function burnCalc(w, sets) {
    var kg = bodyKg();
    var total = 0, lines = [], cardio = {}, cardioMin = 0;
    sets.forEach(function (e) {
      if (!e.cardio) return;
      var k = key(e.ex);
      cardio[k] = cardio[k] || { name: e.ex, mins: 0 };
      cardio[k].mins += Number(e.mins) || 0;
    });
    Object.keys(cardio).forEach(function (k) {
      var c = cardio[k];
      cardioMin += c.mins;
      var kc = metFor(c.name) * kg * c.mins / 60;
      total += kc;
      lines.push({ label: c.name + ' \u00B7 ' + fmtMins(c.mins) + ' min', kcal: kc });
    });
    if (sets.some(function (e) { return !e.cardio; }) && w.start && w.end) {
      var sm = Math.max(0, (w.end - w.start) / 60000 - cardioMin);
      var kc2 = STRENGTH_MET * kg * sm / 60;
      total += kc2;
      lines.unshift({ label: 'Strength \u00B7 ' + Math.round(sm) + ' min', kcal: kc2 });
    }
    return { total: total, lines: lines, kg: kg, known: !!(state.bodyKg > 0 || (state.calc && state.calc.kg > 0)) };
  }
  function burnHTML(b) {
    if (!(b.total > 0)) return '';
    return '<div class="burn"><div class="stat"><span class="num">~' + fmtK(b.total) + '</span><span class="l">kcal burned (estimate)</span></div>' +
      b.lines.map(function (l) {
        return '<div class="nutrow"><span>' + esc(l.label) + '</span><span>' + fmtK(l.kcal) + ' kcal</span></div>';
      }).join('') +
      '<div class="field bw"><label for="bw">Your weight (' + state.unit + ')' + (b.known ? '' : ', assuming ' + fmtW(75) + ' ' + state.unit) + '</label>' +
      '<input id="bw" inputmode="decimal" autocomplete="off" value="' + (b.known ? fmtW(b.kg) : '') + '"></div></div>';
  }
  function burnLine(it, sets) {
    if (it.legacy) return '';
    var b = burnCalc(it, sets);
    return b.total > 0 ? '<p class="sub" style="margin:2px 0 6px">About ' + fmtK(b.total) + ' kcal burned (estimate)</p>' : '';
  }

  // Weight x reps for working and drop sets, the same total the leaderboard uses.
  function volOf(wid) {
    return state.entries.reduce(function (s, e) { return e.wid === wid && !e.cardio && e.type !== 'warmup' ? s + e.kg * e.reps : s; }, 0);
  }
  function movedHTML(w, vol) {
    if (!(vol > 0)) return '';
    var prev = w.plan ? state.workouts.filter(function (x) { return x.id !== w.id && x.plan === w.plan && x.start < w.start; })
      .sort(function (a, b) { return b.start - a.start; })[0] : null;
    var pv = prev ? volOf(prev.id) : 0, cmp = '';
    if (pv > 0) {
      var pct = Math.round((vol - pv) / pv * 100);
      cmp = pct === 0 ? '<span class="cmp">Same as your last ' + esc(w.plan) + '</span>'
        : '<span class="cmp ' + (pct > 0 ? 'up' : 'down') + '">' + (pct > 0 ? '+' : '\u2212') + Math.abs(pct) + '% vs your last ' + esc(w.plan) + '</span>';
    }
    return '<div class="moved"><span class="l">Total weight moved</span><span class="num">' + Math.round(toDisp(vol)).toLocaleString('en-GB') +
      '<small>' + state.unit + '</small></span>' + cmp + '</div>';
  }
  function summaryHTML(w) {
    var flags = analyze(state.entries);
    var all = state.entries.filter(function (e) { return e.wid === w.id; }).sort(cmpEntries);
    var groups = groupByEx(all);
    var lifted = all.filter(function (e) { return !e.cardio && e.type !== 'warmup'; });
    var vol = lifted.reduce(function (s, e) { return s + e.kg * e.reps; }, 0);
    var infos = groups.map(function (g) { return { g: g, p: exPRs(g.sets, flags) }; });
    var total = infos.reduce(function (s, x) { return s + x.p.lines.length; }, 0);

    var html = '<h2>' + esc(w.plan ? w.plan + ' complete' : 'Workout complete') + '</h2>' + movedHTML(w, vol) + '<div class="mstats">' +
      '<div class="stat"><span class="num">' + fmtDur(w.end - w.start) + '</span><span class="l">Time</span></div>' +
      '<div class="stat"><span class="num">' + groups.length + '</span><span class="l">' + (groups.length === 1 ? 'Exercise' : 'Exercises') + '</span></div>' +
      '<div class="stat"><span class="num">' + lifted.length + '</span><span class="l">' + (lifted.length === 1 ? 'Set' : 'Sets') + '</span></div></div>' +
      shareButtonHTML('workout', w.id);

    if (total > 0) {
      html += '<div class="banner pr" role="status"><div class="t">' + (total === 1 ? 'You hit a PR' : 'You hit ' + total + ' PRs') + '</div>';
      infos.forEach(function (x) {
        if (!x.p.lines.length) return;
        html += '<div class="bx">' + esc(x.g.name) + '</div>' + x.p.lines.map(function (l) { return '<p class="l">' + esc(l) + '</p>'; }).join('');
      });
      html += '</div>';
    } else {
      var bases = infos.filter(function (x) { return x.p.base; }).map(function (x) { return x.g.name; });
      html += '<div class="banner none" role="status"><div class="t">No PRs this workout</div><p class="l">' +
        (bases.length ? esc('First time logging ' + bases.join(', ') + ': that is now your baseline to beat.') : '') + '</p></div>';
    }
    if (total > 0) {
      var b2 = infos.filter(function (x) { return x.p.base; }).map(function (x) { return x.g.name; });
      if (b2.length) html += '<p class="sub" style="margin-top:10px">First time logging ' + esc(b2.join(', ')) + ': baseline set.</p>';
    }

    html += burnHTML(burnCalc(w, all));
    html += '<div class="recap"><h3>What you did</h3>' + recapRows(all, flags) + '</div>';

    if (ui.benchAsk === w.id) {
      html += '<div class="benchask"><h3>Save these as your benchmark?</h3>' +
        '<p class="sub">Next time you do these exercises you will see these sets to beat. Skip it after an off day and your last saved benchmark stays.</p>' +
        '<div class="benchbtns"><button type="button" class="primary" data-a="bench-yes">Save benchmark</button>' +
        '<button type="button" class="secondary" data-a="bench-no">Not this time</button></div></div>';
    } else if (ui.benchMsg) {
      html += '<p class="sub" style="margin-top:14px">' + esc(ui.benchMsg) + '</p>';
    }
    return html + '<div class="after"><button type="button" class="secondary" data-a="done">Done</button></div>' +
      (w.plan ? '' : ui.planSaved === w.id
        ? '<p class="sub" style="margin-top:12px">Saved to Plans.</p>'
        : '<div style="margin-top:8px"><button type="button" class="linkbtn" data-a="plan-fromworkout" data-id="' + esc(w.id) + '">Save this workout as a plan</button></div>');
  }

  function workoutHTML() {
    if (state.active) return activeHTML();
    if (ui.summary) {
      var w = state.workouts.filter(function (x) { return x.id === ui.summary; })[0];
      if (w) return summaryHTML(w);
    }
    return '';
  }

  /* ---------- Plans tab ---------- */
  function canonName(n) {
    var k = key(n);
    var known = state.entries.filter(function (en) { return key(en.ex) === k; })[0];
    return known ? known.ex : n;
  }
  function typeName(t) { return t === 'warmup' ? 'Warmup' : t === 'drop' ? 'Drop' : 'Working'; }
  // The planned sets of an exercise as a list of types, e.g. ['warmup', 'working', 'working', 'drop'].
  function planSlots(x) {
    if (x && x.types && x.types.length) return x.types.map(function (t) { return t === 'warmup' || t === 'drop' ? t : 'working'; });
    var out = [];
    for (var i = 0; i < ((x && x.sets) || 0); i++) out.push('working');
    return out;
  }
  function slotsLabel(types) {
    var c = { warmup: 0, working: 0, drop: 0 };
    types.forEach(function (t) { c[t === 'warmup' || t === 'drop' ? t : 'working']++; });
    if (!c.warmup && !c.drop) return c.working + ' working';
    var parts = [];
    if (c.warmup) parts.push(c.warmup + ' warmup');
    if (c.working) parts.push(c.working + ' working');
    if (c.drop) parts.push(c.drop + ' drop');
    return parts.join(', ');
  }
  // One chip per exercise with its sets, used on your plans and on friends' profiles.
  function exChipsHTML(exercises) {
    return (Array.isArray(exercises) ? exercises : []).map(function (x) {
      return '<span class="xchip">' + esc(x.name) + '<small>' + esc(x.cardio ? 'cardio' : slotsLabel(planSlots(x))) + '</small></span>';
    }).join('');
  }
  function planRow(p, full) {
    var start = state.active ? '' : '<button type="button" class="primary small play" data-a="start" data-plan="' + esc(p.id) + '" aria-label="Start ' + esc(p.name) + '">Start</button>';
    var foot = '';
    if (full) {
      var armed = ui.armed === 'plan:' + p.id;
      foot = '<div class="pfoot"><button type="button" class="linkbtn" data-a="plan-edit" data-id="' + esc(p.id) + '">Edit</button>' +
        '<button type="button" class="linkbtn danger mute' + (armed ? ' armed' : '') + '" data-a="plan-del" data-id="' + esc(p.id) + '">' + (armed ? 'Tap again to delete' : 'Delete') + '</button></div>';
    }
    var chips = exChipsHTML(p.exercises);
    return '<div class="plan"><div class="ptop"><div class="pname">' + esc(p.name) + '</div>' + start + '</div>' +
      (chips ? '<div class="pex">' + chips + '</div>' : '') + foot + '</div>';
  }
  function plansHTML() {
    if (ui.edit) return editorHTML();
    var tabs = segHTML('pane', { plans: 'Plans', insights: 'Insights' }, ui.plp, 'Plans or insights', 'plp').replace('unit seg3', 'unit seg3 subtabs');
    if (ui.plp === 'insights') return tabs + insightsHTML();
    var html = tabs + '<div class="wkhead"><h2 style="margin:0">Workout plans</h2><button type="button" class="secondary small add" data-a="plan-new">New plan</button></div>' +
      (state.active ? '' : '<button type="button" class="quick" data-a="start"><span class="qi" aria-hidden="true"></span><span class="qt"><b>Quick start</b><small>Start an empty workout and add exercises as you go</small></span></button>');
    if (!state.plans.length) return html;
    return html + '<div class="plans">' + state.plans.map(function (p) { return planRow(p, true); }).join('') + '</div>';
  }
  // Recap, records and PR history: everything about how your training is going.
  function insightsHTML() {
    var rec = recordsHTML();
    return recapHTML() + (rec ? '<h2 class="pagetitle" style="margin-top:28px">Records</h2>' + rec : '<p class="sub" style="margin-top:20px">Your records will show up here after you finish a workout.</p>');
  }
  function editorHTML() {
    var e = ui.edit;
    var html = '<h2>' + (e.id ? 'Edit plan' : 'New plan') + '</h2>' +
      '<div class="field"><label for="pname">Plan name</label><input id="pname" autocomplete="off" value="' + esc(e.name) + '"></div>' +
      '<div class="sect"><h4>Exercises</h4>';
    e.exercises.forEach(function (x, i) {
      html += '<div class="pe-row">' +
        '<div class="field nm"><label for="pn' + i + '">Exercise ' + (i + 1) + '</label><input id="pn' + i + '" autocomplete="off" data-pe="' + i + '" data-f="name" value="' + esc(x.name) + '"></div>';
      if (!x.cardio) {
        html += '<div class="pills"><span class="pl">Sets <span class="sub">Tap a set to change its type</span></span><div class="setpills">' +
          x.types.map(function (t, j) {
            return '<button type="button" class="pill ' + t + '" data-a="plan-settype" data-i="' + i + '" data-j="' + j + '" aria-label="Set ' + (j + 1) + ', ' + typeName(t) + '. Tap to change the type.">' + typeName(t) + '</button>';
          }).join('') +
          '<button type="button" class="pill add" data-a="plan-addset" data-i="' + i + '" aria-label="Add a set">+</button>' +
          (x.types.length > 1 ? '<button type="button" class="pill add" data-a="plan-rmset" data-i="' + i + '" aria-label="Remove the last set">\u2212</button>' : '') +
          '</div></div>';
      }
      html += '<div class="pe-act"><label class="chk"><input type="checkbox" data-a="plan-cardio" data-i="' + i + '"' + (x.cardio ? ' checked' : '') + '> Cardio</label>' +
        (i > 0 ? '<button type="button" class="linkbtn" data-a="plan-up" data-i="' + i + '">Up</button>' : '') +
        (i < e.exercises.length - 1 ? '<button type="button" class="linkbtn" data-a="plan-down" data-i="' + i + '">Down</button>' : '') +
        '<button type="button" class="linkbtn mute" data-a="plan-rmrow" data-i="' + i + '">Remove</button></div></div>';
    });
    html += '<button type="button" class="secondary" data-a="plan-addrow" style="margin-top:6px">Add exercise</button></div>';
    if (e.err) html += '<p class="err">' + esc(e.err) + '</p>';
    html += '<div class="peactions"><button type="button" class="primary" data-a="plan-save">Save plan</button>' +
      '<button type="button" class="secondary" data-a="plan-cancel">Cancel</button></div>';
    return html;
  }
  function savePlan() {
    var e = ui.edit;
    var name = e.name.trim().replace(/\s+/g, ' ');
    var seen = {}, list = [];
    e.exercises.forEach(function (x) {
      var n = x.name.trim().replace(/\s+/g, ' ');
      if (!n || seen[key(n)]) return;
      seen[key(n)] = 1;
      var types = x.cardio ? ['working'] : planSlots({ types: x.types }).slice(0, 20);
      if (!types.length) types = ['working'];
      list.push({ name: canonName(n), sets: types.length, types: types, cardio: !!x.cardio });
    });
    if (!name) { e.err = 'Give the plan a name.'; ui.focus = '#pname'; render(); return; }
    if (!list.length) { e.err = 'Add at least one exercise.'; render(); return; }
    var plan = { id: e.id || uid(), name: name, exercises: list };
    if (e.id) state.plans = state.plans.map(function (p) { return p.id === e.id ? plan : p; });
    else state.plans.push(plan);
    ui.edit = null;
    persist();
    render();
  }
  function newPlanRow() { return { name: '', types: ['working'], cardio: false }; }
  function planAction(a, t) {
    var e = ui.edit;
    var i = +t.dataset.i;
    if (a === 'plan-new') {
      ui.edit = { id: null, name: '', exercises: [newPlanRow()], err: '' };
      ui.focus = '#pname';
    } else if (a === 'plan-edit') {
      var p = state.plans.filter(function (x) { return x.id === t.dataset.id; })[0];
      if (!p) return;
      ui.edit = { id: p.id, name: p.name, err: '', exercises: p.exercises.map(function (x) {
        return { name: x.name, types: planSlots(x).length ? planSlots(x) : ['working'], cardio: !!x.cardio };
      }) };
    } else if (a === 'plan-cancel') {
      ui.edit = null;
    } else if (a === 'plan-save') {
      savePlan();
      return;
    } else if (a === 'plan-addrow') {
      e.exercises.push(newPlanRow());
      ui.focus = '#pn' + (e.exercises.length - 1);
    } else if (a === 'plan-rmrow') {
      e.exercises.splice(i, 1);
    } else if (a === 'plan-cardio') {
      e.exercises[i].cardio = !e.exercises[i].cardio;
    } else if (a === 'plan-settype') {
      var j = +t.dataset.j;
      var cur = e.exercises[i].types[j];
      var at = 0;
      TYPES.forEach(function (ty, n) { if (ty[0] === cur) at = n; });
      e.exercises[i].types[j] = TYPES[(at + 1) % TYPES.length][0];
      ui.focus = '[data-a="plan-settype"][data-i="' + i + '"][data-j="' + j + '"]';
    } else if (a === 'plan-addset') {
      if (e.exercises[i].types.length < 20) e.exercises[i].types.push('working');
    } else if (a === 'plan-rmset') {
      if (e.exercises[i].types.length > 1) e.exercises[i].types.pop();
    } else if (a === 'plan-up' || a === 'plan-down') {
      var k2 = a === 'plan-up' ? i - 1 : i + 1;
      var tmp = e.exercises[i]; e.exercises[i] = e.exercises[k2]; e.exercises[k2] = tmp;
    } else if (a === 'plan-del') {
      armThen('plan:' + t.dataset.id, function () {
        state.plans = state.plans.filter(function (x) { return x.id !== t.dataset.id; });
        state.schedule = state.schedule.filter(function (x) { return x.planId !== t.dataset.id; });
        persist(); render();
      });
      return;
    } else if (a === 'plan-fromworkout') {
      var w = state.workouts.filter(function (x) { return x.id === t.dataset.id; })[0];
      if (!w) return;
      var groups = groupByEx(state.entries.filter(function (en) { return en.wid === w.id; }).sort(cmpEntries));
      state.plans.push({ id: uid(), name: 'Workout ' + fmtDate(w.date), exercises: groups.map(function (g) {
        var cardio = !!g.sets[0].cardio;
        var types = cardio ? ['working'] : g.sets.map(typeOf).slice(0, 20);
        return { name: g.name, sets: types.length, types: types, cardio: cardio };
      }) });
      ui.planSaved = w.id;
      persist();
    }
    render();
  }

  /* ---------- Calendar tab ---------- */
  function parseD(s) { return new Date(s + 'T00:00:00'); }
  function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addMonths(first, n) { var d = parseD(first); d.setMonth(d.getMonth() + n, 1); return dstr(d); }
  function wdIndex(s) { return (parseD(s).getDay() + 6) % 7; }
  function occurrences(d) {
    return state.schedule.filter(function (it) {
      return it.date === d || (it.repeat && it.date <= d && wdIndex(it.date) === wdIndex(d));
    });
  }
  function dayWorkouts(d) {
    var items = state.workouts.filter(function (w) { return w.date === d; })
      .sort(function (a, b) { return a.start - b.start; })
      .map(function (w) {
        return { id: w.id, date: d, plan: w.plan || null, planId: w.planId || null, start: w.start, end: w.end, legacy: false };
      });
    if (state.entries.some(function (e) { return !e.wid && e.date === d; })) {
      items.push({ id: 'd:' + d, date: d, plan: null, planId: null, start: null, end: null, legacy: true });
    }
    return items;
  }
  function itemSets(it) {
    return state.entries.filter(function (e) {
      return it.legacy ? (!e.wid && e.date === it.date) : e.wid === it.id;
    }).sort(cmpEntries);
  }

  function dayDetail(d, t0, flags) {
    var dt = parseD(d);
    var wks = dayWorkouts(d);
    var occ = occurrences(d);
    var title = dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    var html = '<div class="dayd"><h3>' + title + '</h3>';

    occ.forEach(function (it) {
      if (wks.some(function (w) { return w.planId === it.planId; })) return;
      var plan = state.plans.filter(function (p) { return p.id === it.planId; })[0];
      var armed = ui.armed === 'sch:' + it.id;
      var status = '';
      if (d < t0) status = '<span class="chip">Not done</span>';
      else if (d === t0 && plan && !state.active) status = '<button type="button" class="primary small" data-a="start" data-plan="' + esc(plan.id) + '">Start</button>';
      html += '<div class="sitem"><span class="sname">' + esc(plan ? plan.name : it.name) + '</span>' +
        (it.repeat ? '<span class="chip">Weekly</span>' : '') +
        '<span class="acts2">' + status +
        '<button type="button" class="linkbtn danger mute' + (armed ? ' armed' : '') + '" data-a="cal-del" data-id="' + esc(it.id) + '">' + (armed ? (it.repeat ? 'Remove all weeks' : 'Tap again') : 'Remove') + '</button></span></div>';
    });

    wks.forEach(function (it) {
      var sets = itemSets(it);
      var groups = groupByEx(sets);
      var prCount = groups.reduce(function (s, g) { return s + exPRs(g.sets, flags).lines.length; }, 0);
      var armed = ui.armed === 'wk:' + it.id;
      var isOpen = !!ui.open[it.id];
      var meta = sets.length + (sets.length === 1 ? ' set' : ' sets') + (it.end ? ' \u00B7 ' + Math.max(1, Math.round((it.end - it.start) / 60000)) + ' min' : '');
      html += '<article class="wk"><button type="button" class="wkbtn" data-a="togglewk" data-id="' + esc(it.id) + '" aria-expanded="' + isOpen + '"><span class="wkmain"><span class="wkt">' + esc(it.plan || (it.legacy ? 'Logged sets' : 'Workout')) + '</span><span class="sub">' + meta + '</span></span><span class="wkside">' +
        (prCount ? '<span class="chip pr">' + prCount + (prCount === 1 ? ' PR' : ' PRs') + '</span>' : '') +
        '<span class="chev" aria-hidden="true">' + (isOpen ? '\u25B4' : '\u25BE') + '</span></span></button>' +
        (isOpen ? burnLine(it, sets) + recapRows(sets, flags) + '<div class="wkdel"><button type="button" class="linkbtn danger mute' + (armed ? ' armed' : '') + '" data-a="delwk" data-id="' + esc(it.id) + '">' + (armed ? 'Tap again to delete' : 'Delete workout') + '</button></div>' : '') +
        '</article>';
    });

    if (ui.addDay === d) {
      html += '<div class="picker">' + (state.plans.length
        ? state.plans.map(function (p) {
            return '<button type="button" class="secondary" data-a="cal-pick" aria-pressed="' + (ui.addPlan === p.id) + '" data-plan="' + esc(p.id) + '">' + esc(p.name) + '</button>';
          }).join('') + '<label class="chk"><input type="checkbox" data-a="cal-repeat"' + (ui.repeat ? ' checked' : '') + '> Repeat every week</label>' +
          '<button type="button" class="primary" data-a="cal-confirm" data-date="' + d + '"' + (ui.addPlan ? '' : ' disabled') + '>Add</button>'
        : '<button type="button" class="secondary" data-a="tab" data-tab="plans">Create a plan first</button>') +
        '<button type="button" class="linkbtn mute" data-a="cal-cancel">Cancel</button></div>';
    } else {
      html += '<button type="button" class="linkbtn addbtn" data-a="cal-add" data-date="' + d + '">Add workout</button>';
    }
    return html + mealsBlock(d) + '</div>';
  }

  function calendarHTML() {
    var kt = tgt('kcal');
    var t0 = today();
    if (!ui.month) ui.month = t0.slice(0, 8) + '01';
    if (!ui.selDay) ui.selDay = t0;
    var fd = parseD(ui.month);
    var title = fd.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    var lead = wdIndex(ui.month);
    var daysIn = new Date(fd.getFullYear(), fd.getMonth() + 1, 0).getDate();
    var flags = analyze(state.entries);

    var html = '<div class="weeknav"><h2>' + title + '</h2><div class="wnbtns">' +
      '<button type="button" class="iconbtn" data-a="cal-prev" aria-label="Previous month">\u2039</button>' +
      '<button type="button" class="iconbtn" data-a="cal-today">Today</button>' +
      '<button type="button" class="iconbtn" data-a="cal-next" aria-label="Next month">\u203A</button></div></div>';

    html += '<div class="mgrid">';
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (l) { html += '<div class="mh" aria-hidden="true">' + l + '</div>'; });
    var total = Math.ceil((lead + daysIn) / 7) * 7;
    for (var i = 0; i < total; i++) {
      var n = i - lead + 1;
      if (n < 1 || n > daysIn) { html += '<div></div>'; continue; }
      var d = dstr(new Date(fd.getFullYear(), fd.getMonth(), n));
      var wks = dayWorkouts(d);
      var pending = occurrences(d).filter(function (it) {
        return !wks.some(function (w) { return w.planId === it.planId; });
      }).length;
      var dots = '';
      wks.slice(0, 3).forEach(function (w) {
        var pr = groupByEx(itemSets(w)).some(function (g) { return exPRs(g.sets, flags).lines.length > 0; });
        dots += '<i class="dot ' + (pr ? 'pr' : 'done') + '"></i>';
      });
      for (var j = 0; j < Math.min(pending, 3); j++) dots += '<i class="dot planned"></i>';
      var dayMeals = mealsOn(d);
      var hasMeals = dayMeals.length > 0;
      var eaten = hasMeals ? Math.round(mealTotals(dayMeals).kcal) : 0;
      if (hasMeals) dots += '<i class="dot eaten"></i>';
      var label = parseD(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) +
        (wks.length ? ', ' + wks.length + (wks.length === 1 ? ' workout' : ' workouts') : '') +
        (pending ? ', ' + pending + ' planned' : '') +
        (hasMeals ? ', ' + eaten + (kt ? ' of ' + kt : '') + ' calories eaten' : '');
      html += '<button type="button" class="cell' + (d === t0 ? ' today' : '') + '" data-a="cal-sel" data-date="' + d + '" aria-pressed="' + (d === ui.selDay) + '" aria-label="' + esc(label) + '"><span class="n">' + n + '</span><span class="dots">' + dots + '</span></button>';
    }
    html += '</div>';
    return html + dayDetail(ui.selDay, t0, flags);
  }

  function calAction(a, t) {
    var t0 = today();
    var thisMonth = t0.slice(0, 8) + '01';
    function setMonth(m) { ui.month = m; ui.addDay = null; ui.selDay = m === thisMonth ? t0 : m; }
    if (a === 'cal-prev') setMonth(addMonths(ui.month, -1));
    else if (a === 'cal-next') setMonth(addMonths(ui.month, 1));
    else if (a === 'cal-today') setMonth(thisMonth);
    else if (a === 'cal-sel') {
      ui.selDay = t.dataset.date; ui.addDay = null;
      ui.focus = '[data-a="cal-sel"][data-date="' + t.dataset.date + '"]';
    }
    else if (a === 'cal-add') { ui.addDay = t.dataset.date; ui.repeat = false; ui.addPlan = null; }
    else if (a === 'cal-cancel') { ui.addDay = null; ui.addPlan = null; }
    else if (a === 'cal-repeat') { ui.repeat = t.checked; return; }
    else if (a === 'cal-pick') { ui.addPlan = ui.addPlan === t.dataset.plan ? null : t.dataset.plan; ui.focus = '[data-a="cal-pick"][data-plan="' + t.dataset.plan + '"]'; }
    else if (a === 'cal-confirm') {
      var p = state.plans.filter(function (x) { return x.id === ui.addPlan; })[0];
      if (!p) return;
      var dup = state.schedule.some(function (x) { return x.date === t.dataset.date && x.planId === p.id && !x.repeat && !ui.repeat; });
      if (!dup) state.schedule.push({ id: uid(), date: t.dataset.date, planId: p.id, name: p.name, repeat: !!ui.repeat });
      ui.addDay = null; ui.addPlan = null;
      persist();
    } else if (a === 'cal-del') {
      armThen('sch:' + t.dataset.id, function () {
        state.schedule = state.schedule.filter(function (x) { return x.id !== t.dataset.id; });
        persist(); render();
      });
      return;
    }
    render();
  }

  /* ---------- Meals tab ---------- */
  function addDays(s, n) { var d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); }
  function mealsOn(d) {
    return state.meals.filter(function (m) { return m.date === d; }).sort(function (a, b) { return a.ts - b.ts; });
  }
  function mealTotals(list) {
    return list.reduce(function (s, m) {
      return { kcal: s.kcal + m.kcal, p: s.p + m.p, c: s.c + m.c, f: s.f + m.f };
    }, { kcal: 0, p: 0, c: 0, f: 0 });
  }
  function fmtK(v) { return Math.round(v).toLocaleString('en-GB'); }
  function fmtG(v) { return String(+v.toFixed(1)); }
  function numOrZero(v) {
    var s = String(v).trim().replace(',', '.');
    if (s === '') return 0;
    var n = Number(s);
    return isFinite(n) && n >= 0 && n <= 100000 ? n : NaN;
  }
  // Extra nutrients: [key, label, unit, Open Food Facts name, multiplier from grams per 100 g to the display unit]
  var NUT = [
    ['satfat', 'Saturated fat', 'g', 'saturated-fat', 1],
    ['monofat', 'Monounsaturated fat', 'g', 'monounsaturated-fat', 1],
    ['polyfat', 'Polyunsaturated fat', 'g', 'polyunsaturated-fat', 1],
    ['transfat', 'Trans fat', 'g', 'trans-fat', 1],
    ['chol', 'Cholesterol', 'mg', 'cholesterol', 1000],
    ['sugars', 'Sugars', 'g', 'sugars', 1],
    ['starch', 'Starch', 'g', 'starch', 1],
    ['fibre', 'Fibre', 'g', 'fiber', 1],
    ['salt', 'Salt', 'g', 'salt', 1],
    ['sodium', 'Sodium', 'mg', 'sodium', 1000],
    ['potassium', 'Potassium', 'mg', 'potassium', 1000],
    ['calcium', 'Calcium', 'mg', 'calcium', 1000],
    ['iron', 'Iron', 'mg', 'iron', 1000],
    ['magnesium', 'Magnesium', 'mg', 'magnesium', 1000],
    ['zinc', 'Zinc', 'mg', 'zinc', 1000],
    ['vita', 'Vitamin A', '\u00B5g', 'vitamin-a', 1e6],
    ['vitc', 'Vitamin C', 'mg', 'vitamin-c', 1000],
    ['vitd', 'Vitamin D', '\u00B5g', 'vitamin-d', 1e6],
    ['vite', 'Vitamin E', 'mg', 'vitamin-e', 1000],
    ['vitb12', 'Vitamin B12', '\u00B5g', 'vitamin-b12', 1e6],
    ['caffeine', 'Caffeine', 'mg', 'caffeine', 1000]
  ];
  function fmtD(v) { v = Number(v); return String(+v.toFixed(v < 10 ? 2 : 1)); }
  function infoHTML(inf) {
    var lines = [['Brand', inf.brand], ['Quantity', inf.quantity], ['Ingredients', inf.ingredients], ['Allergens', inf.allergens],
      ['May contain', inf.traces], ['Nutri-Score', inf.nutri], ['NOVA group', inf.nova], ['Categories', inf.categories]];
    return lines.filter(function (l) { return l[1]; }).map(function (l) {
      return '<p class="info"><b>' + l[0] + '</b> ' + esc(l[1]) + '</p>';
    }).join('');
  }
  var MEAL_CATS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snack', 'Snacks']];
  function defaultCat() {
    var h = new Date().getHours();
    return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snack';
  }
  function curCat() { return ui.mealCat || defaultCat(); }
  function catPickerHTML() {
    return '<div class="unit catsel wide" role="group" aria-label="Which meal">' + MEAL_CATS.map(function (c) {
      return '<button type="button" data-a="meal-cat" data-v="' + c[0] + '" aria-pressed="' + (curCat() === c[0]) + '">' + c[1] + '</button>';
    }).join('') + '</div>';
  }
  // Meals grouped into Breakfast, Lunch, Dinner and Snacks (older meals without a section go under Other).
  function mealSectionsHTML(list, withAdd) {
    var cats = MEAL_CATS.slice();
    if (list.some(function (m) { return !m.cat; })) cats.push(['other', 'Other']);
    return cats.map(function (c) {
      var items = list.filter(function (m) { return (m.cat || 'other') === c[0]; });
      if (!items.length && !withAdd) return '';
      var t = mealTotals(items);
      return '<div class="msec"><div class="msech"><h4>' + c[1] + (items.length ? ' \u00B7 ' + fmtK(t.kcal) + ' kcal' : '') + '</h4>' +
        (withAdd && c[0] !== 'other' ? '<button type="button" class="linkbtn" data-a="meal-addto" data-v="' + c[0] + '">Add</button>' : '') + '</div>' +
        (items.length ? '<p class="sub">P ' + fmtG(t.p) + ' \u00B7 C ' + fmtG(t.c) + ' \u00B7 F ' + fmtG(t.f) + '</p>' : '') +
        items.map(mealRow).join('') + '</div>';
    }).join('');
  }
  function mealHasDetail(m) {
    return !!((m.d && Object.keys(m.d).length) || (m.info && Object.keys(m.info).length) || m.amt);
  }
  function mealDetailHTML(m) {
    var html = '<div class="mdet">';
    if (m.amt) html += '<p class="info"><b>Amount</b> ' + fmtD(m.amt) + ' g or ml</p>';
    var rows = NUT.filter(function (n) { return m.d && m.d[n[0]] !== undefined; }).map(function (n) {
      return '<div class="nutrow"><span>' + n[1] + '</span><span>' + fmtD(m.d[n[0]]) + ' ' + n[2] + '</span></div>';
    }).join('');
    if (rows) html += '<div class="nut">' + rows + '</div>';
    return html + infoHTML(m.info || {}) + '</div>';
  }
  function dayNutrientsHTML(list) {
    var rows = NUT.map(function (n) {
      var have = list.filter(function (m) { return m.d && m.d[n[0]] !== undefined; });
      var sum = have.reduce(function (s, m) { return s + Number(m.d[n[0]]); }, 0);
      var t = tgt(n[0]);
      if (!have.length && !(t > 0)) return '';
      return '<div class="nrow"><div class="nl"><span>' + n[1] + (have.length && have.length < list.length ? ' <span class="sub">(' + have.length + ' of ' + list.length + ' meals)</span>' : '') +
        '</span><span class="nv"><b>' + fmtD(sum) + '</b>' + (t > 0 ? ' / ' + fmtD(t) : '') + ' ' + n[2] + '</span></div>' + barHTML(kindOf(n[0]), sum, t) + '</div>';
    }).join('');
    return rows ? '<div class="nut">' + rows + '</div>' : '<p class="sub">Nothing to show yet.</p>';
  }
  function mealRow(m) {
    var armed = ui.armed === 'meal:' + m.id;
    var has = mealHasDetail(m);
    var open = !!ui.openMeal[m.id];
    return '<div class="mealwrap"><div class="meal"><div class="mn"><span class="mname">' + esc(m.name) + '</span><span class="sub">' +
      fmtK(m.kcal) + ' kcal \u00B7 P ' + fmtG(m.p) + ' \u00B7 C ' + fmtG(m.c) + ' \u00B7 F ' + fmtG(m.f) + '</span></div><div class="macts">' +
      (canPost() && !ui.posted['meal:' + m.id] ? '<button type="button" class="linkbtn" data-a="post-open" data-kind="meal" data-ref="' + esc(m.id) + '" aria-label="Share ' + esc(m.name) + ' with friends">Share</button>' : '') +
      (has ? '<button type="button" class="linkbtn" data-a="meal-toggle" data-id="' + esc(m.id) + '" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Details') + '</button>' : '') +
      '<button type="button" class="linkbtn danger mute' + (armed ? ' armed' : '') + '" data-a="meal-del" data-id="' + esc(m.id) + '">' + (armed ? 'Tap again' : 'Delete') + '</button></div></div>' +
      (open && has ? mealDetailHTML(m) : '') + '</div>';
  }
  function mealsBlock(d) {
    var list = mealsOn(d);
    var html = '<div class="sect">';
    if (list.length) {
      var t = mealTotals(list);
      html += '<h4>Meals \u00B7 ' + fmtK(t.kcal) + (tgt('kcal') > 0 ? ' / ' + fmtK(tgt('kcal')) : '') + ' kcal</h4><p class="sub" style="margin-bottom:6px">P ' + fmtG(t.p) + ' \u00B7 C ' + fmtG(t.c) + ' \u00B7 F ' + fmtG(t.f) + '</p>' + mealSectionsHTML(list, false);
    }
    return html + '<button type="button" class="linkbtn addbtn" data-a="meal-goto" data-date="' + d + '">Add meal</button></div>';
  }
  function mfield(id, k, label, wide) {
    return '<div class="field' + (wide ? ' wide' : '') + '"><label for="' + id + '">' + label + '</label><input id="' + id + '" data-md="' + k + '" autocomplete="off"' +
      (k === 'name' ? '' : ' inputmode="decimal"') + ' value="' + esc(ui.mealDraft[k]) + '"></div>';
  }
  /* Barcode scanner (Open Food Facts) */
  var OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
  var ZX_URLS = [
    'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js',
    'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'
  ];
  var scanner = { el: null, stream: null, timer: null, reader: null, controls: null, busy: false, looking: false, lastCode: '', lastAt: 0 };

  function scanStat(msg) { var s = $('scanstat'); if (s) s.textContent = msg; }
  function scanStopCamera() {
    if (scanner.timer) { clearInterval(scanner.timer); scanner.timer = null; }
    if (scanner.controls && scanner.controls.stop) { try { scanner.controls.stop(); } catch (e) { /* ignore */ } }
    scanner.controls = null;
    if (scanner.reader && scanner.reader.reset) { try { scanner.reader.reset(); } catch (e) { /* ignore */ } }
    scanner.reader = null;
    if (scanner.stream) { scanner.stream.getTracks().forEach(function (tr) { tr.stop(); }); scanner.stream = null; }
    var v = $('scanvid');
    if (v) v.srcObject = null;
  }
  function scanClose() {
    scanStopCamera();
    scanner.looking = false;
    if (scanner.el) scanner.el.hidden = true;
    document.body.style.overflow = '';
  }
  function scanOverlay() {
    if (scanner.el) return scanner.el;
    var el = document.createElement('div');
    el.className = 'scanov';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Scan barcode');
    el.innerHTML = '<div class="scansheet"><h3>Scan barcode</h3><video id="scanvid" class="scanvid" playsinline muted></video>' +
      '<p class="sub" id="scanstat" aria-live="polite"></p>' +
      '<div class="scanman"><div class="field"><label for="scancode">Or type the barcode number</label><input id="scancode" inputmode="numeric" autocomplete="off"></div>' +
      '<button type="button" class="secondary" id="scango">Look up</button></div>' +
      '<button type="button" class="linkbtn" id="scanx">Cancel</button></div>';
    document.body.appendChild(el);
    scanner.el = el;
    $('scanx').addEventListener('click', scanClose);
    $('scango').addEventListener('click', function () { scanLookup($('scancode').value); });
    $('scancode').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); scanLookup($('scancode').value); }
    });
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') scanClose(); });
    return el;
  }
  function scanDenied() {
    scanStat('Camera access was blocked or is unavailable. Allow it in your browser settings, or type the barcode number instead.');
  }
  function scanLoadZXing(cb) {
    function reader() {
      return (window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader) ||
        (window.ZXing && window.ZXing.BrowserMultiFormatReader) || null;
    }
    if (reader()) { cb(reader()); return; }
    var i = 0;
    (function next() {
      if (i >= ZX_URLS.length) { cb(null); return; }
      var s = document.createElement('script');
      s.src = ZX_URLS[i++];
      s.onload = function () { var r = reader(); if (r) cb(r); else next(); };
      s.onerror = next;
      document.head.appendChild(s);
    })();
  }
  function scanStartCamera() {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { scanStat('The camera is not available here. Type the barcode number instead.'); return; }
    var constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
    var det = null;
    if ('BarcodeDetector' in window) {
      try { det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }); } catch (e) { det = null; }
    }
    if (det) {
      md.getUserMedia(constraints).then(function (stream) {
        if (scanner.el.hidden) { stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
        scanner.stream = stream;
        var v = $('scanvid');
        v.srcObject = stream;
        var pl = v.play();
        if (pl && pl.catch) pl.catch(function () {});
        scanStat('Point the camera at the barcode.');
        scanner.timer = setInterval(function () {
          if (scanner.busy || v.readyState < 2) return;
          scanner.busy = true;
          det.detect(v).then(function (r) {
            scanner.busy = false;
            if (r && r.length) scanOnCode(r[0].rawValue);
          }).catch(function () { scanner.busy = false; });
        }, 300);
      }).catch(scanDenied);
      return;
    }
    scanLoadZXing(function (Reader) {
      if (!Reader) { scanStat('Could not load the scanner. Type the barcode number instead.'); return; }
      if (scanner.el.hidden) return;
      try {
        scanner.reader = new Reader();
        var ret = scanner.reader.decodeFromConstraints(constraints, $('scanvid'), function (result) {
          if (result) scanOnCode(result.getText());
        });
        Promise.resolve(ret).then(function (ctl) {
          if (scanner.el.hidden) { if (ctl && ctl.stop) ctl.stop(); return; }
          scanner.controls = ctl;
          scanStat('Point the camera at the barcode.');
        }).catch(scanDenied);
      } catch (e) { scanDenied(); }
    });
  }
  function scanOpen() {
    scanOverlay();
    scanner.el.hidden = false;
    scanner.looking = false;
    scanner.lastCode = '';
    document.body.style.overflow = 'hidden';
    $('scancode').value = '';
    scanStat('Starting the camera...');
    scanStartCamera();
    $('scanx').focus();
  }
  function scanOnCode(raw) {
    var code = String(raw || '').replace(/\D/g, '');
    if (!code || scanner.looking) return;
    if (code === scanner.lastCode && Date.now() - scanner.lastAt < 5000) return;
    scanner.lastCode = code;
    scanner.lastAt = Date.now();
    scanLookup(code);
  }
  function scanLookup(raw) {
    var code = String(raw || '').replace(/\D/g, '');
    if (code.length < 8 || code.length > 14) { scanStat('Enter the 8 to 14 digit number printed under the barcode.'); return; }
    if (scanner.looking) return;
    scanner.looking = true;
    scanStat('Looking up ' + code + '...');
    var ctl = window.AbortController ? new window.AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
    fetch(OFF_URL + code + '.json?fields=code,product_name,brands,quantity,serving_size,serving_quantity,nutriments,ingredients_text,allergens_tags,traces_tags,nutriscore_grade,nova_group,categories', ctl ? { signal: ctl.signal } : undefined)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        clearTimeout(to);
        scanner.looking = false;
        if (!data || data.status !== 1 || !data.product) {
          scanStat('That barcode is not in the food database. Try another, or cancel and enter it by hand.');
          return;
        }
        scanApply(data.product);
      })
      .catch(function () {
        clearTimeout(to);
        scanner.looking = false;
        scanStat('Could not reach the food database. Check your connection, or cancel and enter it by hand.');
      });
  }
  function scanNum(x) {
    if (x === '' || x === null || x === undefined) return null;
    x = Number(x);
    return isFinite(x) && x >= 0 ? x : null;
  }
  function scanApply(p) {
    var n = p.nutriments || {};
    var pr = scanNum(n['proteins_100g']), cb = scanNum(n['carbohydrates_100g']), ft = scanNum(n['fat_100g']);
    var kc = scanNum(n['energy-kcal_100g']);
    if (kc === null && scanNum(n['energy_100g']) !== null) kc = Number(n['energy_100g']) / 4.184;
    if (kc === null && (pr !== null || cb !== null || ft !== null)) kc = 4 * (pr || 0) + 4 * (cb || 0) + 9 * (ft || 0);
    var perx = {};
    NUT.forEach(function (nm) {
      var x = scanNum(n[nm[3] + '_100g']);
      if (x !== null) perx[nm[0]] = x * nm[4];
    });
    var brand = String(p.brands || '').split(',')[0].trim();
    var name = String(p.product_name || '').trim() || 'Scanned product';
    if (brand && name.toLowerCase().indexOf(brand.toLowerCase()) === -1) name += ' (' + brand + ')';
    var tag = function (arr) {
      return (Array.isArray(arr) ? arr : []).map(function (x) { return String(x).replace(/^[a-z]{2}:/, '').replace(/-/g, ' '); }).join(', ');
    };
    var info = {};
    if (brand) info.brand = brand;
    if (p.quantity) info.quantity = String(p.quantity);
    if (p.ingredients_text) info.ingredients = String(p.ingredients_text).trim().slice(0, 800);
    if (tag(p.allergens_tags)) info.allergens = tag(p.allergens_tags);
    if (tag(p.traces_tags)) info.traces = tag(p.traces_tags);
    if (/^[a-eA-E]$/.test(String(p.nutriscore_grade || ''))) info.nutri = String(p.nutriscore_grade).toUpperCase();
    if (p.nova_group) info.nova = String(p.nova_group);
    if (p.categories) info.categories = String(p.categories).split(',').slice(0, 3).map(function (x) { return x.trim(); }).join(', ');
    scanClose();
    ui.mealDraft.name = name;
    if (kc === null) {
      ui.scan = null;
      ui.mealErr = 'That product has no nutrition info on file. Enter the numbers by hand.';
      ui.focus = '#mk';
      render();
      return;
    }
    var serving = scanNum(p.serving_quantity);
    ui.scan = { name: name, per: { kcal: kc, p: pr || 0, c: cb || 0, f: ft || 0 }, perx: perx, info: info, grams: serving && serving > 0 ? +serving.toFixed(1) : 100 };
    ui.mealErr = '';
    applyScan();
    ui.focus = '#sg';
    render();
  }
  function applyScan() {
    var s = ui.scan;
    var g = Number(String(s.grams).replace(',', '.'));
    if (!isFinite(g) || g < 0) return;
    var k = g / 100;
    ui.mealDraft.kcal = String(Math.round(s.per.kcal * k));
    ui.mealDraft.p = String(+(s.per.p * k).toFixed(1));
    ui.mealDraft.c = String(+(s.per.c * k).toFixed(1));
    ui.mealDraft.f = String(+(s.per.f * k).toFixed(1));
    ui.mealDraft.d = {};
    Object.keys(s.perx).forEach(function (nk) { ui.mealDraft.d[nk] = String(+(s.perx[nk] * k).toFixed(2)); });
    var ids = { kcal: 'mk', p: 'mp', c: 'mc', f: 'mf' };
    Object.keys(ids).forEach(function (f) {
      var inp = document.getElementById(ids[f]);
      if (inp) inp.value = ui.mealDraft[f];
    });
    NUT.forEach(function (n) {
      var inp = document.getElementById('mx-' + n[0]);
      if (inp) inp.value = ui.mealDraft.d[n[0]] === undefined ? '' : ui.mealDraft.d[n[0]];
    });
  }
  function scanDetailHTML(s) {
    var g = Number(String(s.grams).replace(',', '.'));
    var k = isFinite(g) ? g / 100 : 0;
    var rows = [['Calories', s.per.kcal, 'kcal'], ['Protein', s.per.p, 'g'], ['Carbs', s.per.c, 'g'], ['Fat', s.per.f, 'g']];
    NUT.forEach(function (n) { if (s.perx[n[0]] !== undefined) rows.push([n[1], s.perx[n[0]], n[2]]); });
    return '<div class="nut"><div class="nutrow nuthead"><span></span><span>Per 100 g</span><span>Your amount</span></div>' +
      rows.map(function (r) {
        return '<div class="nutrow"><span>' + r[0] + '</span><span>' + fmtD(r[1]) + ' ' + r[2] + '</span><span>' + fmtD(r[1] * k) + ' ' + r[2] + '</span></div>';
      }).join('') + '</div>' + infoHTML(s.info || {});
  }
  function scanBoxHTML() {
    var s = ui.scan;
    if (!s) return '';
    return '<div class="scanbox"><div class="mn"><span class="mname">' + esc(s.name) + '</span><span class="sub">Per 100 g: ' +
      fmtK(s.per.kcal) + ' kcal \u00B7 P ' + fmtG(s.per.p) + ' \u00B7 C ' + fmtG(s.per.c) + ' \u00B7 F ' + fmtG(s.per.f) + '</span></div>' +
      '<div class="sgrow"><div class="field"><label for="sg">Amount (g or ml)</label><input id="sg" data-sg="1" inputmode="decimal" autocomplete="off" value="' + esc(String(s.grams)) + '"></div>' +
      '<button type="button" class="linkbtn mute" data-a="scan-clear">Clear</button></div>' +
      '<button type="button" class="linkbtn" data-a="scan-all" style="text-align:left">' + (ui.scanAll ? 'Hide all food details' : 'Show all food details') + '</button>' +
      (ui.scanAll ? scanDetailHTML(s) : '') +
      '<p class="sub">Data from Open Food Facts</p></div>';
  }
  function scanAction(a) {
    if (a === 'scan-open') { scanOpen(); return; }
    if (a === 'scan-all') { ui.scanAll = !ui.scanAll; render(); return; }
    if (a === 'scan-clear') { ui.scan = null; ui.scanAll = false; render(); }
  }
  /* Mifflin-St Jeor calorie calculator */
  var ACT = [['Sedentary', 'Desk job, little exercise', 1.2], ['Lightly active', '1 to 3 workouts a week', 1.375],
    ['Moderately active', '3 to 5 workouts a week', 1.55], ['Very active', '6 to 7 workouts a week', 1.725],
    ['Extremely active', 'Hard training plus a physical job', 1.9]];
  function calcInitDrafts() {
    var c = state.calc;
    ui.calcDraft = { age: c.age ? String(c.age) : '', h: '', hin: '', w: '' };
    if (c.cm) {
      if (c.imp) { var ti = Math.round(c.cm / 2.54); ui.calcDraft.h = String(Math.floor(ti / 12)); ui.calcDraft.hin = String(ti % 12); }
      else ui.calcDraft.h = String(Math.round(c.cm));
    }
    if (c.kg) ui.calcDraft.w = c.imp ? String(+(c.kg * LB).toFixed(1)) : String(+c.kg.toFixed(1));
  }
  function calcParse() {
    var d = ui.calcDraft, c = state.calc;
    var age = Number(d.age), w = Number(d.w);
    var cm = c.imp ? (Number(d.h || 0) * 12 + Number(d.hin || 0)) * 2.54 : Number(d.h);
    var kg = c.imp ? w / LB : w;
    if (!(age >= 18 && age <= 100)) return { err: 'This calculator is for adults aged 18 to 100.' };
    if (!(cm >= 100 && cm <= 250)) return { err: 'Check your height.' };
    if (!(kg >= 30 && kg <= 300)) return { err: 'Check your weight.' };
    return { age: Math.round(age), cm: cm, kg: kg };
  }
  function calcPlans(tdee) {
    var c = state.calc, imp = c.imp;
    var perUnit = imp ? 3500 : 7700;
    var rates = c.goal === 'lose' ? (imp ? [0.5, 1, 1.5, 2] : [0.25, 0.5, 0.75, 1]) : (imp ? [0.5, 1, 1.5] : [0.25, 0.5, 0.75]);
    var floor = c.sex === 'm' ? 1500 : 1200;
    var m = Math.round(tdee / 10) * 10;
    var out = [];
    rates.forEach(function (r) {
      var delta = r * perUnit / 7;
      var kcal = Math.round((c.goal === 'lose' ? tdee - delta : tdee + delta) / 10) * 10;
      var limited = false;
      if (c.goal === 'lose' && kcal < floor) { kcal = floor; limited = true; }
      if (limited && out.length && out[out.length - 1].limited) return;
      out.push({ rate: r, unit: imp ? 'lb' : 'kg', kcal: kcal, diff: Math.abs(kcal - m), limited: limited });
    });
    return out;
  }
  function calcHTML() {
    var c = state.calc, d = ui.calcDraft;
    function seg(aria, act, opts, cur) {
      return '<div class="unit" role="group" aria-label="' + aria + '">' + opts.map(function (o) {
        return '<button type="button" data-a="' + act + '" data-v="' + o[0] + '" aria-pressed="' + (String(cur) === String(o[0])) + '">' + o[1] + '</button>';
      }).join('') + '</div>';
    }
    function f(id, k, label) {
      return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" data-cd="' + k + '" inputmode="decimal" autocomplete="off" value="' + esc(d[k]) + '"></div>';
    }
    var html = '<div class="calc"><h3>Calorie calculator</h3><div class="crow">' +
      seg('Sex', 'calc-sex', [['m', 'Male'], ['f', 'Female']], c.sex) +
      seg('Units', 'calc-units', [['metric', 'kg, cm'], ['imperial', 'lb, ft']], c.imp ? 'imperial' : 'metric') + '</div>' +
      '<div class="cfields">' + f('cage', 'age', 'Age') +
      (c.imp ? f('chf', 'h', 'Height (ft)') + f('chi', 'hin', 'Height (in)') : f('chc', 'h', 'Height (cm)')) +
      f('cwt', 'w', 'Weight (' + (c.imp ? 'lb' : 'kg') + ')') + '</div>' +
      '<div class="actl" role="group" aria-label="Activity level">' + ACT.map(function (a, i) {
        return '<button type="button" class="actbtn" data-a="calc-act" data-v="' + i + '" aria-pressed="' + (c.act === i) + '"><span class="an">' + a[0] + '</span><span class="sub">' + a[1] + '</span></button>';
      }).join('') + '</div>' +
      seg('Goal', 'calc-goal', [['lose', 'Lose weight'], ['maintain', 'Maintain'], ['gain', 'Gain weight']], c.goal) +
      (ui.calcErr ? '<p class="err" style="margin:0">' + esc(ui.calcErr) + '</p>' : '') +
      '<button type="button" class="primary" data-a="calc-run">Calculate</button>';
    if (ui.calcShown) {
      var p = calcParse();
      if (!p.err) {
        var bmr = 10 * p.kg + 6.25 * p.cm - 5 * p.age + (c.sex === 'm' ? 5 : -161);
        var tdee = bmr * ACT[c.act][2];
        var m = Math.round(tdee / 10) * 10;
        html += '<div class="stats cstats"><div class="stat"><span class="num">' + fmtK(bmr) + '</span><span class="l">BMR (kcal)</span></div>' +
          '<div class="stat"><span class="num">' + fmtK(m) + '</span><span class="l">Maintenance (kcal)</span></div></div>';
        function row(title, sub, kcal) {
          return '<div class="meal"><div class="mn"><span class="mname">' + esc(title) + '</span><span class="sub">' + esc(sub) + '</span></div>' +
            '<button type="button" class="secondary" data-a="calc-use" data-kcal="' + kcal + '">Use</button></div>';
        }
        if (c.goal === 'maintain') {
          html += row('Maintain weight', fmtK(m) + ' kcal a day', m);
        } else {
          calcPlans(tdee).forEach(function (pl) {
            html += row((c.goal === 'lose' ? 'Lose ' : 'Gain ') + pl.rate + ' ' + pl.unit + ' a week',
              fmtK(pl.kcal) + ' kcal a day \u00B7 ' + fmtK(pl.diff) + (c.goal === 'lose' ? ' below' : ' above') + ' maintenance' +
              (pl.limited ? ' \u00B7 lowest level this calculator recommends' : ''), pl.kcal);
          });
        }
        html += '<p class="sub">Estimates only, not medical advice.</p>';
      }
    }
    return html + '</div>';
  }
  function calcAction(a, t) {
    var c = state.calc, v = t.dataset.v;
    if (a === 'calc-toggle') {
      ui.calcOpen = !ui.calcOpen; ui.calcShown = false; ui.calcErr = '';
      if (ui.calcOpen) { calcInitDrafts(); ui.focus = '#cage'; }
    } else if (a === 'calc-sex') { c.sex = v; persist(); }
    else if (a === 'calc-units') {
      var want = v === 'imperial';
      if (want !== c.imp) {
        var p = calcParse();
        c.imp = want;
        if (!p.err) { c.age = p.age; c.cm = p.cm; c.kg = p.kg; calcInitDrafts(); }
        else { ui.calcDraft.h = ''; ui.calcDraft.hin = ''; ui.calcDraft.w = ''; }
      }
      persist();
    } else if (a === 'calc-act') { c.act = +v; persist(); }
    else if (a === 'calc-goal') { c.goal = v; persist(); }
    else if (a === 'calc-run') {
      var q = calcParse();
      if (q.err) { ui.calcErr = q.err; ui.calcShown = false; }
      else { ui.calcErr = ''; c.age = q.age; c.cm = q.cm; c.kg = q.kg; state.bodyKg = q.kg; ui.calcShown = true; persist(); }
    } else if (a === 'calc-use') {
      state.calTarget = Math.round(+t.dataset.kcal);
      ui.calcOpen = false; ui.calcShown = false;
      persist();
    }
    render();
  }

  /* ---------- Nutrition targets ---------- */
  // Automatic targets are typical adult guidelines scaled to body weight and calories.
  // Anything the person types in replaces the automatic value for that nutrient.
  var NUT_KIND = { satfat: 'limit', transfat: 'limit', chol: 'limit', sugars: 'limit', salt: 'limit', sodium: 'limit', caffeine: 'limit' };
  function weightKnown() { return state.bodyKg > 0 || !!(state.calc && state.calc.kg > 0); }
  function maintenanceKcal() {
    var kg = bodyKg(), c = state.calc || {};
    if (c.age && c.cm) {
      var bmr = 10 * kg + 6.25 * c.cm - 5 * c.age + (c.sex === 'f' ? -161 : 5);
      return Math.round(bmr * ACT[c.act || 0][2] / 10) * 10;
    }
    return Math.round(33 * kg / 10) * 10;
  }
  function autoTargets() {
    var kg = bodyKg();
    var kcal = maintenanceKcal();
    var kc = state.calTarget > 0 ? state.calTarget : kcal;
    var p = Math.round(1.8 * kg);
    var f = Math.round(Math.max(0.8 * kg, 0.25 * kc / 9));
    var c = Math.max(0, Math.round((kc - 4 * p - 9 * f) / 4));
    return {
      kcal: kcal, p: p, c: c, f: f,
      satfat: Math.round(0.10 * kc / 9), monofat: Math.round(0.15 * kc / 9), polyfat: Math.round(0.07 * kc / 9),
      transfat: Math.round(0.01 * kc / 9 * 10) / 10, chol: 300, sugars: Math.round(0.10 * kc / 4), starch: 0, fibre: 30,
      salt: 6, sodium: 2400, potassium: 3500, calcium: 700, iron: 14, magnesium: 375, zinc: 10,
      vita: 800, vitc: 80, vitd: 10, vite: 12, vitb12: 2.5, caffeine: 400
    };
  }
  function isCustom(k) { return (k === 'kcal' ? state.calTarget : state.targets[k]) > 0; }
  function tgt(k) {
    var o = k === 'kcal' ? state.calTarget : state.targets[k];
    if (o > 0) return o;
    return weightKnown() ? (autoTargets()[k] || 0) : 0;
  }
  function kindOf(k) { return k === 'kcal' ? 'limit' : (NUT_KIND[k] || 'goal'); }
  function pctOf(e, t) { return t > 0 ? Math.min(100, Math.round(e / t * 100)) : 0; }
  function barHTML(kind, e, t) {
    if (!(t > 0)) return '';
    var cls = kind === 'limit' ? (e > t ? 'over' : '') : (e >= t ? 'ok' : '');
    return '<div class="tbar" role="img" aria-label="' + pctOf(e, t) + ' percent of target"><i class="' + cls + '" style="width:' + pctOf(e, t) + '%"></i></div>';
  }
  function setTarget(k, raw) {
    var n = Number(String(raw).trim().replace(',', '.'));
    var good = isFinite(n) && n > 0 && n <= 100000;
    if (k === 'kcal') state.calTarget = good && n <= 20000 ? Math.round(n) : 0;
    else if (good) state.targets[k] = +n.toFixed(2);
    else delete state.targets[k];
    persist();
    render();
  }
  function tgtRow(k, label, unit) {
    var val = tgt(k), custom = isCustom(k);
    return '<div class="trow2"><label for="tg-' + k + '">' + label + ' <span class="sub">' + (kindOf(k) === 'limit' ? 'limit' : 'goal') + '</span></label>' +
      '<div class="tin"><input id="tg-' + k + '" data-tg="' + k + '" inputmode="decimal" autocomplete="off" placeholder="-" value="' + (val > 0 ? (k === 'kcal' ? Math.round(val) : fmtD(val)) : '') + '">' +
      '<span class="ul">' + unit + '</span>' +
      (custom ? '<button type="button" class="linkbtn" data-a="tgt-reset" data-k="' + k + '">Reset</button>'
        : val > 0 ? '<span class="chip">Auto</span>' : '<span class="chip off">Off</span>') + '</div></div>';
  }
  function targetsPanelHTML() {
    var html = '<div class="tpanel"><h3>Targets</h3>' +
      '<div class="trow2"><label for="tbw">Your weight</label><div class="tin"><input id="tbw" inputmode="decimal" autocomplete="off" value="' +
      (weightKnown() ? fmtW(bodyKg()) : '') + '" placeholder="-"><span class="ul">' + state.unit + '</span></div></div>' +
      (weightKnown() ? '<p class="sub tnote">Automatic targets use your weight. Change any number to set your own.</p>'
        : '<p class="sub tnote">Add your weight to get automatic targets for every nutrient.</p>') +
      tgtRow('kcal', 'Calories', 'kcal') + tgtRow('p', 'Protein', 'g') + tgtRow('c', 'Carbs', 'g') + tgtRow('f', 'Fats', 'g') +
      '<button type="button" class="linkbtn" data-a="tgt-more">' + (ui.tgtMore ? 'Hide other nutrients' : 'Other nutrients') + '</button>';
    if (ui.tgtMore) html += NUT.map(function (n) { return tgtRow(n[0], n[1], n[2]); }).join('');
    html += '<button type="button" class="linkbtn" data-a="calc-toggle">' + (ui.calcOpen ? 'Close calorie calculator' : 'Work out my calories') + '</button>';
    if (ui.calcOpen) html += calcHTML();
    return html + '</div>';
  }
  function tgtAction(a, t) {
    if (a === 'tgt-open') ui.tgtOpen = !ui.tgtOpen;
    else if (a === 'tgt-more') ui.tgtMore = !ui.tgtMore;
    else if (a === 'tgt-reset') {
      if (t.dataset.k === 'kcal') state.calTarget = 0; else delete state.targets[t.dataset.k];
      persist();
    }
    render();
  }
  function statHTML(k, label, unit, eaten) {
    var t = tgt(k);
    var big = k === 'kcal' ? fmtK(eaten) : fmtG(eaten);
    var cap = t > 0 ? label + ' of ' + (k === 'kcal' ? fmtK(t) : fmtG(t)) + ' ' + unit : (k === 'kcal' ? label : label + ' (' + unit + ')');
    var left = '';
    if (k === 'kcal' && t > 0) left = '<span class="l">' + (eaten <= t ? fmtK(t - eaten) + ' kcal left' : fmtK(eaten - t) + ' kcal over') + '</span>';
    return '<div class="stat"><span class="num">' + big + '</span><span class="l">' + cap + '</span>' + barHTML(kindOf(k), eaten, t) + left + '</div>';
  }
  // Calories as a ring with what is left, above the macro tiles.
  function calHeroHTML(eaten) {
    var t = tgt('kcal');
    var over = t > 0 && eaten > t;
    var ring = '<div class="cring' + (over ? ' over' : '') + '" style="--p:' + pctOf(eaten, t) + '"' +
      (t > 0 ? ' role="img" aria-label="' + pctOf(eaten, t) + ' percent of your calorie target"' : '') +
      '><span class="num">' + fmtK(eaten) + '</span><small>' + (t > 0 ? 'of ' + fmtK(t) : 'kcal') + '</small></div>';
    var info = t > 0
      ? '<span class="l">' + (over ? 'Over target' : 'Left today') + '</span><span class="num big' + (over ? ' hot' : '') + '">' + fmtK(Math.abs(t - eaten)) + '</span><span class="l">kcal</span>'
      : '<span class="l">Calories eaten</span><span class="sub">Set a calorie target to track what is left.</span>';
    return '<div class="stat hero">' + ring + '<div class="hinfo">' + info + '</div></div>';
  }
  function mealsHTML() {
    var t0 = today();
    var d = ui.mealDay || t0;
    var list = mealsOn(d);
    var tot = mealTotals(list);
    var title = d === t0 ? 'Today' : parseD(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    var html = '<div class="pagehead"><h2>' + title + '</h2><div class="wnbtns">' +
      '<button type="button" class="iconbtn" data-a="meal-prev" aria-label="Previous day">\u2039</button>' +
      '<button type="button" class="iconbtn" data-a="meal-today">Today</button>' +
      '<button type="button" class="iconbtn" data-a="meal-next" aria-label="Next day">\u203A</button></div></div>';
    html += '<div class="mstats">' + calHeroHTML(tot.kcal) + statHTML('p', 'Protein', 'g', tot.p) +
      statHTML('c', 'Carbs', 'g', tot.c) + statHTML('f', 'Fats', 'g', tot.f) + '</div>';
    html += '<div class="linkrow"><button type="button" class="linkbtn" data-a="meal-allday" aria-expanded="' + !!ui.dayAll + '">' + (ui.dayAll ? 'Hide all nutrients' : 'All nutrients') + '</button>' +
      '<button type="button" class="linkbtn" data-a="tgt-open" aria-expanded="' + !!ui.tgtOpen + '">' + (ui.tgtOpen ? 'Hide targets' : 'Targets') + '</button></div>';
    if (ui.dayAll) html += '<div class="card">' + dayNutrientsHTML(list) + '</div>';
    if (ui.tgtOpen) html += targetsPanelHTML();
    var extras = ui.moreOpen ? NUT.map(function (n) {
      return '<div class="field"><label for="mx-' + n[0] + '">' + n[1] + ' (' + n[2] + ')</label><input id="mx-' + n[0] + '" data-mx="' + n[0] +
        '" inputmode="decimal" autocomplete="off" value="' + esc(ui.mealDraft.d[n[0]] === undefined ? '' : ui.mealDraft.d[n[0]]) + '"></div>';
    }).join('') : '';
    html += scanBoxHTML() + '<div class="mform"><button type="button" class="secondary wide" data-a="scan-open">Scan barcode</button>' +
      catPickerHTML() +
      mfield('mn', 'name', 'Meal', true) + mfield('mk', 'kcal', 'Calories') + mfield('mp', 'p', 'Protein (g)') +
      mfield('mc', 'c', 'Carbs (g)') + mfield('mf', 'f', 'Fats (g)') +
      '<button type="button" class="linkbtn wide" data-a="meal-more" style="text-align:left">' + (ui.moreOpen ? 'Hide extra nutrition details' : 'Add more nutrition details (optional)') + '</button>' + extras +
      (ui.mealErr ? '<p class="err">' + esc(ui.mealErr) + '</p>' : '') +
      '<button type="button" class="submit" data-a="meal-add">Add meal</button></div>';
    html += '<div class="sect">' + mealSectionsHTML(list, true) + '</div>';
    return html;
  }
  function addMeal() {
    var dr = ui.mealDraft;
    var name = dr.name.trim().replace(/\s+/g, ' ');
    var v = { kcal: numOrZero(dr.kcal), p: numOrZero(dr.p), c: numOrZero(dr.c), f: numOrZero(dr.f) };
    var d = {}, bad = false;
    NUT.forEach(function (n) {
      var raw = String(dr.d[n[0]] === undefined ? '' : dr.d[n[0]]).trim();
      if (raw === '') return;
      var x = numOrZero(raw);
      if (isNaN(x)) bad = true; else d[n[0]] = x;
    });
    if (!name) { ui.mealErr = 'Add a name for the meal.'; ui.focus = '#mn'; render(); return; }
    if (bad || isNaN(v.kcal) || isNaN(v.p) || isNaN(v.c) || isNaN(v.f)) { ui.mealErr = 'Calories, macros and details need to be numbers of 0 or more.'; render(); return; }
    var meal = { id: uid(), date: ui.mealDay || today(), cat: curCat(), name: name, kcal: v.kcal, p: v.p, c: v.c, f: v.f, ts: Date.now() };
    if (Object.keys(d).length) meal.d = d;
    if (ui.scan) {
      if (ui.scan.info && Object.keys(ui.scan.info).length) meal.info = ui.scan.info;
      var g = Number(String(ui.scan.grams).replace(',', '.'));
      if (isFinite(g) && g > 0) meal.amt = g;
    }
    state.meals.push(meal);
    ui.mealDraft = { name: '', kcal: '', p: '', c: '', f: '', d: {} };
    ui.scan = null;
    ui.scanAll = false;
    ui.mealErr = '';
    persist();
    ui.focus = '#mn';
    render();
  }
  function mealEnter(t) {
    var order = ['name', 'kcal', 'p', 'c', 'f'];
    var i = order.indexOf(t.dataset.md);
    if (i === order.length - 1) { addMeal(); return; }
    var nx = document.querySelector('[data-md="' + order[i + 1] + '"]');
    if (nx) nx.focus();
  }
  function mealAction(a, t) {
    var t0 = today();
    if (a === 'meal-prev') ui.mealDay = addDays(ui.mealDay || t0, -1);
    else if (a === 'meal-next') ui.mealDay = addDays(ui.mealDay || t0, 1);
    else if (a === 'meal-today') ui.mealDay = t0;
    else if (a === 'meal-goto') { ui.mealDay = t.dataset.date; ui.tab = 'meals'; ui.focus = '#mn'; }
    else if (a === 'meal-add') { addMeal(); return; }
    else if (a === 'meal-cat') { ui.mealCat = t.dataset.v; }
    else if (a === 'meal-addto') { ui.mealCat = t.dataset.v; ui.focus = '#mn'; }
    else if (a === 'meal-more') { ui.moreOpen = !ui.moreOpen; }
    else if (a === 'meal-allday') { ui.dayAll = !ui.dayAll; }
    else if (a === 'meal-toggle') {
      ui.openMeal[t.dataset.id] = !ui.openMeal[t.dataset.id];
      ui.focus = '[data-a="meal-toggle"][data-id="' + t.dataset.id + '"]';
      render();
      return;
    } else if (a === 'meal-del') {
      armThen('meal:' + t.dataset.id, function () {
        state.meals = state.meals.filter(function (m) { return m.id !== t.dataset.id; });
        persist(); render();
      });
      return;
    }
    ui.mealErr = '';
    render();
  }
  /* ---------- Records tab ---------- */
  function chartHTML(k, flags) {
    var byDay = {};
    state.entries.filter(function (e) { return key(e.ex) === k && counts(e); }).forEach(function (e) {
      var v = e1rm(e.kg, e.reps);
      if (v === null) v = e.kg;
      var d = byDay[e.date] || (byDay[e.date] = { date: e.date, v: -1, pr: false });
      if (v > d.v) d.v = v;
      var f = flags[e.id];
      if (f && f.types.some(function (t) { return t.t === 'e1rm' || t.t === 'weight'; })) d.pr = true;
    });
    var pts = Object.keys(byDay).sort().map(function (d) { return byDay[d]; });
    if (pts.length < 2) return '';
    var W = 480, H = 190, L = 54, R = 14, T = 14, B = 28;
    var t0 = new Date(pts[0].date + 'T00:00:00').getTime();
    var t1 = new Date(pts[pts.length - 1].date + 'T00:00:00').getTime();
    var vmin = Math.min.apply(null, pts.map(function (p) { return p.v; }));
    var vmax = Math.max.apply(null, pts.map(function (p) { return p.v; }));
    var padv = (vmax - vmin) * 0.15 || vmax * 0.05 || 1;
    var lo = Math.max(0, vmin - padv), hi = vmax + padv;
    function X(d) {
      var t = new Date(d + 'T00:00:00').getTime();
      return L + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - L - R);
    }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); }
    var line = pts.map(function (p) { return X(p.date).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Estimated one rep max over time">' +
      '<line x1="' + L + '" y1="' + Y(hi) + '" x2="' + (W - R) + '" y2="' + Y(hi) + '" stroke="var(--line)"/>' +
      '<line x1="' + L + '" y1="' + Y(lo) + '" x2="' + (W - R) + '" y2="' + Y(lo) + '" stroke="var(--line)"/>' +
      '<text x="' + (L - 6) + '" y="' + (Y(hi) + 4) + '" text-anchor="end" font-size="12" fill="var(--mute)">' + fmtW(hi) + '</text>' +
      '<text x="' + (L - 6) + '" y="' + (Y(lo) + 4) + '" text-anchor="end" font-size="12" fill="var(--mute)">' + fmtW(lo) + '</text>' +
      '<text x="' + L + '" y="' + (H - 8) + '" font-size="12" fill="var(--mute)">' + fmtDate(pts[0].date) + '</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end" font-size="12" fill="var(--mute)">' + fmtDate(pts[pts.length - 1].date) + '</text>' +
      '<polyline points="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>';
    pts.forEach(function (p) {
      svg += '<circle cx="' + X(p.date).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="' + (p.pr ? 5 : 3.5) + '" fill="' + (p.pr ? 'var(--pr)' : 'var(--accent)') + '"/>';
    });
    return svg + '</svg>';
  }

  function recordsHTML() {
    if (!state.entries.some(counts)) {
      return '';
    }
    var groups = {};
    state.entries.forEach(function (e) {
      if (!counts(e)) return;
      var k = key(e.ex);
      var g = groups[k] || (groups[k] = { k: k, name: e.ex, last: e.date, lastTs: e.ts, n: 0 });
      g.n++;
      if (e.date > g.last || (e.date === g.last && e.ts >= g.lastTs)) { g.last = e.date; g.lastTs = e.ts; g.name = e.ex; }
    });
    var rows = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) {
      return a.last < b.last ? 1 : a.last > b.last ? -1 : a.name.localeCompare(b.name);
    });
    if (!ui.sel || !groups[ui.sel]) ui.sel = rows[0].k;

    var html = '<h3>All-time bests</h3><div class="tablewrap"><table><thead><tr><th scope="col">Lift</th><th scope="col">Heaviest</th>' +
      '<th scope="col">Est. 1RM</th><th scope="col" class="r">Last</th></tr></thead><tbody>';
    rows.forEach(function (g) {
      var b = bests(g.k);
      html += '<tr class="' + (ui.sel === g.k ? 'sel' : '') + '"><td><button type="button" class="liftbtn" data-a="sel" data-key="' + esc(g.k) + '"' + (ui.sel === g.k ? ' aria-current="true"' : '') + '>' + esc(g.name) + '</button><br><small>' + g.n + (g.n === 1 ? ' set' : ' sets') + '</small></td>' +
        '<td><span class="num">' + fmtW(b.heavy.kg) + '</span> <small>' + state.unit + ' \u00D7 ' + b.heavy.reps + '</small></td>' +
        '<td>' + (b.est ? '<span class="num">' + fmtW(b.estVal) + '</span> <small>' + state.unit + '</small>' : '<small>n/a</small>') + '</td>' +
        '<td class="r"><small>' + fmtDate(g.last) + '</small></td></tr>';
    });
    html += '</tbody></table></div>';

    var k = ui.sel, flags = analyze(state.entries);
    var mine = state.entries.filter(function (e) { return key(e.ex) === k && counts(e); });
    html += '<div class="detail"><h3 class="big">' + esc(groups[k].name) + '</h3><div class="chart">' + chartHTML(k, flags) + '</div>';

    var rm = '';
    REP_TARGETS.forEach(function (r) {
      var best = null;
      mine.forEach(function (e) { if (e.reps >= r && (!best || e.kg > best.kg + EPS)) best = e; });
      if (best) rm += '<div><span class="num">' + fmtW(best.kg) + ' ' + state.unit + '</span><small>' + r + (r === 1 ? ' rep' : '+ reps') + ' \u00B7 ' + fmtDate(best.date) + '</small></div>';
    });
    if (rm) html += '<div class="sect"><h4>Best weight by reps</h4><div class="rm">' + rm + '</div></div>';

    var prs = mine.slice().sort(cmpEntries).reverse().filter(function (e) { return flags[e.id] && flags[e.id].types.length; }).slice(0, 15);
    html += '<div class="sect"><h4>PR history</h4>' + (prs.length ? prs.map(function (e) {
      return '<div class="tl"><span class="d">' + fmtDate(e.date, true) + '</span><span class="s">' + fmtW(e.kg) + ' ' + state.unit + ' \u00D7 ' + e.reps + '</span><span>' + chips(flags[e.id]) + '</span></div>';
    }).join('') : '') + '</div></div>';
    return html;
  }

  /* ---------- Recaps ---------- */
  function recapRange() {
    var r = ui.rc || (ui.rc = { per: 'week', off: 0 });
    var t = parseD(today()), a, b, label;
    if (r.per === 'week') {
      var back = (t.getDay() + 6) % 7;
      a = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back + r.off * 7);
      b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
      label = r.off === 0 ? 'This week' : r.off === -1 ? 'Last week' : fmtDate(dstr(a)) + ' to ' + fmtDate(dstr(b));
    } else if (r.per === 'month') {
      a = new Date(t.getFullYear(), t.getMonth() + r.off, 1);
      b = new Date(a.getFullYear(), a.getMonth() + 1, 0);
      label = a.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    } else {
      a = new Date(t.getFullYear() + r.off, 0, 1);
      b = new Date(a.getFullYear(), 11, 31);
      label = String(a.getFullYear());
    }
    return { from: dstr(a), to: dstr(b), label: label };
  }
  // Counts what happened between two dates (inclusive). Days after today do not count towards "of N days".
  function recapStats(from, to) {
    var t0 = today(), end = to > t0 ? t0 : to;
    var days = 0;
    if (end >= from) days = Math.round((parseD(end) - parseD(from)) / 86400000) + 1;
    var activeId = state.active ? state.active.id : null;
    var lifted = {}, wk = {};
    state.entries.forEach(function (e) {
      if (e.cardio || e.date < from || e.date > to || (activeId && e.wid === activeId)) return;
      lifted[e.date] = true;
      wk[e.wid || 'd:' + e.date] = true;
    });
    var flags = analyze(state.entries), prs = {};
    state.entries.forEach(function (e) {
      if (e.date < from || e.date > to || (activeId && e.wid === activeId)) return;
      var f = flags[e.id];
      if (f && f.types.length) prs[(e.wid || e.date) + '|' + key(e.ex)] = true;
    });
    var byDay = {};
    state.meals.forEach(function (m) { if (m.date >= from && m.date <= to) (byDay[m.date] || (byDay[m.date] = [])).push(m); });
    var kt = tgt('kcal'), pt = tgt('p'), kcalHit = 0, protHit = 0, logged = 0;
    Object.keys(byDay).forEach(function (d) {
      var tot = mealTotals(byDay[d]);
      logged++;
      if (kt > 0 && tot.kcal >= kt * 0.9 && tot.kcal <= kt * 1.1) kcalHit++;
      if (pt > 0 && tot.p >= pt) protHit++;
    });
    return { days: days, lifted: Object.keys(lifted).length, workouts: Object.keys(wk).length, prs: Object.keys(prs).length,
      logged: logged, kcalHit: kcalHit, protHit: protHit, hasK: kt > 0, hasP: pt > 0 };
  }
  function recapHTML() {
    var r = ui.rc || (ui.rc = { per: 'week', off: 0 }), rg = recapRange(), st = recapStats(rg.from, rg.to);
    function tile(big, of, cap, pct, hot) {
      return '<div class="rstat' + (hot ? ' hot' : '') + '"><div class="big">' + big + (of ? ' <small>' + of + '</small>' : '') + '</div><div class="cap">' + cap + '</div>' +
        (pct !== null ? '<div class="tbar"><i style="width:' + Math.min(100, pct) + '%"></i></div>' : '') + '</div>';
    }
    function pc(n) { return st.days > 0 ? Math.round(n / st.days * 100) : 0; }
    var per = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
    var h = '<div class="card recap"><h3>Recap</h3>' +
      '<div class="unit" role="group" aria-label="Recap period">' + per.map(function (o) {
        return '<button type="button" data-a="rc-per" data-v="' + o[0] + '" aria-pressed="' + (r.per === o[0]) + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="rhead"><button type="button" class="secondary" data-a="rc-nav" data-v="-1" aria-label="Previous">\u2039</button><span class="rlabel">' + esc(rg.label) + '</span>' +
      '<button type="button" class="secondary" data-a="rc-nav" data-v="1" aria-label="Next"' + (r.off >= 0 ? ' disabled' : '') + '>\u203A</button></div>' +
      '<div class="rgrid">' +
      tile(st.lifted, 'of ' + st.days + ' days', 'Days lifted' + (st.workouts ? ' \u00B7 ' + st.workouts + (st.workouts === 1 ? ' workout' : ' workouts') : ''), pc(st.lifted)) +
      tile(st.prs, '', st.prs === 1 ? 'PR' : 'PRs', null, st.prs > 0) +
      tile(st.hasK ? st.kcalHit : '-', st.hasK ? 'of ' + st.days + ' days' : '', 'Calories on target', st.hasK ? pc(st.kcalHit) : null) +
      tile(st.hasP ? st.protHit : '-', st.hasP ? 'of ' + st.days + ' days' : '', 'Protein goal hit', st.hasP ? pc(st.protHit) : null) +
      '</div>' +
      '<p class="rnote">' + (st.hasK || st.hasP ? 'Calories on target means within 10% of your calorie target. Only days with meals logged count (' + st.logged + ' in this period).'
        : 'Add your weight on this page to get food targets for the recap.') + ' A PR counts once per lift per workout.</p></div>';
    return h;
  }
  function recapAction(a, t) {
    var r = ui.rc || (ui.rc = { per: 'week', off: 0 });
    if (a === 'rc-per') { if (r.per !== t.dataset.v) { r.per = t.dataset.v; r.off = 0; } }
    else if (a === 'rc-nav') r.off = Math.min(0, r.off + Number(t.dataset.v));
    render();
  }

  /* ---------- Friends tab (data comes from the functions in supabase/friends.sql) ---------- */
  var SHARE_KEYS = [['workouts', 'Workouts and sets'], ['meals', 'Meals and calories'], ['plans', 'Plans and calendar'], ['body', 'Weight, age and gender']];
  var SHARE_LV = { 'public': 'Public', friends: 'Friends', 'private': 'Only me' };
  var searchTimer = null;
  function tickHTML(v) { return v ? '<span class="vtick" role="img" aria-label="Verified" title="Verified"></span>' : ''; }
  // Post and profile photos are private, so each is shown through a link that lasts an hour. Pages render
  // straight away with placeholders, and the photos are swapped in place once their links arrive, so
  // typing in a search box is never interrupted by a re-render.
  var signed = {}, wanted = {}, signTimer = null;
  function signedSrc(bucket, path) {
    var k = bucket + '|' + path, hit = signed[k];
    if (hit && Date.now() - hit.t < 50 * 60000) return hit.u;
    if (!hit || hit.u) { wanted[k] = true; clearTimeout(signTimer); signTimer = setTimeout(signWanted, 0); }
    return '';
  }
  function signWanted() {
    var keys = Object.keys(wanted), byBucket = {};
    wanted = {};
    if (!keys.length || !sb) return;
    keys.forEach(function (k) { var i = k.indexOf('|'); (byBucket[k.slice(0, i)] = byBucket[k.slice(0, i)] || []).push(k.slice(i + 1)); });
    Object.keys(byBucket).forEach(function (bucket) {
      var paths = byBucket[bucket];
      var done = function (got) {
        paths.forEach(function (p) { signed[bucket + '|' + p] = { u: got[p] || '', t: Date.now() }; });
        document.querySelectorAll('[data-ph]').forEach(function (el) {
          var hit = signed[el.dataset.ph];
          if (!hit) return;
          if (hit.u) el.innerHTML = '<img src="' + esc(hit.u) + '" alt="' + esc(el.dataset.alt || '') + '"' + (el.dataset.alt ? ' loading="lazy"' : '') + '>';
          else if (el.dataset.alt) el.innerHTML = '<span class="sub">Photo unavailable</span>';
          el.removeAttribute('data-ph');
        });
      };
      sb.storage.from(bucket).createSignedUrls(paths, 3600).then(function (r) {
        var got = {};
        (r.data || []).forEach(function (x) { if (x.signedUrl) got[x.path] = x.signedUrl; });
        done(got);
      }, function () { done({}); });
    });
  }
  // A box that shows the photo when its link is ready. inner is what shows until then.
  function photoBox(tag, cls, bucket, path, alt, inner) {
    var src = signedSrc(bucket, path);
    return '<' + tag + ' class="' + cls + '"' + (src ? '' : ' data-ph="' + esc(bucket + '|' + path) + '"') + (alt ? ' data-alt="' + esc(alt) + '"' : ' aria-hidden="true"') + '>' +
      (src ? '<img src="' + esc(src) + '" alt="' + esc(alt) + '"' + (alt ? ' loading="lazy"' : '') + '>' : inner) + '</' + tag + '>';
  }
  function avatarHTML(c, big) {
    var letter = esc(String(c.name || c.username || '?').trim().charAt(0).toUpperCase()), cls = 'avatar' + (big === 'xl' ? ' xl' : big ? ' big' : '');
    return c.avatar ? photoBox('span', cls, 'avatars', c.avatar, '', letter) : '<span class="' + cls + '" aria-hidden="true">' + letter + '</span>';
  }
  // Re-draw after data arrives, unless someone is typing (a re-render would take the keyboard away).
  function softRender() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'file') return;
    render();
  }
  // Errors from Supabase when a table or function it was asked for has not been created yet.
  function notSetUp(e) { return /could not find the function|does not exist|schema cache/i.test((e && e.message) || ''); }
  function rpcErr(e) { return notSetUp(e) ? 'Friends are not set up in Supabase yet. Run supabase/friends.sql first.' : friendly(e); }
  // Avatar, name, tick and a line underneath. Links to their profile unless it is you.
  function whoHTML(c, isMe, subHTML) {
    var inner = avatarHTML(c) + '<span class="pmeta"><span class="pn"><span class="pnt">' + esc(isMe ? 'You' : c.name) + '</span>' + tickHTML(c.verified) + '</span>' +
      '<span class="sub">' + subHTML + '</span></span>';
    return isMe ? '<span class="pbtn">' + inner + '</span>'
      : '<button type="button" class="pbtn" data-a="fr-open" data-u="' + esc(c.username) + '">' + inner + '</button>';
  }
  function loadFriends() {
    var fr = ui.fr;
    fr.loading = true;
    sb.rpc('my_friends').then(function (r) {
      fr.loading = false;
      if (r.error) { fr.err = rpcErr(r.error); fr.list = []; } else { fr.list = r.data || []; }
      softRender();
    }, function (e) { fr.loading = false; fr.err = rpcErr(e); fr.list = []; softRender(); });
  }
  function searchTerm() { return ui.fr.q.trim().replace(/^@/, '').toLowerCase(); }
  // Results are painted into their own box so typing is never interrupted by a re-render.
  function searchUsers() {
    var fr = ui.fr, q = searchTerm();
    clearTimeout(searchTimer);
    if (q.length < 2) { fr.results = null; fr.searching = false; fr.searchErr = ''; paintResults(); return; }
    fr.searching = true;
    searchTimer = setTimeout(function () {
      sb.rpc('search_users', { q: q }).then(function (r) {
        if (searchTerm() !== q) return;
        fr.searching = false;
        fr.searchErr = r.error ? rpcErr(r.error) : '';
        fr.results = r.error ? [] : (r.data || []);
        paintResults();
      }, function (e) { fr.searching = false; fr.searchErr = rpcErr(e); paintResults(); });
    }, 250);
  }
  function paintResults() { var el = $('frres'); if (el) el.innerHTML = resultsHTML(); }
  function relButtons(c, inList) {
    var u = esc(c.username), busy = ui.fr.busy[c.username] ? ' disabled' : '';
    if (c.relation === 'friends') return inList ? '<span class="chev" aria-hidden="true">\u203A</span>' : '<span class="chip done">Friends</span>';
    if (c.relation === 'outgoing') return '<span class="chip">Requested</span>' +
      (inList ? '<button type="button" class="linkbtn mute" data-a="fr-remove" data-u="' + u + '"' + busy + '>Cancel</button>' : '');
    if (c.relation === 'incoming') return '<button type="button" class="primary small" data-a="fr-add" data-u="' + u + '"' + busy + '>Accept</button>' +
      '<button type="button" class="linkbtn mute" data-a="fr-remove" data-u="' + u + '"' + busy + '>Decline</button>';
    return '<button type="button" class="primary small add" data-a="fr-add" data-u="' + u + '"' + busy + ' aria-label="Add @' + u + ' as a friend">Add</button>';
  }
  function personRow(c, inList) {
    return '<div class="person">' + whoHTML(c, false, '@' + esc(c.username)) + '<div class="pact">' + relButtons(c, inList) + '</div></div>';
  }
  function resultsHTML() {
    var fr = ui.fr, q = searchTerm();
    if (q.length < 2) return '';
    if (fr.searchErr) return '<p class="err">' + esc(fr.searchErr) + '</p>';
    if (!fr.results) return '<p class="sub">Searching...</p>';
    if (!fr.results.length) return fr.searching ? '<p class="sub">Searching...</p>' : '<p class="sub">No one found with a username starting @' + esc(q) + '.</p>';
    return '<div class="plist">' + fr.results.map(function (c) { return personRow(c, false); }).join('') + '</div>';
  }
  /* ---- leaderboard (friends_leaderboard in supabase/leaderboard.sql) ---- */
  var LB_METRICS = { volume: 'Weight moved', workouts: 'Workouts' };
  var LB_PERIODS = { week: 'This week', month: 'This month', all: 'All time' };
  function loadBoard() {
    var fr = ui.fr, period = fr.period;
    fr.boardLoading = true;
    sb.rpc('friends_leaderboard', { period: period }).then(function (r) {
      if (fr.period !== period) return;
      fr.boardLoading = false;
      fr.boardErr = !r.error ? '' : notSetUp(r.error) ? 'The leaderboard is not set up in Supabase yet. Run supabase/leaderboard.sql first.' : friendly(r.error);
      fr.board = r.error ? [] : (r.data || []);
      softRender();
    }, function (e) { fr.boardLoading = false; fr.boardErr = friendly(e); fr.board = []; softRender(); });
  }
  function segHTML(action, opts, cur, label, uiKey) {
    return '<div class="unit seg3" role="group" aria-label="' + label + '">' + Object.keys(opts).map(function (k) {
      return '<button type="button" data-a="' + action + '"' + (uiKey ? ' data-k="' + uiKey + '"' : '') + ' data-v="' + k + '" aria-pressed="' + (cur === k) + '">' + opts[k] + '</button>';
    }).join('') + '</div>';
  }
  function boardValue(c, m) {
    return m === 'workouts'
      ? { n: String(c.workouts), u: c.workouts === 1 ? 'workout' : 'workouts' }
      : { n: Math.round(toDisp(+c.volume_kg || 0)).toLocaleString('en-GB'), u: state.unit };
  }
  function boardHTML() {
    var fr = ui.fr, m = fr.metric;
    if (fr.board === null && !fr.boardLoading) setTimeout(loadBoard, 0);
    var h = '<div class="lbctl">' + segHTML('fr-metric', LB_METRICS, m, 'Rank by') + segHTML('fr-period', LB_PERIODS, fr.period, 'Time period') + '</div>';
    if (fr.boardErr) return h + '<p class="err">' + esc(fr.boardErr) + '</p>';
    if (!fr.board) return h + '<p class="sub">Loading leaderboard...</p>';
    var key2 = m === 'workouts' ? 'workouts' : 'volume_kg';
    var rows = fr.board.slice().sort(function (a, b) { return (+b[key2] - +a[key2]) || String(a.name).localeCompare(String(b.name)); });
    var rank = 0, last = null;
    h += '<ol class="lb' + (fr.boardLoading ? ' stale' : '') + '">' + rows.map(function (c, i) {
      if (+c[key2] !== last) { rank = i + 1; last = +c[key2]; }
      var v = boardValue(c, m), other = boardValue(c, m === 'workouts' ? 'volume' : 'workouts');
      return '<li class="lbrow' + (c.me ? ' me' : '') + '"><span class="rank' + (rank <= 3 && +c[key2] > 0 ? ' r' + rank : '') + '" aria-label="Rank ' + rank + '">' + rank + '</span>' +
        whoHTML(c, c.me, other.n + ' ' + other.u) +
        '<span class="lbv"><b class="num">' + v.n + '</b><small>' + v.u + '</small></span></li>';
    }).join('') + '</ol>';
    if (rows.length < 2) h += '<p class="sub" style="margin-top:12px">Add friends to see how you stack up.</p>';
    return h + '<p class="rnote">Weight moved counts working and drop sets, not warmups or cardio. Friends who keep their workouts to themselves are not shown.</p>';
  }
  /* ---- photo posts and the feed (supabase/posts.sql) ---- */
  function canPost() { return state.postsReady && state.socialReady && !!state.username; }
  function shareButtonHTML(kind, ref) {
    if (!canPost()) return '';
    if (ui.posted[kind + ':' + ref]) return '<p class="posted">Shared with your friends</p>';
    return '<button type="button" class="secondary share" data-a="post-open" data-kind="' + kind + '" data-ref="' + esc(ref) + '">Share ' + (kind === 'meal' ? 'meal' : 'workout') + '</button>';
  }
  // A snapshot of what is being shared, so the post still reads right if the workout or meal changes later.
  function postDetails(kind, ref) {
    if (kind === 'workout') {
      var w = state.workouts.filter(function (x) { return x.id === ref; })[0];
      if (!w) return null;
      var sets = state.entries.filter(function (e) { return e.wid === ref && !e.cardio && e.type !== 'warmup'; }).length;
      return { plan: w.plan || null, volume_kg: Math.round(volOf(ref) * 10) / 10, sets: sets, mins: Math.max(0, Math.round((w.end - w.start) / 60000)), date: w.date };
    }
    var m = state.meals.filter(function (x) { return x.id === ref; })[0];
    if (!m) return null;
    return { name: m.name, category: m.cat || null, kcal: Math.round(m.kcal), protein: m.p, carbs: m.c, fats: m.f, date: m.date };
  }
  // Redraws a photo at most max pixels across (cropped to a centred square if asked), which keeps uploads
  // small and drops hidden photo details such as location.
  function shrinkImage(file, max, square) {
    max = max || 1600;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, sx = 0, sy = 0;
        if (square) { var side = Math.min(w, h); sx = (w - side) / 2; sy = (h - side) / 2; w = h = side; }
        var k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, sx, sy, w, h, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Could not read that photo.')); }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that photo. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }
  function pickPhoto(file) {
    var p = ui.post;
    if (!p || !file) return;
    if (!/^image\//.test(file.type || '')) { p.err = 'Choose a photo.'; render(); return; }
    p.err = ''; p.reading = true; render();
    shrinkImage(file).then(function (blob) {
      if (ui.post !== p) return;
      if (p.preview) URL.revokeObjectURL(p.preview);
      p.blob = blob; p.preview = URL.createObjectURL(blob); p.reading = false;
      render();
    }, function (e) { p.reading = false; p.err = e.message; render(); });
  }
  function closePost() {
    if (ui.post && ui.post.preview) URL.revokeObjectURL(ui.post.preview);
    ui.post = null;
    render();
  }
  function submitPost() {
    var p = ui.post;
    if (!p || p.busy) return;
    p.busy = true; p.err = ''; render();
    // The photo is optional: without one the post is just the stats and caption.
    var path = p.blob ? user.id + '/' + uid() + '.jpg' : null;
    var upload = path
      ? sb.storage.from('posts').upload(path, p.blob, { contentType: 'image/jpeg', upsert: false }).then(function (r) { if (r.error) throw r.error; })
      : Promise.resolve();
    upload.then(function () {
      return sb.from('posts').insert({ kind: p.kind, caption: p.caption.trim().slice(0, 500) || null, image_path: path, details: p.details }).then(function (r2) {
        if (r2.error) { if (path) sb.storage.from('posts').remove([path]); throw r2.error; }
      });
    }).then(function () {
      ui.posted[p.kind + ':' + p.ref] = true;
      resetPostLists();
      ui.myStats = null;
      closePost();
    }, function (e) { p.busy = false; p.err = friendly(e); render(); });
  }
  function detailsHTML(kind, d) {
    d = d || {};
    var c = function (x, strong) { return '<span class="dchip' + (strong ? ' strong' : '') + '">' + x + '</span>'; };
    if (kind === 'meal') {
      return '<div class="dchips">' + c(esc(d.name || 'Meal'), true) + c(fmtK(+d.kcal || 0) + ' kcal') +
        c('P ' + fmtG(+d.protein || 0) + ' \u00B7 C ' + fmtG(+d.carbs || 0) + ' \u00B7 F ' + fmtG(+d.fats || 0)) + '</div>';
    }
    return '<div class="dchips">' + c(esc(d.plan || 'Workout'), true) +
      (+d.volume_kg > 0 ? c(Math.round(toDisp(+d.volume_kg)).toLocaleString('en-GB') + ' ' + state.unit + ' moved') : '') +
      (+d.sets > 0 ? c(d.sets + (d.sets === 1 ? ' set' : ' sets')) : '') + (+d.mins > 0 ? c(d.mins + ' min') : '') + '</div>';
  }
  function postSheetHTML() {
    var p = ui.post;
    var h = '<div class="scanov postov"><div class="scansheet" data-a="post-noop" role="dialog" aria-modal="true" aria-labelledby="post-h">' +
      '<div class="sheethead"><h3 id="post-h">Share with friends</h3><button type="button" class="linkbtn mute" data-a="post-cancel">Cancel</button></div>' +
      detailsHTML(p.kind, p.details);
    h += p.preview
      ? '<div class="cphoto"><img src="' + p.preview + '" alt="Your photo">' +
        '<button type="button" class="secondary small rmphoto" data-a="post-rmphoto">Remove</button>' +
        '<label class="secondary small swap">Change photo<input type="file" id="postfile" accept="image/*"></label></div>'
      : '<label class="photopick"><input type="file" id="postfile" accept="image/*"><span class="pi" aria-hidden="true"></span><b>' + (p.reading ? 'Reading photo...' : 'Add a photo') + '</b><small>Optional. Take one or choose from your library</small></label>';
    h += '<div class="field"><label for="postcap">Caption <span class="sub">(optional)</span></label><input id="postcap" maxlength="500" autocomplete="off" value="' + esc(p.caption) + '"></div>' +
      (p.err ? '<p class="err" role="alert">' + esc(p.err) + '</p>' : '') +
      '<button type="button" class="submit" data-a="post-go"' + (p.busy || p.reading ? ' disabled' : '') + '>' + (p.busy ? 'Posting...' : 'Post') + '</button>' +
      '<p class="rnote" style="margin:0">Only you and your friends can see posts.</p></div></div>';
    return h;
  }
  function timeAgo(iso) {
    var t = Date.parse(iso), s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return fmtDate(new Date(t).toISOString().slice(0, 10));
  }
  function resetPostLists() { var L = ui.fr.lists; L.feed.items = null; L.mine.items = null; }
  // which: 'feed' (you and your friends) or 'mine' (your own posts, on your profile).
  function loadPosts(which, more) {
    var L = ui.fr.lists[which];
    if (L.loading) return;
    L.loading = true;
    var before = more && L.items && L.items.length ? L.items[L.items.length - 1].created_at : null;
    var q = which === 'feed' ? sb.rpc('friends_feed', { before: before }) : sb.rpc('user_posts', { uname: state.username, before: before });
    q.then(function (r) {
      L.loading = false;
      if (r.error) {
        L.err = which === 'mine' && notSetUp(r.error) ? 'Run supabase/reactions.sql in Supabase to see your posts here.' : friendly(r.error);
        if (!L.items) L.items = [];
      } else {
        var got = r.data || [];
        L.err = '';
        L.items = more ? (L.items || []).concat(got) : got;
        L.more = got.length === 20;
      }
      softRender();
    }, function (e) { L.loading = false; L.err = friendly(e); if (!L.items) L.items = []; softRender(); });
  }
  // Every copy of a post on screen: the feed, your posts and the profile you have open.
  function postCopies(id) {
    var lists = [ui.fr.lists.feed.items, ui.fr.lists.mine.items, ui.fr.view && ui.fr.view.posts];
    var out = [];
    lists.forEach(function (l) { (l || []).forEach(function (p) { if (p.id === id) out.push(p); }); });
    return out;
  }
  var REACTIONS = [['strong', '\uD83D\uDCAA', 'Strong'], ['fire', '\uD83D\uDD25', 'Fire'], ['clap', '\uD83D\uDC4F', 'Clap'], ['heart', '\u2764\uFE0F', 'Love']];
  function reactBarHTML(p) {
    if (!p.reactions) return '';
    var counts = p.reactions.counts || {}, mine = p.reactions.mine;
    return '<div class="reacts" role="group" aria-label="React to this post">' + REACTIONS.map(function (r) {
      var n = +counts[r[0]] || 0, on = mine === r[0];
      return '<button type="button" class="react' + (on ? ' on' : '') + '" data-a="post-react" data-id="' + esc(p.id) + '" data-k="' + r[0] + '" aria-pressed="' + on + '" aria-label="' + r[2] + (n ? ', ' + n : '') + '">' +
        '<span aria-hidden="true">' + r[1] + '</span>' + (n ? '<b>' + n + '</b>' : '') + '</button>';
    }).join('') + '</div>';
  }
  // Shows the change straight away, then takes the counts the database sends back.
  function react(id, kind) {
    var copies = postCopies(id);
    if (!copies.length || !copies[0].reactions) return;
    var before = JSON.parse(JSON.stringify(copies[0].reactions));
    var next = before.mine === kind ? null : kind;
    var after = { counts: Object.assign({}, before.counts), mine: next };
    if (before.mine) after.counts[before.mine] = Math.max(0, (after.counts[before.mine] || 0) - 1);
    if (next) after.counts[next] = (after.counts[next] || 0) + 1;
    copies.forEach(function (p) { p.reactions = after; });
    render();
    sb.rpc('react_to_post', { pid: id, reaction: next }).then(function (r) {
      var got = r.error ? before : r.data;
      postCopies(id).forEach(function (p) { p.reactions = got; });
      softRender();
    }, function () { postCopies(id).forEach(function (p) { p.reactions = before; }); softRender(); });
  }
  // A post without a photo leads with its headline number instead.
  function postStatHTML(p) {
    var d = p.details || {}, label, n, u;
    if (p.kind === 'meal') { label = 'Calories'; n = fmtK(+d.kcal || 0); u = 'kcal'; }
    else if (+d.volume_kg > 0) { label = 'Weight moved'; n = Math.round(toDisp(+d.volume_kg)).toLocaleString('en-GB'); u = state.unit; }
    else if (+d.mins > 0) { label = 'Time'; n = String(d.mins); u = 'min'; }
    else { label = 'Sets'; n = String(+d.sets || 0); u = ''; }
    return '<div class="moved pstat"><span class="l">' + label + '</span><span class="num">' + n + (u ? '<small>' + u + '</small>' : '') + '</span></div>';
  }
  function postCardHTML(p) {
    var armed = ui.armed === 'post:' + p.id;
    var label = p.kind === 'meal' ? 'Meal' : 'Workout';
    var media = p.image_path ? photoBox('div', 'pimg', 'posts', p.image_path, label + ' photo from @' + p.username, '') : postStatHTML(p);
    return '<article class="post"><div class="phd">' + whoHTML(p, p.mine, label + ' \u00B7 ' + timeAgo(p.created_at)) +
      (p.mine ? '<button type="button" class="linkbtn danger mute' + (armed ? ' armed' : '') + '" data-a="post-del" data-id="' + esc(p.id) + '">' + (armed ? 'Tap again to delete' : 'Delete') + '</button>' : '') +
      '</div>' + media +
      '<div class="pbody">' + detailsHTML(p.kind, p.details) +
      (p.caption ? '<p class="pcap"><b>@' + esc(p.username) + '</b> ' + esc(p.caption) + '</p>' : '') + reactBarHTML(p) + '</div></article>';
  }
  function postTileHTML(p) {
    var label = (p.kind === 'meal' ? 'Meal' : 'Workout') + ', ' + timeAgo(p.created_at), d = p.details || {}, inner;
    if (p.image_path) inner = photoBox('span', 'ptimg', 'posts', p.image_path, '', '');
    else if (p.kind === 'meal') inner = '<span class="ptstat"><b>' + fmtK(+d.kcal || 0) + '</b><small>kcal</small></span>';
    else inner = '<span class="ptstat"><b>' + (+d.volume_kg > 0 ? Math.round(toDisp(+d.volume_kg)).toLocaleString('en-GB') : (+d.mins || 0)) + '</b><small>' + (+d.volume_kg > 0 ? state.unit : 'min') + '</small></span>';
    return '<button type="button" class="ptile" data-a="post-view" data-id="' + esc(p.id) + '" aria-label="Open post: ' + esc(label) + '">' + inner + '</button>';
  }
  function postGridHTML(list) { return '<div class="pgrid">' + list.map(postTileHTML).join('') + '</div>'; }
  function postViewHTML() {
    var p = postCopies(ui.viewPost)[0];
    if (!p) return '';
    return '<div class="scanov postov" data-a="post-close"><div class="scansheet pview" data-a="post-noop" role="dialog" aria-modal="true" aria-label="Post">' +
      '<div class="sheethead"><span></span><button type="button" class="linkbtn mute" data-a="post-close">Close</button></div>' + postCardHTML(p) + '</div></div>';
  }
  function postsListHTML(which, emptyHTML, asGrid) {
    if (!state.postsReady) return '<div class="card"><h3>Posts are not switched on yet</h3><p class="sub">Run supabase/posts.sql in the Supabase SQL Editor, then reload the app.</p></div>';
    var L = ui.fr.lists[which];
    if (L.items === null && !L.loading) setTimeout(function () { loadPosts(which, false); }, 0);
    var h = L.err ? '<p class="err">' + esc(L.err) + '</p>' : '';
    if (!L.items) return h + '<p class="sub">Loading posts...</p>';
    if (!L.items.length) return h + emptyHTML;
    h += asGrid ? postGridHTML(L.items) : '<div class="feed">' + L.items.map(postCardHTML).join('') + '</div>';
    if (L.more) h += '<button type="button" class="secondary more" data-a="post-more" data-w="' + which + '"' + (L.loading ? ' disabled' : '') + '>' + (L.loading ? 'Loading...' : 'Load more') + '</button>';
    return h;
  }
  function postAction(a, t) {
    if (a === 'post-noop') return;
    if (a === 'post-open') {
      var d = postDetails(t.dataset.kind, t.dataset.ref);
      if (!d) return;
      ui.post = { kind: t.dataset.kind, ref: t.dataset.ref, details: d, blob: null, preview: '', caption: '', busy: false, reading: false, err: '' };
      render();
      return;
    }
    if (a === 'post-cancel') { if (!ui.post || !ui.post.busy) closePost(); return; }
    if (a === 'post-go') { submitPost(); return; }
    if (a === 'post-rmphoto') {
      if (ui.post && !ui.post.busy) { URL.revokeObjectURL(ui.post.preview); ui.post.blob = null; ui.post.preview = ''; render(); }
      return;
    }
    if (a === 'post-react') { react(t.dataset.id, t.dataset.k); return; }
    if (a === 'post-view') { ui.viewPost = t.dataset.id; render(); return; }
    if (a === 'post-close') { ui.viewPost = null; render(); return; }
    if (a === 'post-more') { loadPosts(t.dataset.w, true); render(); return; }
    if (a === 'post-del') {
      var id = t.dataset.id, L = ui.fr.lists;
      if (ui.armed !== 'post:' + id) { ui.armed = 'post:' + id; render(); return; }
      ui.armed = null;
      var post = postCopies(id)[0];
      if (!post) return;
      sb.from('posts').delete().eq('id', id).then(function (r) {
        if (r.error) { L.feed.err = friendly(r.error); render(); return; }
        if (post.image_path) sb.storage.from('posts').remove([post.image_path]);
        var drop = function (l) { return l && l.filter(function (x) { return x.id !== id; }); };
        L.feed.items = drop(L.feed.items); L.mine.items = drop(L.mine.items);
        if (ui.fr.view && ui.fr.view.posts) ui.fr.view.posts = drop(ui.fr.view.posts);
        if (ui.viewPost === id) ui.viewPost = null;
        ui.myStats = null;
        render();
      }, function (e) { L.feed.err = friendly(e); render(); });
    }
  }
  // Photos are files rather than rows, so they have to be removed before the account itself.
  function removeMyPhotos() {
    var buckets = (state.postsReady ? ['posts'] : []).concat(state.avatarsReady ? ['avatars'] : []);
    return Promise.all(buckets.map(function (b) {
      return sb.storage.from(b).list(user.id, { limit: 1000 }).then(function (r) {
        var names = (r.data || []).map(function (o) { return user.id + '/' + o.name; });
        return names.length ? sb.storage.from(b).remove(names) : null;
      }).then(null, function () { return null; });
    }));
  }
  // Shown instead of social features until they are set up.
  function socialGate() {
    if (!state.socialReady) return '<div class="card"><h3>Friends are not switched on yet</h3><p class="sub">Run supabase/friends.sql in the Supabase SQL Editor, then reload the app.</p></div>';
    if (!state.username) return '<div class="card"><h3>Choose a username first</h3><p class="sub" style="margin:0 0 12px">People find you by your @username.</p>' +
      '<button type="button" class="primary" data-a="fr-needname">Choose a username</button></div>';
    return '';
  }
  function feedTabHTML() {
    var fr = ui.fr;
    if (fr.view || fr.viewLoading) return friendViewHTML();
    var h = '<h2 class="pagetitle">Feed</h2>', gate = socialGate();
    if (gate) return h + gate;
    h += segHTML('fr-pane', { feed: 'Feed', board: 'Leaderboard' }, fr.pane, 'Feed or leaderboard').replace('unit seg3', 'unit seg3 subtabs');
    if (fr.pane === 'board') return h + boardHTML();
    return h + postsListHTML('feed', '<div class="card"><h3>No posts yet</h3><p class="sub">Finish a workout or log a meal, then tap Share. Posts from your friends show up here too. Find friends in your Profile.</p></div>');
  }
  function incomingCount() { return (ui.fr.list || []).filter(function (c) { return c.relation === 'incoming'; }).length; }
  function friendsPaneHTML() {
    var fr = ui.fr, gate = socialGate();
    if (gate) return gate;
    if (fr.list === null && !fr.loading) setTimeout(loadFriends, 0);
    var h = '<div class="field"><label for="frq">Find people</label><div class="ufield"><span aria-hidden="true">@</span><input id="frq" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="username" value="' + esc(fr.q) + '"></div></div>' +
      '<div id="frres" aria-live="polite">' + resultsHTML() + '</div>';
    if (fr.err) h += '<p class="err">' + esc(fr.err) + '</p>';
    var list = fr.list || [];
    var by = function (rel) { return list.filter(function (c) { return c.relation === rel; }); };
    var inc = by('incoming'), mine = by('friends'), out = by('outgoing');
    var rows = function (l) { return '<div class="plist">' + l.map(function (c) { return personRow(c, true); }).join('') + '</div>'; };
    if (inc.length) h += '<div class="sect"><h4>Friend requests <span class="chip pr">' + inc.length + '</span></h4>' + rows(inc) + '</div>';
    h += '<div class="sect"><h4>Your friends' + (mine.length ? ' <span class="chip">' + mine.length + '</span>' : '') + '</h4>' +
      (mine.length ? rows(mine) : fr.list === null ? '<p class="sub">Loading...</p>' : '<p class="sub">No friends yet. Search for someone\'s @username to add them.</p>') + '</div>';
    if (out.length) h += '<div class="sect"><h4>Sent requests</h4>' + rows(out) + '</div>';
    return h;
  }
  function openProfile(u, quiet) {
    var fr = ui.fr;
    fr.viewU = u;
    if (!quiet) { fr.view = null; fr.viewLoading = true; fr.shown = 10; render(); window.scrollTo(0, 0); }
    Promise.all([sb.rpc('view_profile', { uname: u }), state.postsReady ? soft(sb.rpc('user_posts', { uname: u })) : Promise.resolve({ error: true }),
      soft(sb.rpc('profile_stats', { uname: u }))]).then(function (res) {
      var r = res[0], posts = res[1], stats = res[2];
      if (fr.viewU !== u) return;
      fr.viewLoading = false;
      if (r.error || !r.data) { fr.view = null; fr.err = r.error ? rpcErr(r.error) : 'Could not find @' + u + '.'; }
      else { fr.view = r.data; fr.view.posts = posts.error ? null : (posts.data || []); fr.view.stats = stats.error ? null : stats.data; }
      softRender();
    }, function (e) { if (fr.viewU !== u) return; fr.viewLoading = false; fr.view = null; fr.err = rpcErr(e); softRender(); });
  }
  function friendsAction(a, t) {
    var fr = ui.fr, u = t.dataset.u;
    if (a === 'fr-needname') { ui.tab = 'profile'; ui.pp = 'posts'; profileAction('pf-edit'); return; }
    if (a === 'fr-ppane') { ui.pp = t.dataset.v; if (ui.pp === 'friends') loadFriends(); if (ui.pp === 'posts' && state.postsReady) loadPosts('mine', false); render(); window.scrollTo(0, 0); return; }
    if (a === 'fr-open') { openProfile(u); return; }
    if (a === 'fr-back') { fr.view = null; fr.viewLoading = false; fr.viewU = null; render(); window.scrollTo(0, 0); return; }
    if (a === 'fr-more') { fr.shown += 10; render(); return; }
    if (a === 'fr-pane') { fr.pane = t.dataset.v; if (fr.pane === 'board') loadBoard(); if (fr.pane === 'feed' && state.postsReady) loadPosts('feed', false); render(); return; }
    if (a === 'fr-metric') { fr.metric = t.dataset.v; render(); return; }
    if (a === 'fr-period') { if (fr.period === t.dataset.v) return; fr.period = t.dataset.v; loadBoard(); render(); return; }
    if (a === 'fr-share') {
      if (state.sharing[t.dataset.k] === t.dataset.v) return;
      state.sharing[t.dataset.k] = t.dataset.v;
      saveSharing();
      render();
      return;
    }
    if (a === 'fr-add' || a === 'fr-remove') {
      if (a === 'fr-remove' && t.dataset.confirm && ui.armed !== 'fr:' + u) { ui.armed = 'fr:' + u; render(); return; }
      ui.armed = null;
      fr.busy[u] = true;
      render();
      sb.rpc('friend_action', { uname: u, act: a === 'fr-add' ? 'add' : 'remove' }).then(function (r) {
        delete fr.busy[u];
        if (r.error) { fr.err = rpcErr(r.error); render(); return; }
        fr.err = '';
        (fr.results || []).forEach(function (c) { if (c.username === u) c.relation = r.data; });
        if (fr.view && fr.view.username === u) openProfile(u, true);
        loadFriends();
        fr.board = null;
        render();
      }, function (e) { delete fr.busy[u]; fr.err = rpcErr(e); render(); });
    }
  }
  function saveSharing() {
    var sh = state.sharing;
    sb.from('sharing').upsert({ user_id: user.id, workouts: sh.workouts, meals: sh.meals, plans: sh.plans, body: sh.body, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .then(function (r) { var was = ui.shareErr; ui.shareErr = r.error ? friendly(r.error) : ''; if (was !== ui.shareErr) render(); },
        function (e) { ui.shareErr = friendly(e); render(); });
  }
  function privacyHTML() {
    if (!state.socialReady) return '';
    var h = '<div class="card"><h3>Privacy</h3><p class="sub" style="margin:-6px 0 4px">Choose who can see each part of your profile. Your name, @username, profile photo and tick are always visible so people can find you.</p>';
    SHARE_KEYS.forEach(function (k) {
      h += '<div class="shrow"><span id="sh-' + k[0] + '">' + k[1] + '</span><div class="unit seg3" role="group" aria-labelledby="sh-' + k[0] + '">' +
        Object.keys(SHARE_LV).map(function (lv) {
          return '<button type="button" data-a="fr-share" data-k="' + k[0] + '" data-v="' + lv + '" aria-pressed="' + (state.sharing[k[0]] === lv) + '">' + SHARE_LV[lv] + '</button>';
        }).join('') + '</div></div>';
    });
    if (ui.shareErr) h += '<p class="err">' + esc(ui.shareErr) + '</p>';
    return h + '</div>';
  }

  /* ---- someone else's profile ---- */
  function viewActions(v) {
    var u = esc(v.username), busy = ui.fr.busy[v.username] ? ' disabled' : '';
    if (v.relation === 'friends') {
      var armed = ui.armed === 'fr:' + v.username;
      return '<span class="chip done">Friends</span><button type="button" class="linkbtn danger mute' + (armed ? ' armed' : '') + '" data-a="fr-remove" data-confirm="1" data-u="' + u + '"' + busy + '>' + (armed ? 'Tap again to remove' : 'Remove friend') + '</button>';
    }
    if (v.relation === 'self') return '<span class="chip">This is you</span>';
    return relButtons(v, true).replace('>Add<', '>Add friend<');
  }
  function lockedHTML(title, level, v) {
    return '<div class="sect"><h4>' + title + '</h4><div class="locked"><span class="lock" aria-hidden="true"></span><span>' +
      (level === 'private' ? 'Only ' + esc(v.name) + ' can see this.' : 'Only ' + esc(v.name) + '\'s friends can see this.') + '</span></div></div>';
  }
  function friendSetText(x) {
    if (x.cardio) return fmtMins(+x.mins || 0) + ' min';
    return fmtW(+x.kg) + ' \u00D7 ' + x.reps + (x.type === 'warmup' ? ' (warmup)' : x.type === 'drop' ? ' (drop)' : '');
  }
  function workoutsSect(v) {
    if (!v.workouts) return lockedHTML('Workouts', v.sharing.workouts, v);
    var ws = v.workouts;
    if (!ws.length) return '<div class="sect"><h4>Workouts</h4><p class="sub">No workouts yet.</p></div>';
    var cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    var recent = ws.filter(function (w) { return w.date >= cutoff; });
    var sets = 0, vol = 0;
    recent.forEach(function (w) { (w.sets || []).forEach(function (x) { if (!x.cardio && x.type !== 'warmup') { sets++; vol += (+x.kg) * x.reps; } }); });
    var h = '<div class="sect"><h4>Workouts</h4><div class="mstats">' +
      '<div class="stat"><span class="num">' + recent.length + '</span><span class="l">Workouts, 30 days</span></div>' +
      '<div class="stat"><span class="num">' + sets + '</span><span class="l">Sets</span></div>' +
      '<div class="stat"><span class="num">' + Math.round(toDisp(vol)).toLocaleString('en-GB') + '</span><span class="l">Volume (' + state.unit + ')</span></div></div>';
    ws.slice(0, ui.fr.shown).forEach(function (w) {
      var order = [], by = {};
      (w.sets || []).forEach(function (x) { var k = key(x.exercise); if (!by[k]) { by[k] = { name: x.exercise, sets: [] }; order.push(k); } by[k].sets.push(x); });
      var dur = Date.parse(w.ended_at) - Date.parse(w.started_at);
      var at = Date.parse(w.started_at);
      h += '<div class="card fwk"><div class="fwh"><b>' + esc(w.plan || 'Workout') + '</b><span class="sub">' + fmtDate(w.date, true) +
        (isNaN(at) ? '' : ', ' + fmtClock(at)) + (dur > 0 ? ' \u00B7 ' + fmtLength(dur) : '') + '</span></div>' +
        (order.length ? order.map(function (k) {
          return '<div class="exrow"><span class="name">' + esc(by[k].name) + '</span><div class="setline">' +
            by[k].sets.map(function (x) { return '<span class="s">' + friendSetText(x) + '</span>'; }).join('') + '</div></div>';
        }).join('') : '<p class="sub">No sets logged.</p>') + '</div>';
    });
    if (ws.length > ui.fr.shown) h += '<button type="button" class="secondary more" data-a="fr-more">Show more workouts</button>';
    return h + '</div>';
  }
  function mealsSect(v) {
    if (!v.meals) return lockedHTML('Meals', v.sharing.meals, v);
    if (!v.meals.length) return '<div class="sect"><h4>Meals</h4><p class="sub">No meals in the last 2 weeks.</p></div>';
    var days = [], by = {};
    v.meals.forEach(function (m) { if (!by[m.date]) { by[m.date] = []; days.push(m.date); } by[m.date].push(m); });
    var t = +v.cal_target || 0;
    return '<div class="sect"><h4>Meals</h4><div class="card">' + days.map(function (d) {
      var tot = { k: 0, p: 0, c: 0, f: 0 };
      by[d].forEach(function (m) { tot.k += +m.kcal; tot.p += +m.protein; tot.c += +m.carbs; tot.f += +m.fats; });
      return '<div class="nrow"><div class="nl"><b>' + fmtDate(d, true) + '</b><span class="nv"><b>' + fmtK(tot.k) + '</b>' + (t ? ' / ' + fmtK(t) : '') + ' kcal</span></div>' +
        barHTML('limit', tot.k, t) +
        '<p class="sub" style="margin-top:6px">P ' + fmtG(tot.p) + ' \u00B7 C ' + fmtG(tot.c) + ' \u00B7 F ' + fmtG(tot.f) + ' \u00B7 ' + esc(by[d].map(function (m) { return m.name; }).join(', ')) + '</p></div>';
    }).join('') + '</div></div>';
  }
  function plansSect(v) {
    if (!v.plans) return lockedHTML('Plans', v.sharing.plans, v);
    var h = '<div class="sect"><h4>Plans</h4>';
    h += v.plans.length ? '<div class="plans">' + v.plans.map(function (p) {
      var chips = exChipsHTML(p.exercises);
      return '<div class="plan"><div class="ptop"><div class="pname">' + esc(p.name) + '</div></div>' + (chips ? '<div class="pex">' + chips + '</div>' : '') + '</div>';
    }).join('') + '</div>' : '<p class="sub">No plans yet.</p>';
    var t0 = today();
    var up = (v.schedule || []).filter(function (x) { return x.repeat || x.date >= t0; });
    if (up.length) h += '<h4 style="margin-top:18px">Coming up</h4><div class="card">' + up.map(function (x) {
      var when = x.repeat ? 'Every ' + parseD(x.date).toLocaleDateString('en-GB', { weekday: 'long' }) : fmtDate(x.date, true);
      return '<div class="tl"><span class="d">' + when + '</span><span class="s">' + esc(x.plan || 'Workout') + '</span></div>';
    }).join('') + '</div>';
    return h + '</div>';
  }
  function postsSect(v) {
    if (!v.posts) return '';
    return '<div class="sect"><h4>Posts</h4>' + (v.posts.length ? postGridHTML(v.posts) : '<p class="sub">No posts yet.</p>') + '</div>';
  }
  function friendViewHTML() {
    var v = ui.fr.view;
    var h = '<button type="button" class="backbtn" data-a="fr-back">Back</button>';
    if (!v) return h + '<p class="sub" style="margin-top:16px">Loading profile...</p>';
    var st = v.stats || {};
    h += profileHeadHTML({ name: v.name, username: v.username, verified: v.verified, avatar: v.avatar,
      details: v.body ? bodyDetails(v.body.gender, v.body.age, v.body.weight_kg) : [],
      counts: { posts: st.posts !== undefined ? st.posts : v.posts ? v.posts.length : null, friends: st.friends, workouts: st.workouts },
      actions: viewActions(v) });
    if (ui.fr.err) h += '<p class="err">' + esc(ui.fr.err) + '</p>';
    return h + postsSect(v) + workoutsSect(v) + mealsSect(v) + plansSect(v);
  }

  /* ---------- Profile tab ---------- */
  // o: { name, username, verified, avatar, details: [..], counts: { posts, friends, workouts }, actions }
  function profileHeadHTML(o) {
    var count = function (n, label, pane) {
      if (n === null || n === undefined) return '';
      var inner = '<b class="num">' + Number(n).toLocaleString('en-GB') + '</b><small>' + label + '</small>';
      return pane ? '<button type="button" class="igcount" data-a="fr-ppane" data-v="' + pane + '">' + inner + '</button>' : '<span class="igcount">' + inner + '</span>';
    };
    var c = o.counts || {};
    return '<div class="card ighead"><div class="igtop">' + avatarHTML(o, 'xl') + '<div class="igcounts">' +
      count(c.posts, c.posts === 1 ? 'post' : 'posts', o.self ? 'posts' : '') + count(c.friends, c.friends === 1 ? 'friend' : 'friends', o.self ? 'friends' : '') +
      count(c.workouts, c.workouts === 1 ? 'workout' : 'workouts', '') + '</div></div>' +
      '<div class="igname"><h2 class="pname">' + esc(o.name || '') + tickHTML(o.verified) + '</h2>' + (o.username ? '<p class="handle">@' + esc(o.username) + '</p>' : '') +
      (o.details && o.details.length ? '<p class="igbio">' + o.details.join(' \u00B7 ') + '</p>' : '') + (o.extra || '') + '</div>' +
      (o.actions ? '<div class="igacts">' + o.actions + '</div>' : '') + '</div>';
  }
  function bodyDetails(gender, age, kg) {
    var out = [];
    if (genderName(gender)) out.push(esc(genderName(gender)));
    if (+age > 0) out.push(esc(age));
    if (+kg > 0) out.push(fmtW(+kg) + ' ' + state.unit);
    return out;
  }
  function loadMyStats() {
    if (!state.username) return;
    soft(sb.rpc('profile_stats', { uname: state.username })).then(function (r) { ui.myStats = r.error ? false : r.data; softRender(); });
  }
  function nameParts(c) {
    if (c.first || c.last) return { first: c.first || '', last: c.last || '' };
    var n = String(c.name || '').trim(), i = n.indexOf(' ');
    return i < 0 ? { first: n, last: '' } : { first: n.slice(0, i), last: n.slice(i + 1) };
  }
  function nameFields(p, d) {
    return '<div class="frow"><div class="field"><label for="' + p + 'first">First name</label><input id="' + p + 'first" data-' + p.slice(0, 2) + '="first" autocomplete="given-name" maxlength="40" value="' + esc(d.first) + '"></div>' +
      '<div class="field"><label for="' + p + 'last">Last name</label><input id="' + p + 'last" data-' + p.slice(0, 2) + '="last" autocomplete="family-name" maxlength="40" value="' + esc(d.last) + '"></div></div>';
  }
  /* ---- profile photo (supabase/avatars.sql) ---- */
  function setAvatar(file) {
    if (!file || ui.avBusy) return;
    if (!/^image\//.test(file.type || '')) { ui.avErr = 'Choose a photo.'; render(); return; }
    ui.avBusy = true; ui.avErr = ''; render();
    var old = state.avatar, path = user.id + '/' + uid() + '.jpg', blob = null;
    shrinkImage(file, 512, true).then(function (b) {
      blob = b;
      return sb.storage.from('avatars').upload(path, b, { contentType: 'image/jpeg', upsert: false }).then(chk);
    }).then(function () {
      return sb.from('profiles').upsert({ user_id: user.id, avatar_path: path }, { onConflict: 'user_id' }).then(function (r) {
        if (r.error) { sb.storage.from('avatars').remove([path]); throw r.error; }
      });
    }).then(function () {
      if (old) sb.storage.from('avatars').remove([old]);
      state.avatar = path;
      signed['avatars|' + path] = { u: URL.createObjectURL(blob), t: Date.now() };
      ui.avBusy = false; resetPostLists();
      render();
    }, function (e) { ui.avBusy = false; ui.avErr = friendly(e); render(); });
  }
  function removeAvatar() {
    var old = state.avatar;
    if (!old || ui.avBusy) return;
    ui.avBusy = true; ui.avErr = ''; render();
    sb.from('profiles').upsert({ user_id: user.id, avatar_path: null }, { onConflict: 'user_id' }).then(function (r) {
      ui.avBusy = false;
      if (r.error) { ui.avErr = friendly(r.error); render(); return; }
      sb.storage.from('avatars').remove([old]);
      state.avatar = ''; resetPostLists();
      render();
    }, function (e) { ui.avBusy = false; ui.avErr = friendly(e); render(); });
  }
  function avatarControlsHTML() {
    if (!state.avatarsReady) return '';
    if (ui.avBusy) return '<div class="avctl"><span class="sub">Saving photo...</span></div>';
    return '<div class="avctl"><label class="linkbtn">' + (state.avatar ? 'Change photo' : 'Add profile photo') + '<input type="file" id="pfphoto" accept="image/*"></label>' +
      (state.avatar ? '<button type="button" class="linkbtn mute" data-a="pf-rmphoto">Remove photo</button>' : '') + '</div>' +
      (ui.avErr ? '<p class="err" role="alert">' + esc(ui.avErr) + '</p>' : '');
  }
  function profileCard() {
    var c = state.calc || {}, has = !!c.name;
    if (!ui.pf && !has) ui.pf = { first: '', last: '', uname: state.username, age: c.age ? String(c.age) : '', gender: c.gender || '', wt: state.bodyKg > 0 ? fmtW(bodyKg()) : '', err: '' };
    if (ui.pf) {
      var d = ui.pf;
      return '<div class="card"><h3>' + (has ? 'Edit profile' : 'Set up your profile') + '</h3>' +
        (has && state.avatarsReady ? '<div class="mehead" style="margin-bottom:12px">' + avatarHTML({ name: c.name, avatar: state.avatar }, true) + avatarControlsHTML() + '</div>' : '') +
        (state.unameReady ? unameField('pf-', d.uname) : '') + nameFields('pf-', d) +
        '<div class="frow" style="margin-top:12px"><div class="field"><label for="pf-age">Age</label><input id="pf-age" data-pf="age" inputmode="numeric" autocomplete="off" value="' + esc(d.age) + '"></div>' +
        '<div class="field"><label for="pf-gender">Gender</label><select id="pf-gender" data-pf="gender"><option value=""></option>' + genderOpts(d.gender) + '</select></div></div>' +
        '<div class="field" style="margin-top:12px"><label for="pf-wt">Weight (' + state.unit + ')</label><input id="pf-wt" data-pf="wt" inputmode="decimal" autocomplete="off" value="' + esc(d.wt) + '"></div>' +
        (d.err ? '<p class="err">' + esc(d.err) + '</p>' : '') +
        '<div class="benchbtns" style="margin-top:12px"><button type="button" class="primary" data-a="pf-save"' + (d.busy ? ' disabled' : '') + '>' + (d.busy ? 'Saving...' : 'Save') + '</button>' +
        (has ? '<button type="button" class="secondary" data-a="pf-cancel">Cancel</button>' : '') + '</div></div>';
    }
    var st = ui.myStats || {}, friends = (ui.fr.list || []).filter(function (x) { return x.relation === 'friends'; }).length;
    return profileHeadHTML({ self: true, name: c.name, username: state.username, verified: state.verified, avatar: state.avatar,
      details: bodyDetails(c.gender, c.age, state.bodyKg),
      counts: { posts: state.postsReady && state.username ? (st.posts !== undefined ? st.posts : ui.fr.lists.mine.items ? ui.fr.lists.mine.items.length : null) : null,
        friends: state.socialReady && state.username ? (st.friends !== undefined ? st.friends : friends) : null, workouts: state.workouts.length },
      extra: !state.username && state.unameReady ? '<button type="button" class="linkbtn" data-a="pf-edit">Choose a username</button>' : '',
      actions: '<button type="button" class="secondary small" data-a="pf-edit">Edit profile</button>' +
        '<button type="button" class="secondary small" data-a="fr-ppane" data-v="settings">Settings</button>' });
  }
  function profileAction(a) {
    var c = state.calc;
    if (a === 'pf-rmphoto') { removeAvatar(); return; }
    if (a === 'pf-edit') ui.pf = { first: nameParts(c).first, last: nameParts(c).last, uname: state.username, age: c.age ? String(c.age) : '', gender: c.gender || '', wt: state.bodyKg > 0 ? fmtW(state.bodyKg) : '', err: '' };
    else if (a === 'pf-cancel') ui.pf = null;
    else if (a === 'pf-save') {
      var d = ui.pf, r = readProfile(d.first, d.last, d.age, d.gender, d.wt, state.unit, 'pf-');
      if (d.busy) return;
      var un = state.unameReady ? readUsername(d.uname) : null;
      if (un && un.err) { d.err = un.err; ui.focus = '#pf-uname'; render(); return; }
      if (r.err) { d.err = r.err; ui.focus = '#' + r.id; render(); return; }
      var done = function () {
        c.name = r.name; c.first = r.first; c.last = r.last; c.age = r.age; c.gender = r.gender;
        if (r.gender !== 'o') c.sex = r.gender;
        state.bodyKg = r.kg;
        ui.pf = null; persist();
        render();
      };
      if (un && un.u !== state.username) {
        d.busy = true; d.err = ''; render();
        claimUsername(un.u).then(function (x) {
          d.busy = false;
          if (x.err) { d.err = x.err; ui.focus = '#pf-uname'; render(); return; }
          done();
        });
        return;
      }
      done();
      return;
    }
    render();
  }
  function settingsHTML() {
    return '<button type="button" class="backbtn" data-a="fr-ppane" data-v="posts">Profile</button><h2 class="pagetitle">Settings</h2>' +
      '<div class="card"><h3>Account</h3><div class="prow"><span>Email</span><span>' + esc((user && user.email) || '') + '</span></div>' +
      '<div class="prow"><span>Units</span>' + unitToggleHTML() + '</div></div>' +
      privacyHTML() +
      '<div class="dzone" style="margin-top:20px"><button type="button" class="linkbtn mute" data-a="auth-policy">Privacy Policy</button></div>' + footHTML();
  }
  function profileHTML() {
    if (ui.policy) return '<div class="card policy">' + policyPage('auth-policyback') + '</div>';
    if (ui.fr.view || ui.fr.viewLoading) return friendViewHTML();
    if (ui.pp === 'settings') return settingsHTML();
    var head = profileCard();
    if (ui.pf) return '<h2 class="pagetitle">Profile</h2>' + head;
    var h = '<h2 class="pagetitle">Profile</h2>' + head;
    if (!state.socialReady) return h + '<p class="sub" style="margin-top:16px">Find your recap, records and PR history in Plans \u2192 Insights.</p>';
    var n = incomingCount(), pane = ui.pp === 'friends' ? 'friends' : 'posts';
    h += segHTML('fr-ppane', { posts: 'Posts', friends: 'Friends' + (n ? ' (' + n + ')' : '') }, pane, 'Profile section').replace('unit seg3', 'unit seg3 subtabs');
    if (pane === 'friends') return h + friendsPaneHTML();
    return h + (socialGate() || postsListHTML('mine', '<div class="card"><h3>No posts yet</h3><p class="sub">Finish a workout or log a meal, then tap Share.</p></div>', true));
  }

  /* ---------- render ---------- */
  function render() {
    var signedIn = !!(user && state.loaded) && !auth.recovery;
    $('app').hidden = !signedIn;
    $('acct').hidden = !signedIn;
    $('auth').hidden = signedIn;
    if (!signedIn) { renderAuth(); return; }
    var nt = $('notice');
    if (nt) nt.innerHTML = noticeHTML();
    var showWk = !!state.active || !!(ui.summary && state.workouts.some(function (w) { return w.id === ui.summary; }));
    if (ui.tab === 'workout' && !showWk) ui.tab = 'plans';
    $('tab-workout').hidden = !showWk;
    document.querySelectorAll('[data-a="unit"]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit));
    });
    ['workout', 'plans', 'calendar', 'meals', 'feed', 'profile'].forEach(function (t) {
      var b = $('tab-' + t);
      b.setAttribute('aria-selected', String(ui.tab === t));
      b.setAttribute('aria-controls', 'panel');
      b.innerHTML = t.charAt(0).toUpperCase() + t.slice(1) + (t === 'workout' && state.active ? '<span class="live" title="Workout in progress"></span>' : '') +
        (t === 'profile' && incomingCount() ? '<span class="live dot" title="Friend requests"></span>' : '');
    });
    var sh = $('sheet');
    if (sh) { sh.innerHTML = ui.post ? postSheetHTML() : ui.viewPost ? postViewHTML() : ''; document.body.classList.toggle('noscroll', !!(ui.post || ui.viewPost)); }
    $('panel').innerHTML = ui.tab === 'workout' ? workoutHTML() : ui.tab === 'plans' ? plansHTML() : ui.tab === 'calendar' ? calendarHTML() : ui.tab === 'meals' ? mealsHTML() : ui.tab === 'feed' ? feedTabHTML() : profileHTML();
    var selTab = $('tab-' + ui.tab);
    if (selTab && selTab.parentNode && selTab.offsetWidth) {
      var nv = selTab.parentNode;
      if (selTab.offsetLeft < nv.scrollLeft || selTab.offsetLeft + selTab.offsetWidth > nv.scrollLeft + nv.clientWidth) nv.scrollLeft = Math.max(0, selTab.offsetLeft - 16);
    }
    if (ui.focus) {
      var el = $('panel').querySelector(ui.focus);
      if (el) el.focus();
      ui.focus = null;
    }
  }

  /* ---------- actions ---------- */
  function isCardioName(k) {
    return state.entries.some(function (e) { return e.cardio && key(e.ex) === k; }) ||
      state.plans.some(function (p) { return p.exercises.some(function (x) { return x.cardio && key(x.name) === k; }); });
  }
  function startWorkout(planId) {
    var plan = planId ? state.plans.filter(function (p) { return p.id === planId; })[0] : null;
    state.active = { id: uid(), start: Date.now(), date: today(), exercises: [], targets: {}, cardio: {}, plan: plan ? plan.name : null, planId: plan ? plan.id : null };
    ui.summary = null; ui.drafts = {}; ui.err = null; ui.newEx = ''; ui.newCardio = false; ui.benchAsk = null; ui.benchMsg = '';
    if (plan) {
      plan.exercises.forEach(function (x) {
        var k = key(x.name);
        if (state.active.exercises.some(function (n) { return key(n) === k; })) return;
        state.active.exercises.push(x.name);
        if (x.cardio) { state.active.cardio[k] = true; state.active.targets[k] = { sets: 1 }; }
        else state.active.targets[k] = { sets: planSlots(x).length, types: planSlots(x) };
        prefill(x.name);
      });
    }
    ui.tab = 'workout';
    persist();
    ui.focus = plan ? null : '#newex';
    render();
    window.scrollTo(0, 0);
  }
  function addExercise() {
    var name = ui.newEx.trim().replace(/\s+/g, ' ');
    if (!name) { ui.err = { i: -2, msg: '' }; $('newex').focus(); return; }
    var k = key(name);
    var known = state.entries.filter(function (e) { return key(e.ex) === k; })[0];
    if (known) name = known.ex;
    var idx = -1;
    state.active.exercises.forEach(function (n, i) { if (key(n) === k) idx = i; });
    if (idx === -1) {
      state.active.exercises.push(name);
      idx = state.active.exercises.length - 1;
      if (ui.newCardio || isCardioName(k)) state.active.cardio[k] = true;
      prefill(name);
    }
    ui.newEx = ''; ui.newCardio = false; ui.err = null;
    persist();
    ui.focus = state.active.cardio[k] ? '[data-dm="' + idx + '"]' : '[data-dw="' + idx + '"]';
    render();
  }
  function addSet(i) {
    var a = state.active;
    var name = a.exercises[i];
    var k = key(name);
    var d = getDraft(k);
    if (a.cardio && a.cardio[k]) {
      var m = Number(String(d.m).replace(',', '.'));
      if (!(m > 0 && m <= 1000)) { ui.err = { i: i, msg: 'Enter the minutes you did.' }; ui.focus = '[data-dm="' + i + '"]'; render(); return; }
      state.entries.push({ id: uid(), ex: name, kg: 0, reps: 0, mins: Math.round(m * 10) / 10, cardio: true, type: 'working', date: a.date, ts: Date.now(), wid: a.id });
      ui.err = null;
      persist();
      ui.focus = '[data-dm="' + i + '"]';
      render();
      return;
    }
    var w = parseFloat(String(d.w).replace(',', '.'));
    var rs = String(d.r).trim();
    var r = parseInt(rs, 10);
    if (!isFinite(w) || w < 0) { ui.err = { i: i, msg: 'Enter a weight of 0 or more in ' + state.unit + '.' }; ui.focus = '[data-dw="' + i + '"]'; render(); return; }
    if (!/^\d+$/.test(rs) || r < 1 || r > 100) { ui.err = { i: i, msg: 'Enter reps as a whole number from 1 to 100.' }; ui.focus = '[data-dr="' + i + '"]'; render(); return; }
    state.entries.push({ id: uid(), ex: name, kg: Math.round(toKg(w) * 10000) / 10000, reps: r, type: d.type || 'working', date: a.date, ts: Date.now(), wid: a.id });
    if (a.targets && a.targets[k]) d.manual = false;
    ui.err = null;
    persist();
    ui.focus = '[data-dr="' + i + '"]';
    render();
  }
  function finishWorkout() {
    var a = state.active;
    var n = state.entries.filter(function (e) { return e.wid === a.id; }).length;
    if (!n) { ui.err = { i: -1, msg: 'Log at least one set before finishing, or discard the workout.' }; render(); return; }
    state.workouts.push({ id: a.id, date: a.date, start: a.start, end: Date.now(), plan: a.plan || null, planId: a.planId || null });
    state.active = null;
    ui.summary = a.id; ui.drafts = {}; ui.err = null; ui.armed = null; ui.benchAsk = a.id; ui.benchMsg = '';
    persist();
    render();
    window.scrollTo(0, 0);
  }
  function benchAction(a) {
    var id = ui.summary;
    if (a === 'bench-yes' && id) {
      var w = state.workouts.filter(function (x) { return x.id === id; })[0];
      var sets = state.entries.filter(function (e) { return e.wid === id && e.type !== 'warmup'; }).sort(cmpEntries);
      groupByEx(sets).forEach(function (g) {
        state.bench[g.k] = {
          name: g.name, date: w ? w.date : today(),
          sets: g.sets.map(function (e) { return { kg: e.kg, reps: e.reps, mins: e.mins || 0, cardio: !!e.cardio, type: typeOf(e) }; })
        };
      });
      ui.benchMsg = 'Saved as your benchmark.';
    } else {
      ui.benchMsg = 'Benchmark left as it was.';
    }
    ui.benchAsk = null;
    persist();
    render();
  }
  function armThen(token, fn) {
    if (ui.armed === token) { ui.armed = null; fn(); return; }
    ui.armed = token;
    render();
    setTimeout(function () { if (ui.armed === token) { ui.armed = null; render(); } }, 3000);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-a]');
    if (!t) return;
    var a = t.dataset.a;
    if (a === 'unit') {
      if (t.dataset.unit === state.unit) return;
      var old = state.unit;
      Object.keys(ui.drafts).forEach(function (k) {
        var v = parseFloat(String(ui.drafts[k].w).replace(',', '.'));
        if (isFinite(v)) {
          var kg = old === 'kg' ? v : v / LB;
          state.unit = t.dataset.unit;
          ui.drafts[k].w = fmtW(kg);
          state.unit = old;
        }
      });
      state.unit = t.dataset.unit;
      persist(); render();
    } else if (a === 'tab') {
      ui.tab = t.dataset.tab; ui.err = null;
      ui.fr.view = null; ui.fr.viewLoading = false; ui.fr.viewU = null;
      if (state.socialReady && state.username && (ui.tab === 'feed' || ui.tab === 'profile')) {
        loadFriends();
        if (ui.tab === 'feed' && ui.fr.pane === 'board') loadBoard();
        if (state.postsReady && ui.tab === 'feed' && ui.fr.pane === 'feed') loadPosts('feed', false);
        if (state.postsReady && ui.tab === 'profile' && ui.pp === 'posts') loadPosts('mine', false);
        if (ui.tab === 'profile') { ui.pp = ui.pp === 'settings' ? 'posts' : ui.pp; loadMyStats(); }
      }
      render();
    } else if (a === 'start') startWorkout(t.dataset.plan);
    else if (a.indexOf('auth-') === 0) authAction(a, t);
    else if (a === 'pane') { ui[t.dataset.k] = t.dataset.v; render(); window.scrollTo(0, 0); }
    else if (a.indexOf('pf-') === 0) profileAction(a);
    else if (a.indexOf('fr-') === 0) friendsAction(a, t);
    else if (a.indexOf('post-') === 0) postAction(a, t);
    else if (a.indexOf('rc-') === 0) recapAction(a, t);
    else if (a.indexOf('tgt-') === 0) tgtAction(a, t);
    else if (a.indexOf('scan-') === 0) scanAction(a);
    else if (a.indexOf('calc-') === 0) calcAction(a, t);
    else if (a.indexOf('meal-') === 0) mealAction(a, t);
    else if (a.indexOf('cal-') === 0) calAction(a, t);
    else if (a.indexOf('plan-') === 0) planAction(a, t);
    else if (a === 'settype') { var sd = getDraft(key(state.active.exercises[+t.dataset.i])); sd.type = t.dataset.v; sd.manual = true; render(); }
    else if (a === 'newcardio') { ui.newCardio = t.checked; }
    else if (a.indexOf('bench-') === 0) benchAction(a);
    else if (a === 'addex') addExercise();
    else if (a === 'addset') addSet(+t.dataset.i);
    else if (a === 'finish') finishWorkout();
    else if (a === 'done') { ui.summary = null; render(); }
    else if (a === 'rmset') {
      state.entries = state.entries.filter(function (e) { return e.id !== t.dataset.id; });
      persist(); render();
    } else if (a === 'rmex') {
      state.active.exercises.splice(+t.dataset.i, 1);
      persist(); render();
    } else if (a === 'discard') {
      armThen('discard', function () {
        var id = state.active.id;
        state.entries = state.entries.filter(function (e) { return e.wid !== id; });
        state.active = null; ui.drafts = {}; ui.err = null;
        persist(); render();
      });
    } else if (a === 'sel') { ui.sel = t.dataset.key; render(); }
    else if (a === 'togglewk') { ui.open[t.dataset.id] = !ui.open[t.dataset.id]; ui.focus = '[data-a="togglewk"][data-id="' + t.dataset.id + '"]'; render(); }
    else if (a === 'morehist') { ui.histShown += 15; render(); }
    else if (a === 'delwk') {
      var id = t.dataset.id;
      armThen('wk:' + id, function () {
        state.entries = state.entries.filter(function (e) {
          return id.indexOf('d:') === 0 ? !(!e.wid && e.date === id.slice(2)) : e.wid !== id;
        });
        state.workouts = state.workouts.filter(function (w) { return w.id !== id; });
        persist(); render();
      });
    }
  });

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.dataset && t.dataset.au !== undefined) { auth[t.dataset.au] = t.value; return; }
    if (t.dataset && t.dataset.pf !== undefined && ui.pf) { ui.pf[t.dataset.pf] = t.value; return; }
    if (t.id === 'frq') { ui.fr.q = t.value; searchUsers(); return; }
    if (t.id === 'postcap' && ui.post) { ui.post.caption = t.value; return; }
    if (t.id === 'del-confirm') { ui.delText = t.value; var dg = $('del-go'); if (dg) dg.disabled = t.value.trim().toUpperCase() !== 'DELETE'; return; }
    if (t.dataset.mx !== undefined) { ui.mealDraft.d[t.dataset.mx] = t.value; return; }
    if (t.dataset.dm !== undefined && state.active) { getDraft(key(state.active.exercises[+t.dataset.dm])).m = t.value; return; }
    if (t.dataset.sg !== undefined && ui.scan) { ui.scan.grams = t.value; applyScan(); return; }
    if (t.dataset.cd !== undefined) { ui.calcDraft[t.dataset.cd] = t.value; return; }
    if (t.dataset.md !== undefined) { ui.mealDraft[t.dataset.md] = t.value; return; }
    if (t.id === 'newex') { ui.newEx = t.value; return; }
    if (t.id === 'pname' && ui.edit) { ui.edit.name = t.value; return; }
    if (t.dataset.pe !== undefined && ui.edit) { ui.edit.exercises[+t.dataset.pe][t.dataset.f] = t.value; return; }
    if (t.dataset.dw !== undefined && state.active) getDraft(key(state.active.exercises[+t.dataset.dw])).w = t.value;
    else if (t.dataset.dr !== undefined && state.active) getDraft(key(state.active.exercises[+t.dataset.dr])).r = t.value;
  });

  document.addEventListener('submit', function (ev) {
    if (ev.target && ev.target.id === 'authform') { ev.preventDefault(); authSubmit(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var t = ev.target;
    if (t.id === 'newex') { ev.preventDefault(); addExercise(); }
    else if (t.dataset && t.dataset.cd !== undefined) { ev.preventDefault(); calcAction('calc-run', t); }
    else if (t.dataset && t.dataset.md !== undefined) { ev.preventDefault(); mealEnter(t); }
    else if (t.dataset && t.dataset.dw !== undefined) { ev.preventDefault(); var r = document.querySelector('[data-dr="' + t.dataset.dw + '"]'); if (r) r.focus(); }
    else if (t.dataset && t.dataset.dr !== undefined) { ev.preventDefault(); addSet(+t.dataset.dr); }
    else if (t.dataset && t.dataset.dm !== undefined) { ev.preventDefault(); addSet(+t.dataset.dm); }
  });

  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.id === 'au-agree') { auth.agree = t.checked; return; }
    if (t.id === 'postfile') { pickPhoto(t.files && t.files[0]); return; }
    if (t.id === 'pfphoto') { setAvatar(t.files && t.files[0]); return; }
    if (t.id === 'bw' || t.id === 'tbw') {
      var bn = Number(String(t.value).trim().replace(',', '.'));
      state.bodyKg = isFinite(bn) && bn > 20 ? toKg(bn) : 0;
      persist(); render(); return;
    }
    if (t.dataset && t.dataset.sg !== undefined && ui.scan && ui.scanAll) { render(); return; }
    if (t.dataset && t.dataset.tg !== undefined) setTarget(t.dataset.tg, t.value);
  });

  setInterval(function () {
    var el = $('elapsed');
    if (el && state.active) el.textContent = fmtDur(Date.now() - state.active.start);
  }, 1000);

  /* ---------- start ---------- */
  render();
  initAuth();
})();
