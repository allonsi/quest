import assert from 'node:assert/strict';
import { Blob, Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { makeQuest, uid, validateQuests, startQuest, toggleGoal, claimReward, canClaim } from '../web/domain.js';
import { JournalSync } from '../web/sync.js';
import { createAuthActions, validateCloudConfig, QuestRemote } from '../web/cloud.js';
import { recordOccurrence, recurrenceCounts } from '../web/recurrence.js';

globalThis.Blob ??= Blob;
globalThis.crypto ??= webcrypto;
globalThis.TextEncoder ??= TextEncoder;
globalThis.atob ??= value => Buffer.from(value, 'base64').toString('binary');
export const passed = [];
const clone = value => structuredClone(value);
async function test(name, fn) { await fn(); passed.push(name); }
const quest = title => makeQuest({ title, reward: '휴식', tasks: [{ id: uid(), title: '할 일', kind: 'free', done: false }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function disk() {
  let guest;
  const accounts = new Map();
  return {
    loadGuest: async () => clone(guest), saveGuest: async value => { guest = clone(value); },
    loadAccount: async key => clone(accounts.get(key)),
    saveAccount: async (key, value, expected) => {
      assert.equal(accounts.get(key)?.revision || 0, expected);
      accounts.set(key, clone(value));
    }
  };
}

function server() {
  const rows = new Map();
  return {
    rows,
    forUser(user) {
      return {
        prepare: async q => ({ data: clone(q), photoPath: null }),
        async push(id, job, prepared) {
          const key = `${user}:${id}`, old = rows.get(key);
          if (old?.mutation_id === job.token) return { ok: true, record: clone(old) };
          if ((old?.version || 0) !== job.base) return { ok: false, record: clone(old || null) };
          const row = { user_id: user, id, data: job.quest ? clone(prepared.data) : null, photo_path: prepared.photoPath,
            version: (old?.version || 0) + 1, mutation_id: job.token, deleted: job.quest === null };
          rows.set(key, row); return { ok: true, record: clone(row) };
        },
        list: async () => clone([...rows.values()].filter(row => row.user_id === user)),
        restore: async row => { assert.equal(row.user_id, user); return validateQuests([clone(row.data)])[0]; },
        cleanup: async () => {}
      };
    }
  };
}
async function device(remote, local = disk(), scope = 'A') {
  const journal = new JournalSync({ disk: local }); await journal.openAccount(scope, remote); return journal;
}

await test('첫 로그인은 기기 기록을 자동 업로드하지 않는다', async () => {
  const local = disk(), backend = server(), a = new JournalSync({ disk: local });
  await a.openGuest(() => [quest('기기 기록')]); await a.openAccount('A', backend.forUser('A')); await a.sync();
  assert.equal(a.quests.length, 0); assert.equal(backend.rows.size, 0); assert.equal((await local.loadGuest())[0].title, '기기 기록');
});
await test('새 퀘스트를 다른 기기에서 불러온다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  await a.save([quest('기기 간 기록')]); await a.sync(); await b.sync();
  assert.equal(b.quests[0].title, '기기 간 기록'); assert.equal(a.pendingCount, 0);
});
await test('반복 요일과 성공·실패 수정·취소가 다른 기기와 재실행에 보존된다', async () => {
  const s = server(), local = disk(), a = await device(s.forUser('A'), local), b = await device(s.forUser('A'));
  const now = new Date(2026, 10, 2, 12);
  const q = startQuest(makeQuest({ title: '반복 산책', reward: '차', createdAt: new Date(2026, 9, 25, 12).toISOString(), recurrence: { days: [1, 3], history: [] } }));
  await a.save([recordOccurrence(q, '2026-11-02', 'success', now)]); await a.sync(); await b.sync();
  assert.equal(b.quests[0].recurrence.days.join(','), '1,3');
  assert.deepEqual(recurrenceCounts(b.quests[0]), { success: 1, failure: 0 });
  await b.mutate(qs => { qs[0] = recordOccurrence(qs[0], '2026-11-02', 'failure', now); });
  await b.sync(); await a.sync();
  assert.deepEqual(recurrenceCounts(a.quests[0]), { success: 0, failure: 1 });
  const reopened = await device(s.forUser('A'), local);
  assert.equal(reopened.quests[0].status, 'recurring'); assert.deepEqual(recurrenceCounts(reopened.quests[0]), { success: 0, failure: 1 });
  await a.mutate(qs => { qs[0] = recordOccurrence(qs[0], '2026-11-02', null, now); });
  await a.sync(); await b.sync(); assert.equal(b.quests[0].recurrence.history.length, 0);
});
await test('중요·긴급을 함께 동기화하고 하나를 해제해도 다른 표시를 유지한다', async () => {
  const s = server(), local = disk(), a = await device(s.forUser('A'), local), b = await device(s.forUser('A'));
  await a.save([makeQuest({ title: '중요하고 긴급한 일', important: true, urgent: true })]);
  await a.sync(); await b.sync();
  assert.equal(b.quests[0].important, true); assert.equal(b.quests[0].urgent, true);
  await b.mutate(qs => { qs[0].important = false; });
  await b.sync(); await a.sync();
  assert.equal(a.quests[0].important, false); assert.equal(a.quests[0].urgent, true);
  const reopened = await device(s.forUser('A'), local);
  assert.equal(reopened.quests[0].important, false); assert.equal(reopened.quests[0].urgent, true);
});
await test('이전 서버 기록에 중요·긴급 정보가 없어도 불러올 수 있다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  const old = quest('예전 기록'); delete old.important; delete old.urgent;
  await a.save([old]); await a.sync(); await b.sync();
  assert.equal(b.quests[0].title, '예전 기록');
  assert.equal(b.quests[0].important, false); assert.equal(b.quests[0].urgent, false);
});
await test('단계 없는 퀘스트의 완료 체크와 보상 기록이 다른 기기에 보존된다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  await a.save([startQuest(makeQuest({ title: '산책하기', reward: '따뜻한 차' }))]);
  await a.sync(); await b.sync();
  assert.equal(b.quests[0].tasks.length, 0); assert.equal(canClaim(b.quests[0]), false);
  await b.mutate(qs => { qs[0] = toggleGoal(qs[0]); });
  await b.sync(); await a.sync();
  assert.equal(a.quests[0].goalDone, true); assert.equal(canClaim(a.quests[0]), true);
  await a.mutate(qs => { qs[0] = claimReward(qs[0], '차를 마시며 쉬었다'); });
  await a.sync(); await b.sync();
  assert.equal(b.quests[0].status, 'completed'); assert.equal(b.quests[0].goalDone, true);
  assert.equal(b.quests[0].rewardRecord.note, '차를 마시며 쉬었다');
});
await test('다른 기기에서 받은 빈 단계 초안을 시작하면 빈 항목이 동기화 기록에서도 제외된다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  const draft = makeQuest({ title: '산책하기', reward: '따뜻한 차', tasks: [
    { id: uid(), title: '', kind: 'free', done: false },
    { id: uid(), title: '  ', kind: 'chain', done: false }
  ] });
  await a.save([draft]); await a.sync(); await b.sync();
  assert.equal(b.quests[0].tasks.length, 2);
  await b.mutate(qs => { qs[0] = startQuest(qs[0]); });
  await b.sync(); await a.sync();
  assert.equal(a.quests[0].status, 'active'); assert.equal(a.quests[0].tasks.length, 0);
  assert.equal(canClaim(a.quests[0]), false);
});
await test('서로 다른 퀘스트 수정은 덮어쓰기 없이 합쳐진다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  await a.save([quest('첫째'), quest('둘째')]); await a.sync(); await b.sync();
  const [first, second] = a.quests.map(q => q.id);
  await a.mutate(qs => { qs.find(q => q.id === first).title = '첫째 수정'; });
  await b.mutate(qs => { qs.find(q => q.id === second).title = '둘째 수정'; });
  await a.sync(); await b.sync(); await a.sync();
  assert.equal(a.quests.map(q => q.title).sort().join('|'), '둘째 수정|첫째 수정');
});
await test('같은 퀘스트 동시 수정은 양쪽 내용을 모두 보관한다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  const conflicts = []; b.onConflict = info => conflicts.push(info);
  await a.save([quest('원본')]); await a.sync(); await b.sync();
  await a.mutate(qs => { qs[0].title = 'Mac 수정'; }); await b.mutate(qs => { qs[0].title = '휴대폰 수정'; });
  await a.sync(); await b.sync(); await b.sync(); await a.sync();
  assert.equal(a.quests.length, 2); assert.ok(a.quests.some(q => q.title === 'Mac 수정'));
  assert.ok(a.quests.some(q => q.title.includes('휴대폰 수정') && q.title.includes('수정본')));
  assert.equal(conflicts[0].copied, true); assert.equal(b.pendingCount, 0);
});
await test('삭제한 퀘스트는 다른 기기에서도 제거된다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  await a.save([quest('삭제 대상')]); await a.sync(); await b.sync(); await a.save([]); await a.sync(); await b.sync();
  assert.equal(b.quests.length, 0); assert.equal([...s.rows.values()][0].data, null); assert.equal([...s.rows.values()][0].deleted, true);
});
await test('삭제된 퀘스트의 오프라인 수정은 새 ID로 보존된다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A')), q = quest('원본');
  await a.save([q]); await a.sync(); await b.sync(); await a.save([]); await a.sync();
  await b.mutate(qs => { qs[0].title = '오프라인 수정'; }); await b.sync(); await b.sync();
  assert.equal(b.quests.length, 1); assert.notEqual(b.quests[0].id, q.id); assert.equal(s.rows.get(`A:${q.id}`).deleted, true);
});
await test('오래된 삭제 요청은 서버의 최신 수정을 삭제하지 않는다', async () => {
  const s = server(), a = await device(s.forUser('A')), b = await device(s.forUser('A'));
  let conflict; b.onConflict = info => { conflict = info; };
  await a.save([quest('원본')]); await a.sync(); await b.sync(); await b.save([]);
  await a.mutate(qs => { qs[0].title = '최신 기록'; }); await a.sync(); await b.sync();
  assert.equal(b.quests[0].title, '최신 기록'); assert.equal(b.pendingCount, 0); assert.equal(conflict.copied, false);
});
await test('응답이 끊긴 저장을 재전송해도 중복 생성하지 않는다', async () => {
  const s = server(), remote = s.forUser('A'), push = remote.push; let fail = true;
  remote.push = async (...args) => { const result = await push(...args); if (fail) { fail = false; throw new Error('응답 끊김'); } return result; };
  const a = await device(remote); await a.save([quest('한 번만 저장')]); await assert.rejects(a.sync());
  assert.equal(a.pendingCount, 1); await a.sync(); assert.equal(a.pendingCount, 0); assert.equal(s.rows.size, 1); assert.equal(a.quests.length, 1);
});
await test('전송 도중 추가 수정도 다음 버전으로 저장된다', async () => {
  const s = server(), remote = s.forUser('A'), push = remote.push, entered = deferred(), release = deferred(); let wait = true;
  remote.push = async (...args) => { if (wait) { wait = false; entered.resolve(); await release.promise; } return push(...args); };
  const a = await device(remote); await a.save([quest('첫 수정')]); const syncing = a.sync(); await entered.promise;
  await a.mutate(qs => { qs[0].title = '추가 수정'; }); release.resolve(); await syncing; assert.equal(a.pendingCount, 1);
  await a.sync(); assert.equal(a.pendingCount, 0); assert.equal([...s.rows.values()][0].data.title, '추가 수정');
});
await test('오프라인 대기는 앱 재실행 후에도 유지된다', async () => {
  const s = server(), local = disk(), offline = s.forUser('A'); offline.prepare = async () => { throw new Error('오프라인'); };
  const a = await device(offline, local); await a.save([quest('대기 기록')]); await assert.rejects(a.sync());
  const b = await device(s.forUser('A'), local); assert.equal(b.pendingCount, 1); await b.sync(); assert.equal(b.pendingCount, 0);
});
await test('계정별 대기 기록과 로그인 전 일지가 섞이지 않는다', async () => {
  const s = server(), local = disk(), a = new JournalSync({ disk: local });
  await a.openGuest(() => [quest('기기 일지')]); await a.openAccount('A', s.forUser('A')); await a.save([quest('A 기록')]);
  await a.openAccount('B', s.forUser('B')); assert.equal(a.quests.length, 0); await a.sync();
  await a.openAccount('A', s.forUser('A')); assert.equal(a.pendingCount, 1); await a.sync();
  await a.openGuest(() => []); assert.equal(a.quests[0].title, '기기 일지'); assert.ok([...s.rows.values()].every(row => row.user_id === 'A'));
});
await test('전송 도중 계정이 바뀌어도 새 계정에 이전 기록을 표시하지 않는다', async () => {
  const s = server(), remote = s.forUser('A'), push = remote.push, entered = deferred(), release = deferred();
  remote.push = async (...args) => { entered.resolve(); await release.promise; return push(...args); };
  const a = await device(remote); await a.save([quest('A의 기록')]); const syncing = a.sync(); await entered.promise;
  await a.openAccount('B', s.forUser('B')); release.resolve(); await syncing;
  assert.equal(a.quests.length, 0); assert.equal(a.scope, 'B'); assert.equal(a.pendingCount, 0);
});
await test('백업의 특수한 ID도 메타 객체의 프로토타입을 변경하지 않는다', async () => {
  const s = server(), a = await device(s.forUser('A')), q = { ...quest('특수 ID'), id: '__proto__' };
  await a.save([q]); assert.equal(a.pendingCount, 1); await a.sync(); assert.equal(a.pendingCount, 0); assert.equal(a.quests[0].id, '__proto__');
});
await test('관리자 비밀 키는 브라우저 연결 설정에서 거부한다', () => {
  const url = 'https://example.supabase.co'; assert.equal(validateCloudConfig({ url: '', publishableKey: '' }), false);
  assert.equal(validateCloudConfig({ url, publishableKey: 'sb_publishable_example' }), true);
  assert.throws(() => validateCloudConfig({ url, publishableKey: 'sb_secret_example' }));
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  assert.throws(() => validateCloudConfig({ url, publishableKey: `x.${payload}.x` }));
});
await test('다른 계정의 서버 기록 복원은 거부한다', async () => {
  await assert.rejects(new QuestRemote({}, 'A').restore({ user_id: 'B', id: 'q', data: {} }, null));
});
await test('이메일 로그인은 공백만 정리하고 비밀번호를 그대로 전달한다', async () => {
  let received;
  const actions = createAuthActions({ auth: { signInWithPassword: async value => { received = value; return { data: { session: { user: { id: 'A' } } } }; } } });
  const result = await actions.signIn(' me@example.com ', ' password with spaces ');
  assert.equal(received.email, 'me@example.com'); assert.equal(received.password, ' password with spaces '); assert.equal(result.session.user.id, 'A');
});
await test('이메일 가입은 즉시 로그인과 확인 메일 필요 응답을 모두 처리한다', async () => {
  let verified = false;
  const actions = createAuthActions({ auth: { signUp: async () => ({ data: { session: verified ? { user: { id: 'A' } } : null, user: { id: 'A' } } }) } });
  assert.equal((await actions.signUp('me@example.com', 'test password')).session, null);
  verified = true; assert.equal((await actions.signUp('me@example.com', 'test password')).session.user.id, 'A');
});
await test('잘못된 비밀번호는 사용자가 이해할 수 있는 오류로 반환한다', async () => {
  const actions = createAuthActions({ auth: { signInWithPassword: async () => ({ error: { code: 'invalid_credentials', message: 'raw internal error' } }) } });
  await assert.rejects(actions.signIn('me@example.com', 'wrong'), /이메일 또는 비밀번호/);
});
await test('로그아웃은 현재 기기의 세션만 종료한다', async () => {
  let scope;
  const actions = createAuthActions({ auth: { signOut: async options => { scope = options.scope; return {}; } } });
  await actions.signOut(); assert.equal(scope, 'local');
});

