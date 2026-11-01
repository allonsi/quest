import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';

const source = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://quest.example';
export const passed = [];
const body = text => ({ ok: true, clone: () => body(text), text: async () => text });
const key = request => typeof request === 'string' ? request : request.url;

function worker(network) {
  const handlers = new Map(), saved = new Map(), calls = [];
  const cache = {
    match: async request => saved.get(key(request)),
    put: async (request, response) => { saved.set(key(request), response); }
  };
  runInNewContext(source, {
    URL,
    self: { location: { origin: ORIGIN, href: `${ORIGIN}/web/sw.js` }, addEventListener: (type, handler) => handlers.set(type, handler) },
    caches: { open: async () => cache },
    fetch: async (request, options) => { calls.push({ request, options }); return network(request); }
  });
  return {
    saved, calls,
    async request(path, options = {}) {
      let reply;
      const request = { url: new URL(path, `${ORIGIN}/web/`).href, method: 'GET', mode: 'cors', ...options };
      handlers.get('fetch')({ request, respondWith: promise => { reply = promise; } });
      return reply ? await reply : null;
    }
  };
}

async function test(name, fn) { await fn(); passed.push(name); }

await test('온라인에서는 이전 앱 캐시 대신 최신 스크립트를 반환하고 캐시를 갱신한다', async () => {
  const sw = worker(async () => body('new app'));
  sw.saved.set(`${ORIGIN}/web/app.js?v=15`, body('old app'));
  const response = await sw.request('app.js?v=15');
  assert.equal(await response.text(), 'new app');
  assert.equal(await sw.saved.get(`${ORIGIN}/web/app.js?v=15`).text(), 'new app');
  assert.equal(sw.calls[0].options.cache, 'no-cache');
});
await test('오프라인에서는 저장된 앱 파일을 사용한다', async () => {
  const sw = worker(async () => { throw new Error('offline'); });
  sw.saved.set(`${ORIGIN}/web/styles.css?v=15`, body('saved styles'));
  assert.equal(await (await sw.request('styles.css?v=15')).text(), 'saved styles');
});
await test('오프라인 앱 방문은 저장된 index.html로 연다', async () => {
  const sw = worker(async () => { throw new Error('offline'); });
  sw.saved.set(`${ORIGIN}/web/index.html`, body('saved journal'));
  assert.equal(await (await sw.request('./', { mode: 'navigate' })).text(), 'saved journal');
});
await test('인증 서버 요청과 POST 요청은 앱 캐시에 넣지 않는다', async () => {
  const sw = worker(async () => body('network'));
  assert.equal(await sw.request('https://project.supabase.co/rest/v1/quest_records'), null);
  assert.equal(await sw.request('app.js?v=15', { method: 'POST' }), null);
  assert.equal(sw.calls.length, 0); assert.equal(sw.saved.size, 0);
});
await test('캐릭터 파일을 직접 열어도 앱의 index.html 캐시를 덮어쓰지 않는다', async () => {
  const sw = worker(async () => body('image'));
  sw.saved.set(`${ORIGIN}/web/index.html`, body('journal'));
  assert.equal(await (await sw.request('assets/guide.png', { mode: 'navigate' })).text(), 'image');
  assert.equal(await sw.saved.get(`${ORIGIN}/web/index.html`).text(), 'journal');
});

console.log(`${passed.length} service worker behavior tests passed.`);
