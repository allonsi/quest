export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_RECORDS = 3650;

// Calendar dates follow the device's local day, rather than the UTC date.
export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function calendarDate(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('기록할 날짜를 확인해주세요.');
  const date = new Date(`${key}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) throw new Error('기록할 날짜를 확인해주세요.');
  return date;
}

export function validateRecurrence(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.days) || raw.days.length > 7 ||
    raw.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(raw.days).size !== raw.days.length) {
    throw new Error('반복할 요일을 확인해주세요.');
  }
  if (!Array.isArray(raw.history) || raw.history.length > MAX_RECORDS) throw new Error('반복퀘스트 기록의 형식이나 개수를 확인해주세요.');
  const dates = new Set();
  const history = raw.history.map(record => {
    if (!record || !['success', 'failure'].includes(record.outcome)) throw new Error('반복퀘스트의 성공·실패 기록을 확인해주세요.');
    calendarDate(record.date);
    if (dates.has(record.date)) throw new Error('같은 날짜의 반복퀘스트 기록이 중복되어 있어요.');
    dates.add(record.date);
    return { date: record.date, outcome: record.outcome };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { days: [...raw.days].sort((a, b) => a - b), history };
}

export function recurrenceLabel(recurrence) {
  if (!recurrence?.days.length) return '반복할 요일을 선택해주세요';
  return recurrence.days.length === 7 ? '매일 반복' : `매주 ${recurrence.days.map(day => WEEKDAYS[day]).join('·')} 반복`;
}

export function recurrenceCounts(quest) {
  const history = quest.recurrence?.history || [];
  return { success: history.filter(record => record.outcome === 'success').length,
    failure: history.filter(record => record.outcome === 'failure').length };
}

export function occurrenceState(quest, date = localDateKey(), now = new Date()) {
  const day = calendarDate(date).getUTCDay();
  const record = quest.recurrence?.history.find(item => item.date === date);
  const scheduled = quest.recurrence?.days.includes(day) === true;
  const available = quest.status === 'recurring' && date <= localDateKey(now) &&
    date >= localDateKey(new Date(quest.createdAt)) && (scheduled || !!record);
  return { scheduled, outcome: record?.outcome || null, available };
}

export function recordOccurrence(quest, date, outcome, now = new Date()) {
  if (outcome !== null && !['success', 'failure'].includes(outcome)) throw new Error('성공 또는 실패를 선택해주세요.');
  if (!occurrenceState(quest, date, now).available) throw new Error('시작한 날부터 오늘까지, 반복하는 요일에 기록할 수 있어요.');
  const history = quest.recurrence.history.filter(item => item.date !== date);
  if (outcome !== null) {
    if (history.length >= MAX_RECORDS) throw new Error('이 퀘스트에 보관할 수 있는 기록이 가득 찼어요. 백업 후 새 반복퀘스트로 이어가주세요.');
    history.push({ date, outcome });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  return { ...quest, recurrence: { ...quest.recurrence, history }, updatedAt: now.toISOString() };
}
