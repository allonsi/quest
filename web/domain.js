import { validateRecurrence } from './recurrence.js';
import { validateTimeLimit, startTimeLimit, questStatus, questDone, priorityRank } from './time-limit.js';

export const CATEGORIES = ['일상', '공부', '건강', '나를 위한 일'];
export const STATUSES = ['draft', 'active', 'completed', 'recurring'];
export const uid = () => crypto.randomUUID();

export function makeQuest(overrides = {}) {
  const now = new Date().toISOString();
  return { id: uid(), title: '', description: '', category: '일상', status: 'draft',
    important: false, urgent: false, tasks: [], goalDone: false, reward: '', rewardRecord: null, recurrence: null, timeLimit: null, createdAt: now, updatedAt: now,
    isExample: false, ...overrides };
}

export function progress(quest) {
  const total = quest.tasks.length || 1;
  const done = quest.tasks.length ? quest.tasks.filter(task => task.done).length : Number(quest.goalDone === true);
  return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
}

export function sortQuests(quests, order = 'newest', now = new Date()) {
  return [...quests].sort((a, b) => {
    const urgency = priorityRank(b, now) - priorityRank(a, now);
    if (urgency) return urgency;
    const newest = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    const tie = a.id.localeCompare(b.id);
    if (order === 'oldest') return -newest || tie;
    if (order === 'progress') {
      const left = progress(a), right = progress(b);
      return (right.done * left.total - left.done * right.total) || newest || tie;
    }
    return newest || tie;
  });
}

export function matchesPriority(quest, filter = 'all') {
  const important = quest.important === true, urgent = quest.urgent === true;
  if (filter === 'important') return important;
  if (filter === 'urgent') return urgent;
  if (filter === 'both') return important && urgent;
  return true;
}

export function filterQuests(quests, filter = 'all', query = '') {
  const search = query.trim().toLocaleLowerCase();
  return quests.filter(quest => matchesPriority(quest, filter) &&
    `${quest.title} ${quest.description} ${quest.reward}`.toLocaleLowerCase().includes(search));
}

export function isUnlocked(quest, taskId) {
  const index = quest.tasks.findIndex(task => task.id === taskId);
  if (index < 0) return false;
  return quest.tasks[index].kind !== 'chain' ||
    quest.tasks.slice(0, index).filter(task => task.kind === 'chain').every(task => task.done);
}

export function normalizeTasks(tasks) {
  let blocked = false;
  return tasks.map(task => {
    const normalized = { ...task };
    if (task.kind === 'chain') {
      if (blocked) normalized.done = false;
      if (!normalized.done) blocked = true;
    }
    return normalized;
  });
}

export function reorderTasks(tasks, taskId, targetIndex) {
  const from = tasks.findIndex(task => task.id === taskId);
  if (from < 0 || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= tasks.length) return normalizeTasks(tasks);
  const ordered = [...tasks];
  const [moved] = ordered.splice(from, 1);
  ordered.splice(targetIndex, 0, moved);
  return normalizeTasks(ordered);
}

export function toggleTask(quest, taskId, now = new Date()) {
  if (questStatus(quest, now) !== 'active') throw new Error('진행 중인 퀘스트만 체크할 수 있어요.');
  if (!isUnlocked(quest, taskId)) throw new Error('앞선 연계 퀘스트를 먼저 마쳐주세요.');
  const tasks = quest.tasks.map(task => task.id === taskId ? { ...task, done: !task.done } : { ...task });
  return { ...quest, tasks: normalizeTasks(tasks), updatedAt: now.toISOString() };
}

export function toggleGoal(quest, now = new Date()) {
  if (questStatus(quest, now) !== 'active') throw new Error('진행 중인 퀘스트만 체크할 수 있어요.');
  if (quest.tasks.length) throw new Error('각 발걸음의 완료 여부를 체크해주세요.');
  return { ...quest, goalDone: !quest.goalDone, updatedAt: now.toISOString() };
}

