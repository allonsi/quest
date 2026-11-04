import assert from 'node:assert/strict';
import { makeQuest, startQuest, toggleGoal, toggleTask, claimReward, canClaim, sortQuests, validateQuests, reorderTasks, isUnlocked } from '../web/domain.js';
import { questStatus, validateTimeLimit, localDateTimeValue, parseLocalDateTime, clockFields, parseClockFields, durationFields, parseDurationFields } from '../web/time-limit.js';
import { getQuestView } from '../web/list-view.js';
import { recordOccurrence, recurrenceCounts, localDateKey } from '../web/recurrence.js';

export const passed = [];
const test = (name, fn) => { fn(); passed.push(name); };
const now = new Date('2026-11-04T10:00:00Z');
const later = minutes => new Date(now.getTime() + minutes * 60000).toISOString();
const draft = overrides => makeQuest({ title: '기간 안에 산책하기', reward: '차 한 잔', ...overrides });
const limited = minutes => startQuest(draft({ timeLimit: { mode: 'duration', minutes, expiresAt: null } }), now);
const task = (id, kind = 'free', done = false) => ({ id, title: id, kind, done });

test('기간 한정 없이 이전 퀘스트와 백업을 읽는다', () => {
  const old = draft(); delete old.timeLimit;
  assert.equal(validateQuests([old])[0].timeLimit, null);
});
test('미완성 기간 설정은 초안에 보관하되 시작할 수 없다', () => {
  for (const mode of ['fixed', 'duration']) {
    const q = draft({ timeLimit: { mode, expiresAt: null, minutes: null } });
    assert.equal(validateQuests([q])[0].timeLimit.mode, mode);
    assert.throws(() => startQuest(q, now));
  }
});
test('특정 만료 일시는 그대로 보관하고 진행 중으로 시작한다', () => {
  const q = startQuest(draft({ timeLimit: { mode: 'fixed', expiresAt: later(90) } }), now);
  assert.equal(q.status, 'active'); assert.equal(q.timeLimit.expiresAt, later(90));
});
test('상대 기간은 작성 시각 대신 시작 버튼을 누른 시각부터 계산한다', () => {
  const q = startQuest(draft({ createdAt: '2025-01-01T00:00:00Z', timeLimit: { mode: 'duration', minutes: 120 } }), now);
  assert.equal(q.timeLimit.expiresAt, later(120));
});
test('유효한 기존 상대 만료 시각은 편집 후에도 유지한다', () => {
  const q = limited(120);
  const edited = startQuest({ ...q, status: 'draft', title: '바뀐 제목' }, new Date(later(30)));
  assert.equal(edited.timeLimit.expiresAt, q.timeLimit.expiresAt);
});
test('과거·현재 만료 시각과 유효하지 않은 상대 시간은 거부한다', () => {
  for (const expiresAt of [later(-1), later(0), 'not-a-date']) assert.throws(() => startQuest(draft({ timeLimit: { mode: 'fixed', expiresAt } }), now));
  for (const minutes of [0, -1, 1.2, '60', Infinity, 5256001]) assert.throws(() => limited(minutes));
  assert.throws(() => validateTimeLimit({ mode: 'unknown' }));
});
test('반복과 기간 한정을 함께 설정하고 백업할 수 있다', () => {
  const q = draft({ recurrence: { days: [1], history: [] }, timeLimit: { mode: 'duration', minutes: 60 } });
  const started = startQuest(q, now);
  assert.equal(started.status, 'recurring'); assert.equal(validateQuests([started])[0].timeLimit.minutes, 60);
  assert.equal(questStatus(started, new Date(later(60))), 'expired');
});
test('정확한 만료 시각부터 미완료 퀘스트가 기간 만료로 보인다', () => {
  const q = limited(60);
  assert.equal(questStatus(q, new Date(later(59))), 'active');
  assert.equal(questStatus(q, new Date(later(60))), 'expired');
  assert.equal(questStatus(q, new Date(later(6000))), 'expired');
  assert.equal(q.status, 'active');
});
test('기간 한정 반복은 만료 후 기록을 막고 기존 성공·실패를 보관한다', () => {
  const q = startQuest(draft({ createdAt: now.toISOString(), recurrence: { days: [0, 1, 2, 3, 4, 5, 6], history: [] }, timeLimit: { mode: 'duration', minutes: 60 } }), now);
  const recorded = recordOccurrence(q, localDateKey(now), 'success', now);
  const end = new Date(later(60));
  assert.equal(questStatus(recorded, end), 'expired');
  assert.equal(recurrenceCounts(recorded).success, 1);
  assert.throws(() => recordOccurrence(recorded, localDateKey(end), 'failure', end));
  const expiredView = getQuestView([recorded], { tab: 'expired' }, end);
  assert.equal(expiredView.quests.length, 1);
  assert.equal(getQuestView([recorded], { tab: 'recurring' }, end).quests.length, 0);
  const restarted = startQuest({ ...recorded, timeLimit: { mode: 'duration', minutes: 120 } }, end);
  assert.equal(restarted.status, 'recurring'); assert.equal(recurrenceCounts(restarted).success, 1);
});
test('초안은 시간이 지나도 자동 만료되지 않는다', () => {
  const q = { ...limited(1), status: 'draft' };
  assert.equal(questStatus(q, new Date(later(2))), 'draft');
});
test('만료 후 단일 완료 체크·하위 및 연계 체크를 막는다', () => {
  const expired = new Date(later(60));
  assert.throws(() => toggleGoal(limited(60), expired));
  const q = { ...limited(60), tasks: [task('할 일')] };
  assert.throws(() => toggleTask(q, '할 일', expired));
  assert.throws(() => claimReward(q, '기록'));
});
test('만료 전 완료 체크한 퀘스트는 만료 후에도 보상을 기록한다', () => {
  const q = toggleGoal(limited(60), new Date(later(59)));
  assert.equal(questStatus(q, new Date(later(61))), 'active');
  assert.equal(canClaim(q), true);
  const completed = claimReward(q, '제때 했어요');
  assert.equal(questStatus(completed, new Date(later(600))), 'completed');
  assert.equal(validateQuests([completed])[0].timeLimit.expiresAt, later(60));
});
test('전체 하위 퀘스트 완료도 만료 후 보상 자격을 유지한다', () => {
  const q = toggleTask({ ...limited(60), tasks: [task('할 일')] }, '할 일', now);
  assert.equal(questStatus(q, new Date(later(100))), 'active');
});
test('만료 후 완료를 해제하면 기간 만료로 이동하고 다시 체크할 수 없다', () => {
  const q = toggleGoal(limited(60), now);
  const unchecked = toggleGoal(q, new Date(later(61)));
  assert.equal(questStatus(unchecked, new Date(later(61))), 'expired');
  assert.throws(() => toggleGoal(unchecked, new Date(later(61))));
});
test('만료 정보는 백업 왕복에도 남고 과거 날짜 때문에 불러오기가 실패하지 않는다', () => {
  const q = limited(60);
  const restored = validateQuests(JSON.parse(JSON.stringify([q])))[0];
  assert.equal(restored.timeLimit.expiresAt, q.timeLimit.expiresAt);
  assert.equal(questStatus(restored, new Date(later(61))), 'expired');
  assert.throws(() => validateQuests([{ ...q, timeLimit: { mode: 'duration', minutes: 60, expiresAt: null } }]));
});
test('기간 만료와 진행 중 목록·카운트가 겹치지 않고 필터는 진행 중에만 적용한다', () => {
  const expired = { ...limited(1), id: 'expired' }, active = { ...limited(60), id: 'active' };
  const time = new Date(later(2));
  const input = [expired, active];
  assert.equal(getQuestView(input, { tab: 'active' }, time).quests[0].id, 'active');
  const view = getQuestView(input, { tab: 'expired', priorityFilter: 'urgent' }, time);
  assert.equal(view.quests[0].id, 'expired'); assert.equal(view.total, 1); assert.equal(view.controlsVisible, false);
});
test('48시간 이내 > 긴급 > 기간 한정 > 중요 > 일반 순서가 모든 정렬에 적용된다', () => {
  const input = [
    { ...draft(), id: 'plain' }, { ...draft(), id: 'important', important: true },
    { ...limited(49 * 60), id: 'limited' }, { ...draft(), id: 'urgent', urgent: true },
    { ...limited(48 * 60), id: 'near' }
  ];
  for (const order of ['newest', 'oldest', 'progress']) assert.deepEqual(sortQuests(input, order, now).map(q => q.id), ['near', 'urgent', 'limited', 'important', 'plain']);
  assert.equal(input[0].id, 'plain');
});
test('48시간 경계가 지나면 우선순위가 바뀐다', () => {
  const input = [{ ...limited(49 * 60), id: 'limited' }, { ...draft(), id: 'urgent', urgent: true }];
  assert.equal(sortQuests(input, 'newest', now)[0].id, 'urgent');
  assert.equal(sortQuests(input, 'newest', new Date(later(60)))[0].id, 'limited');
});
test('만료된 상대 퀘스트는 남은 진행을 유지하며 새 시간으로 재등록한다', () => {
  const q = { ...limited(60), tasks: [task('먼저', 'free', true), task('나중')] };
  const restarted = startQuest({ ...q, status: 'draft', timeLimit: { ...q.timeLimit, expiresAt: null } }, new Date(later(120)));
  assert.equal(restarted.timeLimit.expiresAt, later(180)); assert.equal(restarted.tasks[0].done, true);
  assert.equal(questStatus(restarted, new Date(later(121))), 'active');
});
test('만료된 고정 퀘스트는 새 미래 일시로 재등록한다', () => {
  const q = limited(60);
  const restarted = startQuest({ ...q, timeLimit: { mode: 'fixed', expiresAt: later(180) } }, new Date(later(120)));
  assert.equal(questStatus(restarted, new Date(later(121))), 'active');
});
test('기기의 현지 일시와 저장된 절대 시각을 왕복 변환한다', () => {
  const value = localDateTimeValue(now.toISOString());
  assert.equal(parseLocalDateTime(value), now.toISOString());
  assert.equal(parseLocalDateTime(''), null);
  assert.throws(() => parseLocalDateTime('2026-02-30T12:00'));
});
test('날짜·12시간제 시·분·오전/오후 입력을 저장 시각으로 변환하고 복원한다', () => {
  for (const [hour, period, expected] of [['12', '오전', '00'], ['12', '오후', '12'], ['1', '오후', '13'], ['11', '오전', '11']]) {
    const instant = parseClockFields({ date: '2026-11-04', hour, minute: '5', period });
    assert.equal(localDateTimeValue(instant), `2026-11-04T${expected}:05`);
    const fields = clockFields(instant);
    assert.equal(fields.date, '2026-11-04'); assert.equal(fields.hour, hour.padStart(2, '0'));
    assert.equal(fields.minute, '05'); assert.equal(fields.period, period);
  }
});
test('직접 입력한 AM·PM과 한 자리 분을 읽는다', () => {
  assert.equal(localDateTimeValue(parseClockFields({ date: '2026-11-04', hour: '3', minute: '0', period: 'PM' })), '2026-11-04T15:00');
  assert.equal(localDateTimeValue(parseClockFields({ date: '2026-11-04', hour: '3', minute: '9', period: 'am' })), '2026-11-04T03:09');
});
test('시간 입력이 미완성이면 초안을 허용하고 잘못된 값은 거부한다', () => {
  const fields = { date: '2026-11-04', hour: '1', minute: '00', period: '오후' };
  for (const key of Object.keys(fields)) assert.equal(parseClockFields({ ...fields, [key]: '' }), null);
  for (const [key, value] of [['hour', '0'], ['hour', '13'], ['minute', '60'], ['minute', '-1'], ['period', '저녁'], ['date', '2026-02-30']]) {
    assert.throws(() => parseClockFields({ ...fields, [key]: value }));
  }
});
test('기존 분 단위 기간은 일·시간·분으로 손실 없이 왕복한다', () => {
  for (const total of [1, 59, 60, 1440, 1565, 5256000]) assert.equal(parseDurationFields(durationFields(total)), total);
  const fields = durationFields(1565);
  assert.equal(fields.days, '1'); assert.equal(fields.hours, '2'); assert.equal(fields.minutes, '5');
});
test('일·시간·분 빈 칸은 0으로 합산하고 모두 비우면 초안으로 남긴다', () => {
  assert.equal(parseDurationFields({ days: '2', hours: '', minutes: '5' }), 2885);
  assert.equal(parseDurationFields({ days: '', hours: '1', minutes: '' }), 60);
  assert.equal(parseDurationFields(durationFields(null)), null);
});
test('기간 입력의 음수·소수·범위 초과와 0분은 거부한다', () => {
  const fields = { days: '0', hours: '1', minutes: '0' };
  for (const [key, value] of [['days', '-1'], ['days', '1.5'], ['days', '3651'], ['hours', '24'], ['minutes', '60'], ['minutes', 'abc']]) {
    assert.throws(() => parseDurationFields({ ...fields, [key]: value }));
  }
  assert.throws(() => parseDurationFields({ days: '0', hours: '0', minutes: '0' }));
  assert.throws(() => parseDurationFields({ days: '3650', hours: '1', minutes: '0' }));
});
test('하위·연계 내용의 줄바꿈과 순서는 백업에 유지된다', () => {
  const q = startQuest(draft({ tasks: [{ ...task('a'), title: '첫 줄\n둘째 줄' }, task('b', 'chain')] }), now);
  const restored = validateQuests(JSON.parse(JSON.stringify([q])))[0];
  assert.equal(restored.tasks[0].title, '첫 줄\n둘째 줄'); assert.equal(restored.tasks[1].id, 'b');
});
test('발걸음을 위·아래와 임의 위치로 옮겨도 ID·종류·내용과 원본은 유지한다', () => {
  const input = [task('a'), task('b', 'chain'), task('c')];
  const down = reorderTasks(input, 'a', 2);
  assert.equal(down.map(t => t.id).join(','), 'b,c,a');
  assert.equal(reorderTasks(down, 'a', 0).map(t => t.id).join(','), 'a,b,c');
  assert.equal(input.map(t => t.id).join(','), 'a,b,c');
  assert.equal(down[0].kind, 'chain'); assert.equal(down[2].title, 'a');
});
test('재정렬로 미완료 연계가 앞에 오면 뒤 연계 완료만 정규화한다', () => {
  const input = [task('a', 'chain', true), task('free', 'free', true), task('b', 'chain')];
  const result = reorderTasks(input, 'b', 0);
  assert.equal(result[1].done, false); assert.equal(result[2].done, true);
  assert.equal(isUnlocked({ tasks: result }, 'a'), false); assert.equal(input[0].done, true);
});
test('경계 밖·없는 ID 재정렬은 순서를 바꾸지 않는다', () => {
  const input = [task('a'), task('b')];
  for (const [id, index] of [['missing', 0], ['a', -1], ['a', 2]]) assert.equal(reorderTasks(input, id, index).map(t => t.id).join(','), 'a,b');
});

console.log(`${passed.length} time limit and task editing tests passed.`);
