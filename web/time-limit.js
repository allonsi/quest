const MINUTE = 60000;
export const NEAR_EXPIRY = 48 * 60 * MINUTE;
export const MAX_LIMIT_MINUTES = 10 * 365 * 24 * 60;

export function validateTimeLimit(raw, required = false) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || !['fixed', 'duration'].includes(raw.mode)) {
    throw new Error('기간 한정 설정을 확인해주세요.');
  }
  let expiresAt = null;
  if (raw.expiresAt != null) {
    if (typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt))) throw new Error('만료 일시를 확인해주세요.');
    expiresAt = new Date(raw.expiresAt).toISOString();
  }
  const minutes = raw.mode === 'duration' ? raw.minutes : null;
  if (minutes != null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LIMIT_MINUTES)) {
    throw new Error('만료까지의 시간은 1분 이상, 10년 이하로 정해주세요.');
  }
  if (required && (!expiresAt || (raw.mode === 'duration' && minutes == null))) throw new Error('만료 일시 또는 만료까지의 시간을 정해주세요.');
  return { mode: raw.mode, expiresAt, minutes: minutes ?? null };
}

export function startTimeLimit(raw, now = new Date()) {
  const limit = validateTimeLimit(raw);
  if (!limit) return null;
  if (limit.mode === 'duration' && !limit.expiresAt && limit.minutes != null) {
    limit.expiresAt = new Date(now.getTime() + limit.minutes * MINUTE).toISOString();
  }
  validateTimeLimit(limit, true);
  if (Date.parse(limit.expiresAt) <= now.getTime()) throw new Error('지금보다 나중의 만료 일시를 정해주세요.');
  return limit;
}

export const questDone = quest => quest.tasks.length ? quest.tasks.every(task => task.done) : quest.goalDone === true;

// Expiry is derived from the saved instant, including when the app was closed/offline.
// Finishing the checklist in time keeps the reward available after the deadline.
export function questStatus(quest, now = new Date()) {
  return ['active', 'recurring'].includes(quest.status) && quest.timeLimit?.expiresAt &&
    Date.parse(quest.timeLimit.expiresAt) <= now.getTime() && (quest.status === 'recurring' || !questDone(quest)) ? 'expired' : quest.status;
}

export function priorityRank(quest, now = new Date()) {
  const remaining = Date.parse(quest.timeLimit?.expiresAt) - now.getTime();
  if (remaining > 0 && remaining <= NEAR_EXPIRY) return 4;
  if (quest.urgent === true) return 3;
  if (quest.timeLimit) return 2;
  return quest.important === true ? 1 : 0;
}

export function localDateTimeValue(instant) {
  if (!instant) return '';
  const date = new Date(instant);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * MINUTE);
  return local.toISOString().slice(0, 16);
}

export function parseLocalDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDateTimeValue(date.toISOString()) !== value) throw new Error('만료 일시를 확인해주세요.');
  return date.toISOString();
}

export function clockFields(instant = new Date().toISOString()) {
  const local = localDateTimeValue(instant);
  const hour = Number(local.slice(11, 13));
  return { date: local.slice(0, 10), hour: String(hour % 12 || 12).padStart(2, '0'),
    minute: local.slice(14, 16), period: hour < 12 ? '오전' : '오후' };
}

export function parseClockFields({ date, hour, minute, period }) {
  if (!date || !hour || !minute || !period) return null;
  const half = { '오전': 0, '오후': 12, am: 0, pm: 12 }[period.trim().toLowerCase()];
  if (!/^\d{1,2}$/.test(hour) || Number(hour) < 1 || Number(hour) > 12 ||
    !/^\d{1,2}$/.test(minute) || Number(minute) > 59 || half === undefined) {
    throw new Error('만료 시간은 오전/오후, 1~12시, 0~59분으로 입력해주세요.');
  }
  const hours = Number(hour) % 12 + half;
  return parseLocalDateTime(`${date}T${String(hours).padStart(2, '0')}:${minute.padStart(2, '0')}`);
}

export function durationFields(minutes) {
  if (minutes == null) return { days: '', hours: '', minutes: '' };
  return { days: String(Math.floor(minutes / 1440)), hours: String(Math.floor(minutes % 1440 / 60)), minutes: String(minutes % 60) };
}

export function parseDurationFields({ days, hours, minutes }) {
  const values = [days, hours, minutes];
  if (values.every(value => value === '')) return null;
  const ranges = [3650, 23, 59];
  if (values.some((value, index) => value !== '' && (!/^\d+$/.test(value) || Number(value) > ranges[index]))) {
    throw new Error('기간은 일(0~3650), 시간(0~23), 분(0~59)을 정수로 입력해주세요.');
  }
  const total = Number(days) * 1440 + Number(hours) * 60 + Number(minutes);
  if (total < 1 || total > MAX_LIMIT_MINUTES) throw new Error('만료까지의 시간은 1분 이상, 10년 이하로 정해주세요.');
  return total;
}