export function startQuest(quest, now = new Date()) {
  if (!quest.title.trim()) throw new Error('퀘스트 이름을 적어주세요.');
  if (!quest.reward.trim()) throw new Error('나에게 줄 보상을 적어주세요.');
  const recurrence = validateRecurrence(quest.recurrence);
  const timeLimit = startTimeLimit(quest.timeLimit, now);
  if (recurrence && !recurrence.days.length) throw new Error('반복할 요일을 하나 이상 선택해주세요.');
  const tasks = normalizeTasks(quest.tasks.filter(task => task.title.trim())
    .map(task => ({ ...task, title: task.title.trim() })));
  return { ...quest, title: quest.title.trim(), reward: quest.reward.trim(),
    tasks, goalDone: !tasks.length && quest.goalDone === true,
    status: recurrence ? 'recurring' : 'active', recurrence, timeLimit, updatedAt: now.toISOString(), rewardRecord: null };
}

export const canClaim = quest => quest.status === 'active' && questDone(quest);

export function claimReward(quest, note, photo = null) {
  if (!canClaim(quest)) throw new Error('퀘스트를 완료한 뒤 보상을 기록할 수 있어요.');
  if (!note.trim() && !photo) throw new Error('글이나 사진으로 보상을 받은 순간을 남겨주세요.');
  const now = new Date().toISOString();
  return { ...quest, status: 'completed', updatedAt: now,
    rewardRecord: { note: note.trim(), photo, claimedAt: now } };
}

// Construct a known schema rather than spreading imported objects into application state.
export function validateQuests(input) {
  if (!Array.isArray(input) || input.length > 5000) throw new Error('올바른 퀘스트 백업 파일이 아니에요.');
  const ids = new Set();
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw new Error('백업 내용의 형식이나 길이를 확인해주세요.');
    return value;
  };
  const date = value => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('백업에 올바르지 않은 날짜가 있어요.');
    return new Date(value).toISOString();
  };
  return input.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('백업에 올바르지 않은 퀘스트가 있어요.');
    const id = text(raw.id, 100);
    if (!id || ids.has(id) || !STATUSES.includes(raw.status) || !CATEGORIES.includes(raw.category)) throw new Error('백업의 퀘스트 정보가 올바르지 않아요.');
    ids.add(id);
    if (!Array.isArray(raw.tasks) || raw.tasks.length > 100) throw new Error('퀘스트에는 발걸음을 최대 100개까지 담을 수 있어요.');
    const taskIds = new Set();
    const tasks = raw.tasks.map(task => {
      if (!task || !['free', 'chain'].includes(task.kind) || typeof task.done !== 'boolean') throw new Error('백업에 올바르지 않은 발걸음이 있어요.');
      const taskId = text(task.id, 100);
      if (!taskId || taskIds.has(taskId)) throw new Error('발걸음 ID가 올바르지 않아요.');
      taskIds.add(taskId);
      return { id: taskId, title: text(task.title, 160), kind: task.kind, done: task.done };
    });
    if (raw.goalDone !== undefined && typeof raw.goalDone !== 'boolean') throw new Error('퀘스트의 완료 체크 형식을 확인해주세요.');
    for (const flag of ['important', 'urgent']) {
      if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') throw new Error('중요·긴급 표시의 형식을 확인해주세요.');
    }
    const quest = { id, title: text(raw.title, 80), description: text(raw.description, 2000),
      category: raw.category, status: raw.status, important: raw.important === true, urgent: raw.urgent === true,
      tasks, goalDone: !tasks.length && raw.goalDone === true, reward: text(raw.reward, 160),
      createdAt: date(raw.createdAt), updatedAt: date(raw.updatedAt), isExample: raw.isExample === true,
      rewardRecord: null, recurrence: validateRecurrence(raw.recurrence), timeLimit: validateTimeLimit(raw.timeLimit, raw.status !== 'draft') };
    if ((quest.status === 'recurring' && !quest.recurrence) ||
      (quest.recurrence && !['draft', 'recurring'].includes(quest.status))) throw new Error('반복퀘스트의 상태를 확인해주세요.');
    if (JSON.stringify(normalizeTasks(tasks)) !== JSON.stringify(tasks)) throw new Error('연계 퀘스트의 진행 순서가 올바르지 않아요.');
    if (quest.status !== 'draft') {
      if (tasks.some(task => !task.title.trim())) throw new Error('백업에 비어 있는 발걸음이 있어요.');
      if (!quest.title.trim() || !quest.reward.trim()) throw new Error('퀘스트 이름과 보상을 적어주세요.');
      if (quest.recurrence && !quest.recurrence.days.length) throw new Error('반복할 요일을 하나 이상 선택해주세요.');
    }
    if (raw.rewardRecord) {
      const record = raw.rewardRecord;
      if (record.photo && (!(record.photo.blob instanceof Blob) || !['image/jpeg', 'image/png', 'image/webp'].includes(record.photo.blob.type) || record.photo.blob.size > 10 * 1024 * 1024)) throw new Error('백업 사진을 읽을 수 없어요.');
      quest.rewardRecord = { note: text(record.note, 3000), photo: record.photo ? { blob: record.photo.blob, name: text(record.photo.name, 255) } : null, claimedAt: date(record.claimedAt) };
    }
    const { done, total } = progress(quest);
    if (quest.status === 'completed' && (done !== total || !quest.rewardRecord || (!quest.rewardRecord.note.trim() && !quest.rewardRecord.photo))) throw new Error('완료된 퀘스트의 보상 기록을 확인해주세요.');
    if (quest.status !== 'completed' && quest.rewardRecord) throw new Error('진행 상태와 보상 기록이 맞지 않아요.');
    return quest;
  });
}

