import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { GuideSync, guideAccountKey } from '../web/guide-sync.js';
import { GUIDE_STORAGE_KEY } from '../web/guides.js';
import { GuideRemote } from '../web/cloud.js';

globalThis.crypto ??= webcrypto;
export const passed = [];
async function test(name, fn) { await fn(); passed.push(name); }
function disk(entries = []) {
  const data = new Map(entries);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function server() {
  const data = new Map();
  return { data, forUser: id => ({ read: async () => data.get(id) ?? null, write: async value => { data.set(id, value); } }) };
}
function device(backend, id = 'A', storage = disk()) {
  const sync = new GuideSync({ storage }); sync.openAccount(id, backend.forUser(id)); return sync;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

await test('한 기기의 캐릭터 선택을 다른 기기에서 불러온다', async () => {
  const backend = server(), a = device(backend), b = device(backend);
  a.select('rua'); await a.sync(); await b.sync();
  assert.equal(a.pendingCount, 0); assert.equal(b.selected, 'rua');
  b.select('lumi'); await b.sync(); await a.sync(); assert.equal(a.selected, 'lumi');
});
await test('계정의 선택은 오래된 기기의 기본값·기기 전용 선택보다 우선한다', async () => {
  const backend = server(); backend.data.set('A', 'rua');
  const a = device(backend, 'A', disk([[GUIDE_STORAGE_KEY, 'lumi']])); await a.sync();
  assert.equal(a.selected, 'rua'); assert.equal(backend.data.get('A'), 'rua');
});
await test('계정에 선택이 없을 때만 기존 기기 선택을 처음 가져온다', async () => {
  const backend = server(), storage = disk([[GUIDE_STORAGE_KEY, 'rua']]), a = device(backend, 'A', storage);
  await a.sync(); assert.equal(backend.data.get('A'), 'rua');
  backend.data.set('A', 'lumi'); await a.sync();
  assert.equal(a.selected, 'lumi'); assert.equal(storage.getItem(GUIDE_STORAGE_KEY), 'rua');
});
await test('선택하지 않은 기본값은 서버 설정을 자동으로 생성하지 않는다', async () => {
  const backend = server(), a = device(backend); await a.sync();
  assert.equal(a.selected, 'lumi'); assert.equal(backend.data.size, 0);
});
await test('게스트와 여러 계정의 선택 및 전송 대기를 분리한다', async () => {
  const backend = server(), storage = disk(), a = new GuideSync({ storage }); a.select('rua');
  a.openAccount('A', backend.forUser('A')); a.select('lumi');
  a.openAccount('B', backend.forUser('B')); a.select('rua'); await a.sync();
  assert.equal(backend.data.has('A'), false); assert.equal(backend.data.get('B'), 'rua');
  a.openAccount('A', backend.forUser('A')); assert.equal(a.selected, 'lumi'); assert.equal(a.pendingCount, 1);
  await a.sync(); a.openGuest(); assert.equal(a.selected, 'rua');
});
await test('오프라인의 선택은 재실행 후에도 남고 연결되면 전송된다', async () => {
  const backend = server(), storage = disk(), offline = backend.forUser('A');
  offline.read = async () => { throw new Error('offline'); };
  const a = new GuideSync({ storage }); a.openAccount('A', offline); a.select('rua');
  await assert.rejects(a.sync());
  const b = device(backend, 'A', storage);
  assert.equal(b.selected, 'rua'); assert.equal(b.pendingCount, 1);
  await b.sync(); assert.equal(b.pendingCount, 0); assert.equal(backend.data.get('A'), 'rua');
});
await test('전송 실패 시 선택과 대기 기록을 유지한다', async () => {
  const backend = server(), remote = backend.forUser('A'); remote.write = async () => { throw new Error('failed'); };
  const a = new GuideSync({ storage: disk() }); a.openAccount('A', remote); a.select('rua');
  await assert.rejects(a.sync()); assert.equal(a.selected, 'rua'); assert.equal(a.pendingCount, 1);
});
await test('서버 설정을 읽는 중 새로 선택해도 새 선택을 덮어쓰지 않는다', async () => {
  const backend = server(), remote = backend.forUser('A'), entered = deferred(), release = deferred();
  remote.read = async () => { entered.resolve(); await release.promise; return 'lumi'; };
  const a = new GuideSync({ storage: disk() }); a.openAccount('A', remote);
  const syncing = a.sync(); await entered.promise; a.select('rua'); release.resolve(); await syncing;
  assert.equal(a.selected, 'rua'); assert.equal(backend.data.get('A'), 'rua');
});
await test('전송 중 다시 고른 캐릭터는 이전 응답이 와도 계속 대기한다', async () => {
  const backend = server(), remote = backend.forUser('A'), entered = deferred(), release = deferred(), write = remote.write;
  remote.write = async value => { entered.resolve(); await release.promise; await write(value); };
  const a = new GuideSync({ storage: disk() }); a.openAccount('A', remote); a.select('rua');
  const syncing = a.sync(); await entered.promise; a.select('lumi'); release.resolve(); await syncing;
  assert.equal(a.selected, 'lumi'); assert.equal(a.pendingCount, 1);
  await a.sync(); assert.equal(backend.data.get('A'), 'lumi'); assert.equal(a.pendingCount, 0);
});
await test('계정 전환 뒤 도착한 이전 계정의 응답은 새 화면에 적용하지 않는다', async () => {
  const backend = server(), remote = backend.forUser('A'), entered = deferred(), release = deferred();
  remote.read = async () => { entered.resolve(); await release.promise; return 'rua'; };
  const storage = disk(), a = new GuideSync({ storage }); a.openAccount('A', remote);
  const syncing = a.sync(); await entered.promise; a.openAccount('B', backend.forUser('B')); a.select('lumi');
  release.resolve(); await syncing;
  assert.equal(a.selected, 'lumi'); assert.equal(a.pendingCount, 1); assert.equal(storage.getItem(guideAccountKey('A')), null);
});
await test('다른 탭이 선택한 새 캐릭터를 읽고 전송 응답에서 지우지 않는다', async () => {
  const backend = server(), storage = disk(), remote = backend.forUser('A'), entered = deferred(), release = deferred(), write = remote.write;
  remote.write = async value => { entered.resolve(); await release.promise; await write(value); };
  const a = new GuideSync({ storage }); a.openAccount('A', remote); a.select('rua');
  const b = device(backend, 'A', storage), syncing = a.sync(); await entered.promise;
  b.select('lumi'); release.resolve(); await syncing;
  assert.equal(a.selected, 'lumi'); assert.equal(a.pendingCount, 1);
  await b.sync(); assert.equal(backend.data.get('A'), 'lumi');
});
await test('서버에 알 수 없는 캐릭터가 있으면 덮어쓰지 않고 확인을 요청한다', async () => {
  const backend = server(); backend.data.set('A', 'unknown'); const a = device(backend);
  await assert.rejects(a.sync()); assert.equal(backend.data.get('A'), 'unknown');
});

const session = id => ({ user: { id }, access_token: `test-token-${id}` });
function remote(fetcher, getSession = async () => session('A')) {
  return new GuideRemote({ url: 'https://project.supabase.co', publishableKey: 'public-key', userId: 'A', getSession, fetcher });
}
const response = (user, ok = true) => ({ ok, json: async () => user });
await test('사용자 프로필에서 길잡이를 읽고 선택 외 인증 정보는 수정하지 않는다', async () => {
  const requests = [], r = remote(async (url, options) => {
    requests.push({ url, options });
    return response({ id: 'A', user_metadata: { quest_maker_guide: 'rua', other: 'preserved' } });
  });
  assert.equal(await r.read(), 'rua'); await r.write('rua');
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].url, 'https://project.supabase.co/auth/v1/user');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-token-A');
  assert.deepEqual(JSON.parse(requests[1].options.body), { data: { quest_maker_guide: 'rua' } });
  assert.equal(requests[0].options.cache, 'no-store');
});
await test('사용자 프로필에 선택이 없으면 빈 계정 설정으로 읽는다', async () => {
  assert.equal(await remote(async () => response({ id: 'A', user_metadata: {} })).read(), null);
});
await test('다른 계정으로 세션이 바뀌면 요청을 전송하지 않는다', async () => {
  let calls = 0; const r = remote(async () => { calls++; }, async () => session('B'));
  await assert.rejects(r.read()); await assert.rejects(r.write('rua')); assert.equal(calls, 0);
});
await test('요청을 보낸 뒤 세션이 바뀌어도 다른 계정의 토큰으로 전송되지 않는다', async () => {
  let current = session('A'), usedToken;
  const r = remote(async (_url, options) => {
    current = session('B'); usedToken = options.headers.Authorization;
    return response({ id: 'A', user_metadata: { quest_maker_guide: 'rua' } });
  }, async () => current);
  await r.write('rua'); assert.equal(usedToken, 'Bearer test-token-A');
});
await test('실패 응답·다른 소유자·저장 누락은 정상 동기화로 처리하지 않는다', async () => {
  await assert.rejects(remote(async () => response({}, false)).read());
  await assert.rejects(remote(async () => response({ id: 'B' })).read());
  await assert.rejects(remote(async () => response({ id: 'A', user_metadata: {} })).write('rua'));
});

console.log(`${passed.length} account guide sync behavior tests passed.`);
