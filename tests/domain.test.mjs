import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { makeQuest, progress, isUnlocked, toggleTask, startQuest, canClaim, claimReward, normalizeTasks, validateQuests, exampleQuests } from '../web/domain.js';

// Also runs in JavaScript verification environments that omit the optional web globals.
globalThis.Blob ??= Blob;

export const passed = [];
const test = (name, fn) => { fn(); passed.push(name); };
const task = (id, kind = 'chain', done = false) => ({ id, title: id, kind, done });
const quest = tasks => makeQuest({ title: '나의 모험', reward: '달콤한 휴식', status: 'active', tasks });

test('순서 없는 하위 퀘스트는 미완료 연계 퀘스트 뒤에서도 체크할 수 있다', () => {
  const q = quest([task('먼저'), task('언제든', 'free')]);
  assert.equal(isUnlocked(q, '언제든'), true);
  assert.equal(toggleTask(q, '언제든').tasks[1].done, true);
});
test('첫 번째 연계 단계는 미완료 하위 퀘스트의 영향을 받지 않는다', () => {
  assert.equal(isUnlocked(quest([task('하위', 'free'), task('첫 연계')]), '첫 연계'), true);
});
test('앞선 연계 단계가 미완료이면 다음 연계 단계는 잠긴다', () => {
  const q = quest([task('첫 단계'), task('다음 단계')]);
  assert.equal(isUnlocked(q, '다음 단계'), false);
  assert.throws(() => toggleTask(q, '다음 단계'));
});
test('앞 단계를 완료하면 다음 연계 단계가 열린다', () => {
  const q = toggleTask(quest([task('첫 단계'), task('다음 단계')]), '첫 단계');
  assert.equal(isUnlocked(q, '다음 단계'), true);
});
test('앞 단계 체크 해제는 뒤 연계만 해제하고 하위 단계는 유지한다', () => {
  const q = toggleTask(quest([task('첫', 'chain', true), task('자유', 'free', true), task('둘', 'chain', true), task('셋', 'chain', true)]), '첫');
  assert.deepEqual(q.tasks.map(t => t.done), [false, true, false, false]);
});
test('중간 연계 해제 시 앞선 완료 상태는 유지한다', () => {
  const q = toggleTask(quest([task('첫', 'chain', true), task('둘', 'chain', true), task('셋', 'chain', true)]), '둘');
  assert.deepEqual(q.tasks.map(t => t.done), [true, false, false]);
});
test('상태 변경은 입력 객체를 수정하지 않는다', () => {
  const q = quest([task('첫')]); toggleTask(q, '첫');
  assert.equal(q.tasks[0].done, false);
});
test('빈 퀘스트는 0%이며 보상을 받을 수 없다', () => {
  const q = quest([]);
  assert.deepEqual(progress(q), { total: 0, done: 0, percent: 0 });
  assert.equal(canClaim(q), false);
});
test('진행률 100%도 보상 기록 전에는 진행 중이다', () => {
  const q = quest([task('마침', 'free', true)]);
  assert.equal(progress(q).percent, 100); assert.equal(canClaim(q), true); assert.equal(q.status, 'active');
});
test('미완료 퀘스트의 보상과 빈 보상 기록은 허용하지 않는다', () => {
  assert.throws(() => claimReward(quest([task('아직')]), '기록'));
  assert.throws(() => claimReward(quest([task('완료', 'free', true)]), '  '));
});
test('글 보상 기록을 남기면 완료됨으로 이동한다', () => {
  const q = claimReward(quest([task('완료', 'free', true)]), '  잘했어, 나!  ');
  assert.equal(q.status, 'completed'); assert.equal(q.rewardRecord.note, '잘했어, 나!');
  assert.throws(() => toggleTask(q, '완료'));
});
test('사진만으로도 보상 완료 기록을 남길 수 있다', () => {
  const photo = { blob: new Blob(['test'], { type: 'image/jpeg' }), name: 'reward.jpg' };
  const q = claimReward(quest([task('완료', 'free', true)]), '', photo);
  assert.equal(validateQuests([q])[0].status, 'completed');
});
test('작성 중인 퀘스트는 체크할 수 없다', () => {
  assert.throws(() => toggleTask(makeQuest({ tasks: [task('작성 중')] }), '작성 중'));
});
test('이름, 발걸음, 보상 없이 모험을 시작할 수 없다', () => {
  assert.throws(() => startQuest(makeQuest()));
  assert.throws(() => startQuest(makeQuest({ title: '제목', reward: '보상' })));
  assert.throws(() => startQuest(makeQuest({ title: '제목', tasks: [task('할 일')] })));
  assert.throws(() => startQuest(makeQuest({ title: '제목', reward: '보상', tasks: [{ ...task('할 일'), title: '  ' }] })));
});
test('시작 시 공백을 정리하고 편집 후 연계 순서를 바로잡는다', () => {
  const q = startQuest(makeQuest({ title: ' 모험 ', reward: ' 쉼 ', tasks: [task('첫'), task('둘', 'chain', true)] }));
  assert.equal(q.title, '모험'); assert.equal(q.reward, '쉼'); assert.equal(q.status, 'active');
  assert.deepEqual(q.tasks.map(t => t.done), [false, false]);
  assert.equal(normalizeTasks([task('자유', 'free', true)])[0].done, true);
});
test('예시 데이터와 사진이 있는 완료 기록은 유효하다', () => {
  assert.equal(validateQuests(exampleQuests()).length, 5);
});
test('중복 ID, 잘못된 연계 순서와 보상 없는 완료 백업은 거부한다', () => {
  const q = quest([task('완료', 'free', true)]);
  assert.throws(() => validateQuests([q, q]));
  assert.throws(() => validateQuests([quest([task('첫'), task('둘', 'chain', true)])]));
  assert.throws(() => validateQuests([{ ...q, status: 'completed' }]));
});
test('백업의 실행 가능한 이미지와 길이 초과 텍스트를 거부한다', () => {
  const q = claimReward(quest([task('완료', 'free', true)]), '기록');
  q.rewardRecord.photo = { blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }), name: 'bad.svg' };
  assert.throws(() => validateQuests([q]));
  assert.throws(() => validateQuests([{ ...quest([task('할 일')]), title: 'a'.repeat(81) }]));
});

console.log(`${passed.length} quest behavior tests passed.`);
