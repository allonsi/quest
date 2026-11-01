import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { makeQuest, progress, sortQuests, isUnlocked, toggleTask, toggleGoal, startQuest, canClaim, claimReward, normalizeTasks, validateQuests, exampleQuests } from '../web/domain.js';

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
test('단계 없는 퀘스트도 완료 체크 전에는 0%이며 보상을 받을 수 없다', () => {
  const q = quest([]);
  assert.deepEqual(progress(q), { total: 1, done: 0, percent: 0 });
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
test('이름과 보상은 필수이다', () => {
  assert.throws(() => startQuest(makeQuest()));
  assert.throws(() => startQuest(makeQuest({ reward: '보상' })));
  assert.throws(() => startQuest(makeQuest({ title: '제목', tasks: [task('할 일')] })));
});
test('기존 초안에 빈 하위·연계 단계가 남아 있어도 단계 없이 시작할 수 있다', () => {
  const draft = makeQuest({ title: '산책하기', reward: '따뜻한 차', tasks: [
    { ...task('하위', 'free'), title: '' }, { ...task('연계'), title: ' \n\t ' }
  ] });
  const q = startQuest(draft);
  assert.equal(q.status, 'active'); assert.equal(q.tasks.length, 0);
  assert.equal(q.goalDone, false); assert.equal(canClaim(q), false);
  assert.equal(draft.tasks.length, 2);
  assert.equal(validateQuests([q])[0].tasks.length, 0);
});
test('시작할 때 빈 단계만 제외하고 작성한 단계의 내용·순서·진행을 유지한다', () => {
  const draft = makeQuest({ title: '산책하기', reward: '따뜻한 차', tasks: [
    { ...task('빈 하위', 'free'), title: '' },
    { ...task('준비', 'chain', true), title: '  신발 신기  ' },
    { ...task('빈 연계'), title: '  ' },
    { ...task('산책', 'chain', true), title: '  산책하기  ' },
  ] });
  const q = startQuest(draft);
  assert.deepEqual(q.tasks.map(t => [t.id, t.title, t.done]), [
    ['준비', '신발 신기', true], ['산책', '산책하기', true]
  ]);
  assert.equal(draft.tasks.length, 4); assert.equal(draft.tasks[1].title, '  신발 신기  ');
  assert.equal(validateQuests([q])[0].tasks.length, 2);
});
test('빈 단계는 작성 중 백업에만 허용하고 진행 중 기록에는 허용하지 않는다', () => {
  const draft = makeQuest({ title: '산책하기', reward: '따뜻한 차', tasks: [{ ...task('빈 단계'), title: '' }] });
  assert.equal(validateQuests([draft])[0].status, 'draft');
  assert.throws(() => validateQuests([{ ...draft, status: 'active' }]));
});
test('발걸음 없이 이름과 보상으로 퀘스트를 시작할 수 있다', () => {
  const q = startQuest(makeQuest({ title: '  산책하기  ', reward: '  따뜻한 차  ' }));
  assert.equal(q.title, '산책하기'); assert.equal(q.status, 'active');
  assert.deepEqual(q.tasks, []); assert.equal(q.goalDone, false);
  assert.equal(canClaim(q), false);
});
test('단계 없는 퀘스트는 완료 체크와 해제를 할 수 있으며 원본을 수정하지 않는다', () => {
  const q = startQuest(makeQuest({ title: '산책하기', reward: '따뜻한 차' }));
  const checked = toggleGoal(q);
  assert.equal(q.goalDone, false);
  assert.deepEqual(progress(checked), { total: 1, done: 1, percent: 100 });
  assert.equal(canClaim(checked), true); assert.equal(checked.status, 'active');
  const unchecked = toggleGoal(checked);
  assert.equal(progress(unchecked).percent, 0); assert.equal(canClaim(unchecked), false);
});
test('전체 완료 체크는 진행 중인 단계 없는 퀘스트에만 허용한다', () => {
  assert.throws(() => toggleGoal(makeQuest()));
  assert.throws(() => toggleGoal(quest([task('할 일')])));
  const completed = claimReward(toggleGoal(quest([])), '차 한 잔을 마셨다');
  assert.throws(() => toggleGoal(completed));
});
test('단계 없는 퀘스트도 완료 체크와 보상 기록을 거쳐 백업할 수 있다', () => {
  const q = quest([]);
  assert.throws(() => claimReward(q, '아직 안 했어요'));
  assert.throws(() => claimReward(toggleGoal(q), '  '));
  const completed = claimReward(toggleGoal(q), '  차 한 잔  ');
  const restored = validateQuests(JSON.parse(JSON.stringify([completed])))[0];
  assert.equal(restored.status, 'completed'); assert.equal(restored.goalDone, true);
  assert.deepEqual(restored.tasks, []); assert.equal(restored.rewardRecord.note, '차 한 잔');
  assert.equal(progress(restored).percent, 100);
  assert.throws(() => validateQuests([{ ...completed, goalDone: false }]));
});
test('기존 백업은 새 필드 없이 읽고 잘못된 완료 체크 형식은 거부한다', () => {
  const old = quest([task('할 일')]); delete old.goalDone;
  const restored = validateQuests([old])[0];
  assert.equal(restored.goalDone, false); assert.deepEqual(restored.tasks, old.tasks);
  assert.throws(() => validateQuests([{ ...quest([]), goalDone: 'true' }]));
});
test('단계를 추가하면 전체 완료 체크가 개별 단계의 완료를 대신하지 않는다', () => {
  const q = startQuest({ ...toggleGoal(quest([])), tasks: [task('새 단계')] });
  assert.equal(q.goalDone, false); assert.equal(canClaim(q), false);
  assert.equal(progress(q).percent, 0);
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

test('중요·긴급은 각각 또는 동시에 표시하고 완료 후에도 유지한다', () => {
  const plain = makeQuest();
  assert.equal(plain.important, false); assert.equal(plain.urgent, false);
  for (const important of [false, true]) for (const urgent of [false, true]) {
    const started = startQuest(makeQuest({ title: '산책하기', reward: '따뜻한 차', important, urgent }));
    const completed = claimReward(toggleGoal(started), '잘 쉬었다');
    assert.equal(completed.important, important); assert.equal(completed.urgent, urgent);
    const restored = validateQuests(JSON.parse(JSON.stringify([completed])))[0];
    assert.equal(restored.important, important); assert.equal(restored.urgent, urgent);
  }
});
test('이전 기록에는 중요·긴급을 미선택으로 채운다', () => {
  const old = quest([task('할 일')]); delete old.important; delete old.urgent;
  const restored = validateQuests([old])[0];
  assert.equal(restored.important, false); assert.equal(restored.urgent, false);
  assert.deepEqual(restored.tasks, old.tasks);
});
test('중요·긴급 표시의 잘못된 자료형은 거부한다', () => {
  for (const flag of ['important', 'urgent']) for (const value of ['true', 1, null]) {
    assert.throws(() => validateQuests([{ ...quest([]), [flag]: value }]));
  }
});
test('최신순은 수정 날짜와 입력 배열 순서 대신 작성 날짜를 따르고 원본 배열을 유지한다', () => {
  const older = makeQuest({ id: 'older', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-12-01T00:00:00Z' });
  const newer = makeQuest({ id: 'newer', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' });
  const input = [older, newer];
  assert.deepEqual(sortQuests(input).map(q => q.id), ['newer', 'older']);
  assert.deepEqual(input.map(q => q.id), ['older', 'newer']);
});
test('오래된순은 작성 날짜가 빠른 퀘스트부터 나열한다', () => {
  const input = [
    makeQuest({ id: 'new', createdAt: '2026-03-01T00:00:00Z' }),
    makeQuest({ id: 'old', createdAt: '2026-01-01T00:00:00Z' }),
    makeQuest({ id: 'middle', createdAt: '2026-02-01T00:00:00Z' })
  ];
  assert.deepEqual(sortQuests(input, 'oldest').map(q => q.id), ['old', 'middle', 'new']);
});
test('진행도순은 단계 수가 다른 퀘스트와 단일 완료 체크를 함께 정렬한다', () => {
  const third = makeQuest({ id: 'third', tasks: [task('a', 'free', true), task('b', 'free'), task('c', 'free')] });
  const half = makeQuest({ id: 'half', tasks: [task('a', 'free', true), task('b', 'free')] });
  const pending = makeQuest({ id: 'pending' });
  const done = makeQuest({ id: 'done', goalDone: true });
  assert.deepEqual(sortQuests([pending, third, done, half], 'progress').map(q => q.id), ['done', 'half', 'third', 'pending']);
});
test('진행도가 같으면 최신 작성순으로 정렬하고 작성 시각도 같으면 순서가 일정하다', () => {
  const old = makeQuest({ id: 'old', createdAt: '2026-01-01T00:00:00Z' });
  const a = makeQuest({ id: 'a', createdAt: '2026-02-01T00:00:00Z' });
  const b = makeQuest({ id: 'b', createdAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(sortQuests([old, b, a], 'progress').map(q => q.id), ['a', 'b', 'old']);
  assert.deepEqual(sortQuests([a, old, b], 'progress').map(q => q.id), ['a', 'b', 'old']);
});

console.log(`${passed.length} quest behavior tests passed.`);
