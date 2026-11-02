import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeQuest, startQuest, validateQuests, canClaim } from '../web/domain.js';
import { getQuestView } from '../web/list-view.js';
import { localDateKey, calendarDate, validateRecurrence, recurrenceCounts, recurrenceLabel, occurrenceState, recordOccurrence } from '../web/recurrence.js';

globalThis.crypto ??= webcrypto;
export const passed = [];
const test = (name, fn) => { fn(); passed.push(name); };
const now = new Date(2026, 10, 2, 12); // Monday in the device's calendar.
const quest = (days = [1, 3, 5]) => startQuest(makeQuest({ title: '매주 산책', reward: '따뜻한 차', createdAt: new Date(2026, 9, 25, 12).toISOString(), recurrence: { days, history: [] } }));
const record = (q, date, outcome) => recordOccurrence(q, date, outcome, now);

test('이전 퀘스트는 반복 정보 없이 그대로 불러온다', () => {
  const old = makeQuest(); delete old.recurrence;
  assert.equal(validateQuests([old])[0].recurrence, null);
  assert.equal(startQuest(makeQuest({ title: '일반', reward: '휴식' })).status, 'active');
});
test('선택한 요일이 있으면 진행 중 대신 반복퀘스트로 시작한다', () => {
  const q = quest([5, 1, 3]);
  assert.equal(q.status, 'recurring'); assert.deepEqual(q.recurrence.days, [1, 3, 5]);
  assert.equal(canClaim(q), false);
});
test('요일 없는 반복퀘스트는 초안만 보관하고 시작할 수 없다', () => {
  const draft = makeQuest({ title: '습관', reward: '휴식', recurrence: { days: [], history: [] } });
  assert.deepEqual(validateQuests([draft])[0].recurrence.days, []);
  assert.throws(() => startQuest(draft), /요일/);
});
test('요일은 중복 없는 0~6 정수만 허용한다', () => {
  for (const days of [[1, 1], [-1], [7], ['1'], [1.5], null]) assert.throws(() => validateRecurrence({ days, history: [] }));
});
test('같은 날 성공 기록을 반복 저장해도 성공 횟수는 한 번만 늘어난다', () => {
  const q = record(record(quest(), '2026-11-02', 'success'), '2026-11-02', 'success');
  assert.deepEqual(recurrenceCounts(q), { success: 1, failure: 0 });
  assert.equal(q.recurrence.history.length, 1);
});
test('성공을 실패로 바꾸면 기존 성공을 빼고 실패를 한 번 센다', () => {
  const q = record(record(quest(), '2026-11-02', 'success'), '2026-11-02', 'failure');
  assert.deepEqual(recurrenceCounts(q), { success: 0, failure: 1 });
  assert.equal(occurrenceState(q, '2026-11-02', now).outcome, 'failure');
});
test('기록을 취소하면 해당 날짜만 없어지고 나머지 횟수는 보존한다', () => {
  let q = record(quest(), '2026-10-30', 'success');
  q = record(q, '2026-11-02', 'failure'); q = record(q, '2026-11-02', null);
  assert.deepEqual(recurrenceCounts(q), { success: 1, failure: 0 });
  assert.deepEqual(q.recurrence.history, [{ date: '2026-10-30', outcome: 'success' }]);
});
test('놓친 날을 실패로 자동 집계하지 않는다', () => {
  const q = quest(); occurrenceState(q, '2026-11-02', now);
  assert.deepEqual(recurrenceCounts(q), { success: 0, failure: 0 }); assert.equal(q.recurrence.history.length, 0);
});
test('반복 요일이 아닌 날·미래·생성 전에는 새 기록을 남길 수 없다', () => {
  for (const date of ['2026-10-27', '2026-11-04', '2026-10-23']) assert.throws(() => record(quest(), date, 'success'));
});
test('선택한 과거 요일에 결과를 기록할 수 있다', () => {
  const q = record(record(quest(), '2026-10-28', 'failure'), '2026-10-30', 'success');
  assert.deepEqual(recurrenceCounts(q), { success: 1, failure: 1 });
});
test('완료됨·일반·초안 퀘스트에는 반복 결과를 기록할 수 없다', () => {
  for (const status of ['draft', 'active', 'completed']) assert.throws(() => record({ ...quest(), status }, '2026-11-02', 'success'));
});
test('요일을 바꿔도 과거 기록을 보존하고 해당 기록을 수정할 수 있다', () => {
  const saved = record(quest(), '2026-11-02', 'success');
  const edited = startQuest({ ...saved, recurrence: { ...saved.recurrence, days: [2, 4] } });
  assert.deepEqual(recurrenceCounts(edited), { success: 1, failure: 0 });
  assert.deepEqual(recurrenceCounts(record(edited, '2026-11-02', 'failure')), { success: 0, failure: 1 });
});
test('백업 JSON 왕복 후 반복 요일·날짜·결과가 유지된다', () => {
  const q = record(quest(), '2026-11-02', 'success');
  assert.deepEqual(validateQuests(JSON.parse(JSON.stringify([q])))[0], q);
});
test('잘못된 날짜·결과·중복 날짜·기록 개수를 백업에서 거부한다', () => {
  for (const history of [
    [{ date: '2026-02-30', outcome: 'success' }], [{ date: '2026-11-02', outcome: 'maybe' }],
    [{ date: '2026-11-02', outcome: 'success' }, { date: '2026-11-02', outcome: 'failure' }],
    Array(3651).fill({ date: '2026-11-02', outcome: 'success' })
  ]) assert.throws(() => validateQuests([{ ...quest(), recurrence: { days: [1], history } }]));
  assert.throws(() => validateQuests([{ ...quest(), recurrence: null }]));
});
test('알 수 없는 반복 필드는 가져오지 않고 요일 변경 전 기록도 보존한다', () => {
  assert.deepEqual(validateRecurrence({ days: [2], history: [{ date: '2026-11-02', outcome: 'success', extra: 1 }], extra: 1 }),
    { days: [2], history: [{ date: '2026-11-02', outcome: 'success' }] });
});
test('반복퀘스트는 독립된 탭에 모이고 진행 중 필터의 영향을 받지 않는다', () => {
  const q = quest(), normal = startQuest(makeQuest({ title: '한 번', reward: '휴식' }));
  const input = [q, normal];
  const view = getQuestView(input, { tab: 'recurring', priorityFilter: 'urgent' });
  assert.deepEqual(view.quests, [q]); assert.equal(view.controlsVisible, false);
  assert.deepEqual(getQuestView(input, { tab: 'active' }).quests, [normal]);
});
test('반복퀘스트 검색과 매일·주간 요일 표시를 지원한다', () => {
  assert.equal(getQuestView([quest()], { tab: 'recurring', query: '산책' }).quests.length, 1);
  assert.equal(recurrenceLabel({ days: [0, 1, 2, 3, 4, 5, 6] }), '매일 반복');
  assert.equal(recurrenceLabel({ days: [0, 3, 6] }), '매주 일·수·토 반복');
});
test('시간대·일광절약시간에 관계없이 기기의 날짜와 달력 요일을 사용한다', () => {
  assert.equal(localDateKey(new Date(2026, 10, 2, 0, 1)), '2026-11-02');
  assert.equal(localDateKey(new Date(2026, 2, 8, 23, 59)), '2026-03-08');
  assert.equal(calendarDate('2026-03-08').getUTCDay(), 0);
  assert.equal(calendarDate('2026-11-01').getUTCDay(), 0);
  assert.throws(() => calendarDate('2026-13-01'));
});

console.log(`${passed.length} recurring quest behavior tests passed.`);