await test('보상 사진은 비공개 경로에 업로드하고 DB에는 사진 메타데이터만 보낸다', async () => {
  const objects = new Map(); let uploads = 0, downloads = 0;
  const bucket = {
    exists: async path => ({ data: objects.has(path) }),
    upload: async (path, blob, options) => { assert.equal(options.upsert, false); objects.set(path, blob); uploads++; return {}; },
    download: async path => { downloads++; return { data: objects.get(path) }; }
  };
  const remote = new QuestRemote({ storage: { from: name => { assert.equal(name, 'quest-rewards'); return bucket; } } }, 'A');
  const q = quest('사진 보상'); q.status = 'completed'; q.tasks[0].done = true;
  q.rewardRecord = { note: '잘했어요', photo: { name: 'reward.jpg', blob: new Blob(['photo bytes'], { type: 'image/jpeg' }) }, claimedAt: new Date().toISOString() };
  const token = uid(), prepared = await remote.prepare(q, token);
  assert.match(prepared.photoPath, /^A\/[a-f0-9]{64}\/[a-f0-9]{64}\.jpg$/);
  assert.equal(prepared.data.rewardRecord.photo.blob, undefined);
  await remote.prepare(q, token); assert.equal(uploads, 1);
  const record = { id: q.id, user_id: 'A', data: prepared.data, photo_path: prepared.photoPath };
  const restored = await remote.restore(record, null);
  assert.equal(await restored.rewardRecord.photo.blob.text(), 'photo bytes'); assert.equal(downloads, 1);
  await remote.restore(record, { meta: { photoPath: prepared.photoPath }, quest: restored }); assert.equal(downloads, 1);
  const another = await remote.prepare(q, uid()); assert.notEqual(another.photoPath, prepared.photoPath);
});

await test('사진 정리는 현재 사용 중인 사진과 다른 계정 경로를 삭제하지 않는다', async () => {
  let referenced = true, removed = 0;
  const query = { select() { return this; }, eq() { return this; }, async limit() { return { data: referenced ? [{ id: 'q' }] : [] }; } };
  const remote = new QuestRemote({ from: () => query, storage: { from: () => ({ remove: async () => { removed++; return {}; } }) } }, 'A');
  await remote.cleanup('A/photo.jpg'); assert.equal(removed, 0);
  referenced = false; await remote.cleanup('B/photo.jpg'); assert.equal(removed, 0);
  await remote.cleanup('A/photo.jpg'); assert.equal(removed, 1);
});

console.log(`${passed.length} sync and authentication tests passed.`);
