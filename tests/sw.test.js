// Tests for the offline worker (sw.js). Run with: npm test   (or: node --test "tests/*.test.js")
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServiceWorker } = require('./load');

test('installing stores the app so it can open offline', async () => {
  const sw = loadServiceWorker();
  await sw.install();
  const cached = await (await sw.caches.open('lifts-v1')).keys();
  for (const f of ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest']) {
    assert.ok(cached.some((u) => u.endsWith('/' + f)), f + ' is stored');
  }
});

test('online: app files come fresh from the network', async () => {
  const sw = loadServiceWorker();
  await sw.install();
  const res = await sw.request('https://lifts.test/app.js');
  assert.equal(res.body, 'network:https://lifts.test/app.js', 'so updates show straight away');
});

test('offline: app files come from the stored copy', async () => {
  const sw = loadServiceWorker();
  await sw.install();
  sw.net.online = false;
  const res = await sw.request('https://lifts.test/styles.css');
  assert.match(res.body, /^cached:/);
});

test('offline: opening the app at any address shows the stored page', async () => {
  const sw = loadServiceWorker();
  await sw.install();
  sw.net.online = false;
  const res = await sw.request('https://lifts.test/some/link?x=1', 'navigate');
  assert.equal(res.body, 'cached:https://lifts.test/index.html');
});

test('your data, sign-in and photos are never cached by the worker', async () => {
  const sw = loadServiceWorker();
  await sw.install();
  for (const url of ['https://opmkdaqsvjsvonrxjlpp.supabase.co/rest/v1/meals', 'https://opmkdaqsvjsvonrxjlpp.supabase.co/auth/v1/token',
    'https://opmkdaqsvjsvonrxjlpp.supabase.co/storage/v1/object/sign/posts/a.jpg']) {
    assert.equal(await sw.request(url), 'passthrough', url);
  }
});

test('the pinned library is fetched once, then served from the cache', async () => {
  const sw = loadServiceWorker();
  await sw.install();
  const url = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
  await sw.request(url);
  await new Promise((r) => setTimeout(r, 0));
  sw.net.online = false;
  const res = await sw.request(url);
  assert.equal(res.body, 'network:' + url, 'still available offline');
  assert.equal(sw.net.requests.filter((u) => u === url).length, 1, 'only downloaded once');
});