export function exampleQuests() {
  const task = (title, kind = 'free', done = false) => ({ id: uid(), title, kind, done });
  const ago = days => new Date(Date.now() - days * 86400000).toISOString();
  return [
    makeQuest({ title: '나를 위한 아침 만들기', description: '바쁜 하루를 시작하기 전, 나를 돌보는 작은 시간을 가져보자.\n거창하지 않아도 괜찮아. 오늘의 나에게 다정한 아침을.', category: '일상', status: 'active', reward: '좋아하는 카페에서 따뜻한 라테 한 잔', tasks: [task('창문을 열고 물 한 잔 마시기', 'chain', true), task('침대와 책상 가볍게 정리하기', 'free', true), task('10분만 천천히 산책하기', 'chain')], createdAt: ago(1), isExample: true }),
    makeQuest({ title: '책 속으로 떠나는 짧은 여행', description: '책장에 꽂아두었던 책과 다시 만나기. 오늘은 딱 열 페이지만 읽어보자.', category: '공부', status: 'active', reward: '아무것도 하지 않는 느긋한 30분', tasks: [task('읽고 싶은 책 한 권 고르기', 'chain'), task('열 페이지 읽고 마음에 든 문장 적기', 'chain')], createdAt: ago(2), isExample: true }),
    makeQuest({ title: '작은 공간에 여유 들이기', description: '내가 머무는 공간에 작은 여유를 만들어주었다. 이제 나에게 선물을 건넬 차례!', category: '나를 위한 일', status: 'active', reward: '방에 놓을 꽃 한 송이', tasks: [task('책상 위 물건 제자리 찾아주기', 'free', true), task('필요 없는 종이 정리하기', 'free', true)], createdAt: ago(3), isExample: true }),
    makeQuest({ title: '다음 주의 나에게 선물하기', description: '다음 주에 해보고 싶은 작은 일들을 생각하는 중…', tasks: [task('나에게 필요한 쉼을 생각해보기')], reward: '주말 오후의 작은 피크닉', isExample: true }),
    makeQuest({ title: '오늘의 한 페이지 남기기', category: '나를 위한 일', description: '평범한 하루에도 기억하고 싶은 장면은 있으니까.', status: 'completed', tasks: [task('오늘 고마웠던 일 세 가지 적기', 'free', true)], reward: '따뜻한 차와 함께 쉬는 시간', createdAt: ago(4), updatedAt: ago(3), rewardRecord: { note: '차를 마시면서 오늘을 돌아봤다. 작은 일들을 해낸 나에게 고맙다고 말해주었다.', photo: null, claimedAt: ago(3) }, isExample: true })
  ];
}
