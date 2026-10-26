// Loads app.js or sw.js into a sandbox with just enough of a browser around it for tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

function noop() {}

// app.js stops before starting the app when window.__LIFTS_TEST__ is set, and hands back its functions.
function loadApp() {
  const store = {};
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ style: {}, appendChild: noop }),
    body: { classList: { toggle: noop } }
  };
  const window = {
    __LIFTS_TEST__: {},
    addEventListener: noop,
    location: { origin: 'http://test', pathname: '/' },
    crypto: require('crypto').webcrypto
  };
  const context = {
    window, document,
    navigator: { userAgent: 'node', onLine: true },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    location: window.location,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    console, Promise, Date, Math, JSON, Intl
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), context, { filename: 'app.js' });
  return window.__LIFTS_TEST__.api;
}

// A fake service worker world: records the handlers sw.js registers, with in-memory caches and a switchable network.
function loadServiceWorker() {
  const handlers = {};
  const stores = new Map();
  const net = { online: true, requests: [] };
  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    const k = (req) => (typeof req === 'string' ? new URL(req, 'https://lifts.test/').href : req.url).split('?')[0];
    return {
      addAll: async (urls) => { for (const u of urls) m.set(k(u), { body: 'cached:' + k(u), ok: true }); },
      put: async (req, res) => { m.set(k(req), res); },
      match: async (req) => m.get(k(req)),
      keys: async () => [...m.keys()]
    };
  }
  const caches = {
    open: async (n) => cacheFor(n),
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
    match: async (req) => { for (const n of stores.keys()) { const r = await cacheFor(n).match(req); if (r) return r; } return undefined; }
  };
  const fetch = async (req) => {
    net.requests.push(req.url);
    if (!net.online) throw new TypeError('Failed to fetch');
    return { ok: true, type: 'basic', body: 'network:' + req.url, clone() { return this; } };
  };
  const self = {
    location: { origin: 'https://lifts.test' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  const context = { self, caches, fetch, URL, Response: { error: () => ({ error: true }) }, Promise, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });

  // Sends a fetch event through the worker. Returns the response, or 'passthrough' if the worker left it alone.
  async function request(url, mode) {
    let responded = null;
    handlers.fetch({ request: { url, method: 'GET', mode: mode || 'cors' }, respondWith: (p) => { responded = p; } });
    return responded ? await responded : 'passthrough';
  }
  async function install() {
    let p; handlers.install({ waitUntil: (x) => { p = x; } }); await p;
    handlers.activate({ waitUntil: (x) => { p = x; } }); await p;
  }
  return { handlers, caches, net, request, install, cacheFor };
}

module.exports = { loadApp, loadServiceWorker };
