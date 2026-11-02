import { makeQuest, uid, progress, matchesPriority, isUnlocked, normalizeTasks, toggleTask, toggleGoal, startQuest, canClaim, claimReward, validateQuests, exampleQuests } from './domain.js';
import { getQuestView } from './list-view.js';
import { WEEKDAYS, localDateKey, calendarDate, recurrenceLabel, recurrenceCounts, occurrenceState, recordOccurrence } from './recurrence.js';
import { loadQuests, saveQuests, loadAccountJournal, saveAccountJournal } from './storage.js';
import { JournalSync, signature } from './sync.js';
import { createCloud } from './cloud.js';
import { cloudConfig } from './config.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const state = { quests: [], tab: 'active', activeSort: 'newest', priorityFilter: 'all', selectedId: null, query: '', editorId: null, rewardId: null, occurrenceDate: localDateKey(), ready: false };
const categoryIcons = { '일상': 'leaf', '공부': 'book', '건강': 'spark', '나를 위한 일': 'gift' };
let writeQueue = Promise.resolve();
let draftTimer, toastTimer, editorTasks = [], rewardPhoto = null, photoJob = 0, photoPending = false;
let detailPhotoUrl, previewPhotoUrl, installPrompt, confirmCallback;
let cloud, accountUser = null, cloudPhase = 'local', cloudMessage = '', syncTimer;
let editLock = false, accountSwitching = false, deferredSession, authQueue = Promise.resolve();
let guestCount = 0;
let authMode = 'signin';
const journal = new JournalSync({
  disk: { loadGuest: loadQuests, saveGuest: saveQuests, loadAccount: loadAccountJournal, saveAccount: saveAccountJournal },
  onChange: quests => { state.quests = quests; if (state.ready) render(); },
  onStatus: (phase, message = '') => { cloudPhase = phase; cloudMessage = message; renderCloudStatus(); },
  onConflict: ({ copied }) => toast(copied
    ? '다른 기기에서도 바뀐 기록을 확인했어요. 서버 기록을 유지하고, 내 수정본은 별도 퀘스트로 보관했어요.'
    : '다른 기기에서 바뀐 최신 기록을 유지했어요. 내용을 확인한 뒤 다시 삭제해주세요.')
});

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const box = $('#toast');
  box.className = `toast${error ? ' error' : ''}`;
  box.innerHTML = `${error ? icon('spark') : '<img src="./assets/guide.png" alt="루미">'}<span>${escape(message)}</span>`;
  box.hidden = false;
  toastTimer = setTimeout(() => { box.hidden = true; }, error ? 7000 : 5000);
}

function setSaveStatus(message) {
  $('.local-label').innerHTML = `<span class="status-dot"></span>${escape(message)}`;
}

// Serialize writes so a slow photo save cannot overwrite a more recent checkbox edit.
function updateQuests(mutator, shouldRender = true, scope = journal.scope) {
  const operation = writeQueue.then(async () => {
    setSaveStatus('일지를 저장하고 있어요');
    await journal.mutate(quests => {
      if (journal.scope !== scope) throw new Error('계정이 바뀌었어요. 현재 일지를 확인한 뒤 다시 시도해주세요.');
      mutator(quests);
    });
    state.quests = journal.quests;
    if (accountUser) cloudPhase = 'pending';
    renderCloudStatus();
    if (shouldRender) render();
    scheduleSync();
  });
  writeQueue = operation.catch(() => { setSaveStatus('저장을 다시 시도해주세요'); });
  return operation;
}

function replaceQuest(quests, quest) {
  const index = quests.findIndex(item => item.id === quest.id);
  if (index < 0) quests.unshift(quest); else quests[index] = quest;
}

function render() {
  const counts = Object.fromEntries(['draft', 'active', 'completed', 'recurring'].map(status => [status, state.quests.filter(q => q.status === status).length]));
  const ready = state.quests.filter(canClaim).length;
  $('#stats-strip').innerHTML = [
    ['book', '진행 중인 모험', counts.active, '한 걸음씩, 꾸준히', ''],
    ['gift', '나를 기다리는 보상', ready, '충분히 잘해냈어요', 'gold'],
    ['check', '완료한 퀘스트', counts.completed, '쌓여가는 작은 성취', '']
  ].map(([name, label, count, note, color]) => `<div class="stat"><span class="stat-icon ${color}">${icon(name)}</span><div><p class="stat-label">${label}</p><p class="stat-number">${count}<small>개</small></p></div><span class="stat-note">${note}</span></div>`).join('');
  document.querySelectorAll('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === state.tab;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.querySelector('span').textContent = counts[button.dataset.tab];
  });
  const activeNav = state.tab === 'completed' ? 'rewards' : state.tab === 'recurring' ? 'recurring' : 'journal';
  document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === activeNav));
  $('#reward-nav-count').textContent = counts.completed;
  $('#recurring-nav-count').textContent = counts.recurring;
  $('#list-title').textContent = { draft: '아직 쓰고 있는 이야기', active: '진행 중인 퀘스트', completed: '해낸 모험과 받은 선물', recurring: '꾸준히 이어가는 모험' }[state.tab];
  $('#quest-list-panel').setAttribute('aria-labelledby', `tab-${state.tab}`);
  const view = getQuestView(state.quests, state);
  const filtered = view.quests;
  $('#quest-filter').value = state.priorityFilter;
  $('#quest-list-controls').hidden = !view.controlsVisible;
  $('#quest-sort').value = state.activeSort;
  if (!filtered.some(q => q.id === state.selectedId)) state.selectedId = filtered[0]?.id || null;
  const constrained = view.constrained;
  $('#list-count').textContent = constrained ? `${filtered.length} / ${view.total}개의 이야기` : `${filtered.length}개의 이야기`;
  $('#quest-list').innerHTML = filtered.length ? filtered.map(renderCard).join('') : renderEmptyList();
  const selected = filtered.find(q => q.id === state.selectedId);
  if (detailPhotoUrl) { URL.revokeObjectURL(detailPhotoUrl); detailPhotoUrl = null; }
  $('#quest-detail').innerHTML = selected ? renderDetail(selected) : constrained
    ? `<div class="empty-state empty-detail">${icon('search')}<h3>조건에 맞는 퀘스트가 없어요</h3><p>검색어나 중요·긴급 필터를 바꿔보세요.</p></div>`
    : `<div class="empty-state empty-detail">${icon('book')}<h3>다음 모험을 기다리는 페이지</h3><p>작은 일 하나부터 시작해볼까요?<br>나만의 퀘스트를 만들고 이야기를 채워보세요.</p><button class="button button-outline" data-action="new">${icon('plus')}새 퀘스트 만들기</button></div>`;
}

function renderQuestFlags(quest) {
  const flags = [];
  if (quest.important) flags.push(`<span class="quest-flag quest-flag-important" role="img" aria-label="중요" title="중요한 퀘스트">${icon('star')}</span>`);
  if (quest.urgent) flags.push(`<span class="quest-flag quest-flag-urgent" role="img" aria-label="긴급" title="긴급한 퀘스트">${icon('bolt')}</span>`);
  return flags.length ? `<span class="quest-flags">${flags.join('')}</span>` : '';
}

function renderCard(q) {
  if (q.status === 'recurring') return renderRecurringCard(q);
  const p = progress(q);
  const ready = canClaim(q);
  const caption = q.status === 'draft' ? '이야기를 쓰고 있어요' : q.status === 'completed' ? '나에게 선물을 건넸어요' : ready ? '보상을 받을 수 있어요' : q.tasks.length ? `${p.done} / ${p.total} 발걸음 완료` : '완료를 기다리는 퀘스트예요';
  return `<button class="quest-card${state.selectedId === q.id ? ' selected' : ''}" data-quest="${escape(q.id)}" aria-pressed="${state.selectedId === q.id}"><div class="card-meta">${icon(categoryIcons[q.category])}${escape(q.category)} 퀘스트${q.isExample ? '<span class="sample-badge">예시</span>' : ''}</div><h3 class="quest-card-title">${renderQuestFlags(q)}<span class="quest-card-title-text">${escape(q.title || '이름을 기다리는 퀘스트')}</span></h3><div class="card-progress"><div class="progress-track"><span style="width:${p.percent}%"></span></div><span>${p.percent}%</span></div><div class="card-bottom${ready ? ' ready' : q.status === 'completed' ? ' complete' : ''}">${icon(q.status === 'draft' ? 'edit' : ready ? 'gift' : q.status === 'completed' ? 'check' : 'leaf')}${caption}</div></button>`;
}

function renderEmptyList() {
  if (state.tab === 'active' && state.priorityFilter !== 'all') return `<div class="empty-state">${icon('search')}<h3>조건에 맞는 퀘스트가 없어요</h3><p>검색어나 중요·긴급 필터를 바꿔보세요.</p><button class="text-button" data-action="clear-filters">${state.query.trim() ? '필터·검색 초기화' : '전체 퀘스트 보기'}</button></div>`;
  if (state.query.trim()) return `<div class="empty-state">${icon('search')}<h3>아직 찾지 못했어요</h3><p>다른 단어로 퀘스트를 찾아보세요.</p><button class="text-button" data-action="clear-search">검색 지우기</button></div>`;
  const copy = { draft: ['아직 빈 페이지예요', '새 퀘스트를 쓰다가 잠시 쉬어가도 괜찮아요.'], active: ['새 모험을 시작해볼까요?', '오늘 해보고 싶은 아주 작은 일부터 적어보세요.'], completed: ['선물을 기다리는 페이지', '퀘스트를 마치고 보상을 기록하면 여기에 모여요.'], recurring: ['작은 습관을 모험으로', '새 퀘스트에서 반복퀘스트를 선택하고, 나만의 요일을 정해보세요.'] }[state.tab];
  return `<div class="empty-state">${icon(state.tab === 'completed' ? 'gift' : 'book')}<h3>${copy[0]}</h3><p>${copy[1]}</p><button class="button button-outline button-small" data-action="new">${icon('plus')}퀘스트 만들기</button></div>`;
}

function renderDetail(q) {
  if (q.status === 'recurring') return renderRecurringDetail(q);
  const p = progress(q), ready = canClaim(q), solo = !q.tasks.length;
  const record = q.rewardRecord;
  if (record?.photo) detailPhotoUrl = URL.createObjectURL(record.photo.blob);
  let chainIndex = 0;
  const tasks = q.tasks.map(task => {
    const unlocked = isUnlocked(q, task.id), chain = task.kind === 'chain';
    if (chain) chainIndex++;
    const disabled = q.status !== 'active' || !unlocked;
    const inputId = `task-${q.id}-${task.id}`;
    return `<label class="task-item${task.done ? ' done' : ''}${!unlocked ? ' locked' : ''}" for="${escape(inputId)}"><input id="${escape(inputId)}" type="checkbox" data-task="${escape(task.id)}" data-parent="${escape(q.id)}" ${task.done ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${!unlocked ? 'title="앞선 연계 퀘스트를 먼저 완료해주세요"' : ''}><span class="task-text"><span class="task-kind">${icon(chain ? 'chain' : 'leaf')}${chain ? `연계 퀘스트 ${String(chainIndex).padStart(2, '0')}${!unlocked ? ' · 앞선 연계 퀘스트 완료 후 진행' : ''}` : '하위 퀘스트 · 자유롭게'}</span>${escape(task.title || '아직 작성하지 않은 발걸음')}</span>${!unlocked ? icon('lock').replace('class="icon"', 'class="icon task-status-icon"') : task.done ? icon('check').replace('class="icon"', 'class="icon task-status-icon"') : ''}</label>`;
  }).join('');
  const goalInputId = `goal-${q.id}`;
  const checklist = solo ? `<label class="task-item${q.goalDone ? ' done' : ''}" for="${escape(goalInputId)}"><input id="${escape(goalInputId)}" type="checkbox" data-goal="${escape(q.id)}" ${q.goalDone ? 'checked' : ''} ${q.status !== 'active' ? 'disabled' : ''}><span class="task-text"><span class="task-kind">${icon('check')}퀘스트 완료</span>${escape(q.title || '이름을 기다리는 퀘스트')}</span>${q.goalDone ? icon('check').replace('class="icon"', 'class="icon task-status-icon"') : ''}</label>` : tasks;
  const progressCaption = solo ? (q.goalDone ? '퀘스트를 해냈어요' : q.status === 'draft' ? '시작을 기다리고 있어요' : '할 일을 마친 뒤 완료를 체크해주세요') : `${p.done} / ${p.total} 발걸음 완료`;
  const checklistHint = q.status === 'draft' ? '시작한 뒤 체크할 수 있어요' : q.status === 'completed' ? '퀘스트를 마쳤어요' : solo ? '해냈다면 체크해주세요' : '한 가지씩, 나의 속도로';
  const rewardHint = ready ? `${solo ? '퀘스트를 해냈어요.' : '모든 발걸음을 마쳤어요.'} 이제 보상을 받고 기록해주세요.` : solo ? '퀘스트 완료를 체크하면 보상을 받을 수 있어요.' : '모든 발걸음을 마치면 보상을 받을 수 있어요.';
  const created = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(record?.claimedAt || q.createdAt));
  return `<button class="back-to-list" data-action="back">${icon('arrow')}퀘스트 목록으로</button><div class="detail-topline"><span class="detail-category">${icon(categoryIcons[q.category])}${escape(q.category)} 퀘스트 <span>· ${q.status === 'draft' ? '작성 중' : q.status === 'completed' ? '모험 완료' : ready ? '보상 대기' : '모험 중'}</span></span><div class="detail-actions">${q.status !== 'completed' ? `<button class="icon-button" data-action="edit" aria-label="퀘스트 편집" title="퀘스트 편집">${icon('edit')}</button>` : ''}<button class="icon-button" data-action="delete" aria-label="퀘스트 삭제" title="퀘스트 삭제">${icon('trash')}</button></div></div><h2 class="detail-title" id="detail-title" tabindex="-1">${escape(q.title || '이름을 기다리는 퀘스트')}</h2><p class="detail-description">${escape(q.description || (q.status === 'draft' ? '아직 쓰고 있는 이야기예요. 편집을 이어서 하고 모험을 시작해보세요.' : '아주 작은 발걸음도 소중한 모험이에요.'))}</p><div class="detail-progress"><div class="detail-progress-label"><span>나의 모험 진행도</span><strong>${p.percent}<span style="font-size:10px"> %</span></strong></div><div class="progress-track" role="progressbar" aria-label="퀘스트 진행도" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}"><span style="width:${p.percent}%"></span></div><p class="detail-progress-caption">${progressCaption}</p></div><h3 class="section-label">${icon('book')}${solo ? '퀘스트 완료 체크' : '작은 발걸음'}<span>${checklistHint}</span></h3><div class="task-list">${checklist}</div><div class="reward-box"><div class="reward-label">${icon('gift')}${record ? '내가 나에게 건넨 선물' : '이 모험 끝에 기다리는 선물'}</div><h3 class="reward-name">${escape(q.reward || '어떤 선물을 받고 싶나요?')}</h3><p class="reward-hint">${record ? `${created} · 보상을 받은 순간을 기록했어요` : rewardHint}</p>${record?.note ? `<p class="reward-note">${escape(record.note)}</p>` : ''}${detailPhotoUrl ? `<img class="reward-photo" src="${detailPhotoUrl}" alt="내가 받은 보상 사진">` : ''}</div><div class="detail-footer"><span class="detail-date">${record ? '모험을 마친 날' : '모험을 적은 날'} ${created}</span>${q.status === 'draft' ? `<button class="button button-green" data-action="edit">${icon('edit')}이어서 작성하기</button>` : q.status === 'completed' ? '<span class="field-hint">✧ 잘해냈어요, 나의 모험가님.</span>' : `<button class="button ${ready ? 'button-gold' : 'button-outline'}" data-action="claim" ${ready ? '' : 'disabled'}>${icon(ready ? 'gift' : 'lock')}${ready ? '나에게 보상 주기' : '모험을 마치면 보상 받기'}</button>`}</div>${q.isExample ? `<p class="example-notice">${icon('spark')}사용법을 익히기 위한 예시예요. 설정에서 정리할 수 있어요.</p>` : ''}`;
}

function switchTab(tab) {
  state.tab = tab; state.query = ''; state.selectedId = null;
  state.occurrenceDate = localDateKey();
  $('#quest-search').value = '';
  $('#journal-body').classList.remove('show-detail');
  render();
}

function renderRecurringCard(q) {
  const counts = recurrenceCounts(q), today = occurrenceState(q);
  const caption = today.outcome === 'success' ? '오늘은 성공했어요' : today.outcome === 'failure' ? '오늘의 실패를 기록했어요' : today.scheduled ? '오늘의 기록을 기다려요' : '오늘은 쉬어가는 날이에요';
  return `<button class="quest-card${state.selectedId === q.id ? ' selected' : ''}" data-quest="${escape(q.id)}" aria-pressed="${state.selectedId === q.id}"><div class="card-meta">${icon('repeat')}반복퀘스트 · ${escape(q.category)}</div><h3 class="quest-card-title">${renderQuestFlags(q)}<span class="quest-card-title-text">${escape(q.title)}</span></h3><p class="recurring-card-days">${recurrenceLabel(q.recurrence)}</p><div class="recurring-card-counts"><span>성공 <strong>${counts.success}</strong>회</span><span>실패 <strong>${counts.failure}</strong>회</span></div><div class="card-bottom${today.outcome === 'success' ? ' complete' : ''}">${icon(today.outcome === 'success' ? 'check' : 'repeat')}${caption}</div></button>`;
}

function renderRecurringDetail(q) {
  const counts = recurrenceCounts(q), date = state.occurrenceDate;
  const occurrence = occurrenceState(q, date), today = localDateKey();
  const dateLabel = `${date.replaceAll('-', '. ')}. (${WEEKDAYS[calendarDate(date).getUTCDay()]})`;
  const status = occurrence.outcome === 'success' ? '성공으로 기록했어요' : occurrence.outcome === 'failure' ? '실패로 기록했어요' : '아직 기록하지 않았어요';
  const history = [...q.recurrence.history].reverse().slice(0, 7);
  const hint = occurrence.available ? '다른 결과를 누르면 수정하고, 같은 결과를 다시 누르면 취소해요.' : '시작한 날부터 오늘까지, 반복하는 요일을 선택해주세요.';
  return `<button class="back-to-list" data-action="back">${icon('arrow')}퀘스트 목록으로</button>
    <div class="detail-topline"><span class="detail-category">${icon('repeat')}${escape(q.category)} 퀘스트 · 매주 이어가기</span><div class="detail-actions"><button class="icon-button" data-action="edit" aria-label="퀘스트 편집">${icon('edit')}</button><button class="icon-button" data-action="delete" aria-label="퀘스트 삭제">${icon('trash')}</button></div></div>
    <h2 class="detail-title" id="detail-title" tabindex="-1">${escape(q.title)}</h2><p class="detail-description">${escape(q.description || '작은 반복이 모여, 나다운 하루를 만들어요.')}</p>
    <div class="recurring-schedule">${icon('repeat')}<span>${recurrenceLabel(q.recurrence)}</span></div>
    <dl class="recurring-totals"><div><dt>성공</dt><dd>${counts.success}<small>회</small></dd></div><div><dt>실패</dt><dd>${counts.failure}<small>회</small></dd></div></dl>
    <section class="occurrence-panel" aria-labelledby="occurrence-heading"><h3 id="occurrence-heading">이번 모험의 기록</h3><label class="occurrence-date" for="occurrence-date">기록할 날짜<input id="occurrence-date" type="date" value="${date}" min="${localDateKey(new Date(q.createdAt))}" max="${today}"></label>
      <p class="occurrence-status">${dateLabel} · ${status}</p>
      <div class="occurrence-actions" role="group" aria-label="성공 또는 실패 기록"><button class="outcome-button outcome-success" data-outcome="success" aria-pressed="${occurrence.outcome === 'success'}" ${occurrence.available ? '' : 'disabled'}>${icon('check')}성공했어요</button><button class="outcome-button outcome-failure" data-outcome="failure" aria-pressed="${occurrence.outcome === 'failure'}" ${occurrence.available ? '' : 'disabled'}>${icon('close')}실패했어요</button></div>
      <p class="field-hint">${hint}</p><p class="field-hint">하루에 한 번 기록해요. 기록하지 않은 날은 횟수에 포함하지 않아요.</p>
    </section>
    ${q.tasks.length ? `<h3 class="section-label recurring-steps">${icon('leaf')}매번 해볼 작은 발걸음</h3><ol class="recurring-task-list">${q.tasks.map(task => `<li>${escape(task.title)}</li>`).join('')}</ol>` : ''}
    <div class="reward-box"><div class="reward-label">${icon('gift')}성공한 날, 나에게 약속한 선물</div><h3 class="reward-name">${escape(q.reward)}</h3></div>
    <section class="recurring-history" aria-labelledby="history-heading"><h3 id="history-heading" class="section-label">${icon('book')}최근 기록 <span>최근 7회 · 날짜를 눌러 수정</span></h3>${history.length ? `<ul>${history.map(record => `<li><button data-record-date="${record.date}" aria-label="${record.date} 기록 수정"><time datetime="${record.date}">${record.date.replaceAll('-', '. ')}.</time><span class="history-${record.outcome}">${record.outcome === 'success' ? '성공' : '실패'}</span></button></li>`).join('')}</ul>` : '<p class="field-hint">첫 번째 기록을 기다리고 있어요.</p>'}</section>`;
}

function renderRepeatEditor() {
  const repeating = $('#edit-recurring').checked;
  $('#repeat-days').disabled = !repeating;
  $('#repeat-options').classList.toggle('is-disabled', !repeating);
  const days = [...document.querySelectorAll('[name="repeat-day"]:checked')].map(input => Number(input.value));
  $('#repeat-summary').textContent = repeating ? recurrenceLabel({ days }) : '반복퀘스트를 선택하면 요일을 정할 수 있어요.';
  $('#start-quest-label').textContent = repeating ? '반복퀘스트 시작하기' : '퀘스트 시작하기';
  $('#edit-tasks-hint').textContent = repeating ? '매번 해볼 작은 할 일을 적어보세요. 성공·실패는 퀘스트 전체를 기준으로 기록해요.' : '할 일이 하나라면 추가하지 않아도 돼요. 비워 둔 항목은 시작할 때 제외해요. 하위 퀘스트는 자유롭게, 연계 퀘스트는 순서대로 체크해요.';
  $('#edit-reward-hint').textContent = repeating ? '성공한 날 나에게 건넬 작은 선물을 적어주세요.' : '퀘스트를 마치면 받을 수 있는 나만의 선물이에요.';
}

function renderEditorTasks() {
  $('#edit-tasks').innerHTML = editorTasks.map((task, index) => `<div class="edit-task" data-row="${escape(task.id)}"><span class="task-number">${String(index + 1).padStart(2, '0')}</span><select aria-label="${index + 1}번째 발걸음 종류"><option value="free"${task.kind === 'free' ? ' selected' : ''}>하위</option><option value="chain"${task.kind === 'chain' ? ' selected' : ''}>연계</option></select><input type="text" maxlength="160" value="${escape(task.title)}" aria-label="${index + 1}번째 발걸음 내용" placeholder="작고 구체적인 할 일을 적어보세요"><button type="button" class="icon-button" data-move-task="${escape(task.id)}" aria-label="${index + 1}번째 발걸음 위로 이동" ${index ? '' : 'disabled'}><svg class="icon" style="transform:rotate(-90deg)" aria-hidden="true"><use href="#i-arrow"/></svg></button><button type="button" class="icon-button" data-remove-task="${escape(task.id)}" aria-label="${index + 1}번째 발걸음 삭제">${icon('close')}</button></div>`).join('');
  document.querySelectorAll('[data-add-task]').forEach(button => { button.disabled = editorTasks.length >= 100; });
}

function readEditorTasks() {
  editorTasks = [...$('#edit-tasks').children].map(row => {
    const previous = editorTasks.find(task => task.id === row.dataset.row);
    return { id: row.dataset.row, title: row.querySelector('input').value, kind: row.querySelector('select').value, done: previous?.done || false };
  });
  editorTasks = normalizeTasks(editorTasks);
}

function readDraft() {
  readEditorTasks();
  const original = state.quests.find(q => q.id === state.editorId);
  if (!original) throw new Error('작성 중인 퀘스트를 찾을 수 없어요.');
  return { ...original, title: $('#edit-title').value, description: $('#edit-description').value,
    category: $('#edit-category').value, reward: $('#edit-reward').value,
    important: $('#edit-important').checked, urgent: $('#edit-urgent').checked,
    recurrence: $('#edit-recurring').checked ? { days: [...document.querySelectorAll('[name="repeat-day"]:checked')].map(input => Number(input.value)), history: original.recurrence?.history || [] } : null,
    tasks: structuredClone(editorTasks), goalDone: !editorTasks.length && original.goalDone === true, status: 'draft', isExample: false,
    updatedAt: new Date().toISOString(), rewardRecord: null };
}

async function saveDraft() {
  clearTimeout(draftTimer);
  if (!state.editorId) return;
  const draft = readDraft();
  $('#autosave-status').textContent = '일지를 저장하고 있어요…';
  try {
    await updateQuests(quests => replaceQuest(quests, draft));
    $('#autosave-status').textContent = '작성 중인 일지를 저장했어요';
    return draft;
  } catch (error) {
    $('#autosave-status').textContent = '아직 저장되지 않았어요';
    showError('editor-error', error.message);
    throw error;
  }
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  $('#autosave-status').textContent = '작성 내용을 기록하고 있어요…';
  draftTimer = setTimeout(() => saveDraft().catch(() => {}), 400);
}

async function openEditor(id) {
  editLock = true;
  try { await journal.running; } catch { /* Local drafts remain available. */ }
  await writeQueue;
  let quest = state.quests.find(q => q.id === id);
  if (quest?.status === 'completed') { finishEditing(); return; }
  if (!quest) { quest = makeQuest(state.tab === 'recurring' ? { recurrence: { days: [], history: [] } } : {}); state.priorityFilter = 'all'; }
  quest = { ...quest, status: 'draft', rewardRecord: null };
  await updateQuests(quests => replaceQuest(quests, quest), false);
  state.editorId = quest.id; state.selectedId = quest.id; state.tab = 'draft'; state.query = '';
  $('#quest-search').value = '';
  $('#editor-title').textContent = id ? '나의 퀘스트 다듬기' : '나만의 퀘스트 만들기';
  $('#edit-title').value = quest.title; $('#edit-description').value = quest.description;
  $('#edit-category').value = quest.category; $('#edit-reward').value = quest.reward;
  $('#edit-important').checked = quest.important === true; $('#edit-urgent').checked = quest.urgent === true;
  $('#edit-recurring').checked = !!quest.recurrence;
  const hasRecords = !!quest.recurrence?.history.length;
  $('#edit-recurring').disabled = hasRecords;
  $('#repeat-type-hint').textContent = hasRecords ? '기록이 있는 퀘스트는 반복 설정을 유지해요. 요일은 바꿀 수 있어요.' : '매주 정해진 요일에 같은 모험을 이어가요.';
  document.querySelectorAll('[name="repeat-day"]').forEach(input => { input.checked = quest.recurrence?.days.includes(Number(input.value)) === true; });
  renderRepeatEditor();
  editorTasks = structuredClone(quest.tasks); renderEditorTasks();
  $('#editor-error').hidden = true; $('#autosave-status').textContent = '작성 내용은 자동으로 저장돼요';
  render(); $('#editor-dialog').showModal(); $('#edit-title').focus();
}

async function closeDialog(id) {
  if (id === 'editor-dialog' && state.editorId) {
    try { await saveDraft(); } catch { return; }
    state.editorId = null;
  }
  document.getElementById(id).close();
  if (id === 'editor-dialog') finishEditing();
}

function showError(id, message) {
  const error = document.getElementById(id);
  error.textContent = message; error.hidden = false;
}

function askConfirm(title, message) {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
  $('#confirm-dialog').showModal();
  return new Promise(resolve => { confirmCallback = resolve; });
}

async function openReward() {
  editLock = true;
  try { await journal.running; } catch { /* Use the locally saved journal. */ }
  await writeQueue;
  const quest = state.quests.find(q => q.id === state.selectedId);
  if (!quest || !canClaim(quest)) { finishEditing(); return; }
  state.rewardId = quest.id; rewardPhoto = null; photoPending = false; photoJob++;
  $('#reward-name').textContent = quest.reward;
  $('#reward-note').value = ''; $('#reward-photo').value = '';
  $('#reward-error').hidden = true; $('#claim-submit').disabled = false;
  clearPhotoPreview(); $('#reward-dialog').showModal();
}

function clearPhotoPreview() {
  if (previewPhotoUrl) { URL.revokeObjectURL(previewPhotoUrl); previewPhotoUrl = null; }
  $('#photo-preview').hidden = true; $('#photo-preview').innerHTML = '';
}

async function compressPhoto(file) {
  if (!/^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp)$/.test(file.type)) throw new Error('JPG, PNG, WebP 등 브라우저에서 열 수 있는 사진을 선택해주세요.');
  if (file.size > 20 * 1024 * 1024) throw new Error('20MB보다 작은 사진을 선택해주세요.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('사진을 읽지 못했어요.');
    const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
    if (!blob) throw new Error('사진을 저장할 수 없어요. 다른 사진을 선택해주세요.');
    return { blob, name: `${file.name.replace(/\.[^.]+$/, '').slice(0, 240)}.jpg` };
  } catch (error) {
    if (error instanceof DOMException) throw new Error('이 사진 형식을 열 수 없어요. JPG나 PNG 사진으로 다시 시도해주세요.');
    throw error;
  } finally { URL.revokeObjectURL(url); }
}

const helpMessages = {
  welcome: '안녕하세요, 모험가님! 저는 작은 모험의 길잡이 루미예요.\n무엇이든 편하게 물어보세요. 오늘도 당신의 속도로 나아가면 충분해요.',
  start: '‘새 퀘스트 만들기’를 누르고, 이름과 나를 위한 보상을 적어주세요. 작은 발걸음은 필요할 때만 추가하면 돼요.\n‘퀘스트 시작하기’를 누르면 모험이 시작돼요! 다 쓰지 못해도 작성 중 탭에 자동으로 보관해드려요.',
  chain: '하위 퀘스트는 순서 없이 자유롭게 체크해요.\n연계 퀘스트는 앞선 연계 퀘스트를 마쳐야 다음 것을 체크할 수 있어요. 앞 단계를 해제하면 뒤의 연계 단계도 함께 해제돼요. 하위 퀘스트에는 영향을 주지 않아요.',
  reward: '퀘스트를 완료하면 ‘나에게 보상 주기’가 열려요. 발걸음이 없으면 퀘스트 완료를 한 번 체크해주세요.\n보상을 받은 순간을 글이나 사진으로 남기면 완료됨 탭과 보상 보관함에 소중히 보관돼요. 100%를 달성해도 보상을 기록하기 전까지는 진행 중이에요.',
  save: '로그인 전에는 지금 쓰는 브라우저에 기록을 보관해요. 이메일 계정으로 로그인하면 같은 계정의 퀘스트와 사진을 다른 기기에서도 이어서 볼 수 있어요.\n오프라인에서 수정한 내용은 이 기기에 보관했다가 연결되면 동기화해요. 동기화 전에는 브라우저 데이터를 지우지 말아주세요.',
  install: '설치 없이 이 링크에서 바로 쓸 수 있어요. 브라우저 메뉴의 ‘앱 설치’나 ‘홈 화면에 추가’로 앱처럼 사용할 수도 있고요.\n인터넷이 연결된 상태에서 한 번 열어둔 뒤에는 오프라인에서도 쓸 수 있어요. 처음 준비에는 잠시 시간이 필요해요.'
};

async function exportJournal() {
  await writeQueue;
  const quests = await Promise.all(state.quests.map(async quest => {
    const copy = structuredClone(quest);
    if (copy.rewardRecord?.photo) {
      const photo = copy.rewardRecord.photo;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('보상 사진을 백업하지 못했어요.')); reader.readAsDataURL(photo.blob);
      });
      copy.rewardRecord.photo = { name: photo.name, dataUrl };
    }
    return copy;
  }));
  const blob = new Blob([JSON.stringify({ format: 'quest-maker', version: 1, exportedAt: new Date().toISOString(), quests }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `quest-maker-${new Date().toLocaleDateString('sv-SE')}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('나의 모험을 백업 파일로 저장했어요.');
}

async function importJournal(file) {
  const scope = journal.scope;
  if (file.size > 64 * 1024 * 1024) throw new Error('64MB보다 작은 백업 파일을 선택해주세요.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('읽을 수 있는 JSON 백업 파일을 선택해주세요.'); }
  if (data?.format !== 'quest-maker' || data.version !== 1 || !Array.isArray(data.quests)) throw new Error('Quest Maker에서 저장한 백업 파일을 선택해주세요.');
  for (const quest of data.quests) {
    if (quest?.rewardRecord?.photo) {
      const photo = quest.rewardRecord.photo;
      if (typeof photo.dataUrl !== 'string' || photo.dataUrl.length > 14 * 1024 * 1024) throw new Error('백업 사진의 크기나 형식을 확인해주세요.');
      const match = photo.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/);
      if (!match) throw new Error('백업에 읽을 수 없는 사진이 있어요.');
      const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
      quest.rewardRecord.photo = { name: photo.name, blob: new Blob([bytes], { type: match[1] }) };
    }
  }
  const incoming = validateQuests(data.quests).map(q => ({ ...q, updatedAt: new Date().toISOString() }));
  await updateQuests(quests => {
    for (const quest of incoming) replaceQuest(quests, quest);
  }, true, scope);
  toast(`${incoming.length}개의 퀘스트를 일지에 불러왔어요.`);
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button, [data-close]');
  if (!target || target.disabled) return;
  try {
    if (target.dataset.close) { await closeDialog(target.dataset.close); return; }
    if (target.dataset.topic) { $('#npc-message').textContent = helpMessages[target.dataset.topic]; return; }
    if (target.dataset.authMode) { setAuthMode(target.dataset.authMode); return; }
    if (!state.ready) return;
    if (accountSwitching) { toast('계정의 일지를 여는 중이에요. 잠시만 기다려주세요.'); return; }
    if (target.dataset.tab) { switchTab(target.dataset.tab); return; }
    if (target.dataset.nav) { switchTab({ journal: 'active', rewards: 'completed', recurring: 'recurring' }[target.dataset.nav]); return; }
    if (target.dataset.quest) {
      state.selectedId = target.dataset.quest; state.occurrenceDate = localDateKey(); render();
      $('#journal-body').classList.add('show-detail');
      if (matchMedia('(max-width:720px)').matches) $('#detail-title')?.focus({ preventScroll: true });
      return;
    }
    if (target.dataset.outcome) {
      const id = state.selectedId, date = state.occurrenceDate, outcome = target.dataset.outcome;
      target.disabled = true;
      await updateQuests(quests => {
        const index = quests.findIndex(q => q.id === id);
        if (index < 0) throw new Error('퀘스트를 찾지 못했어요.');
        const previous = occurrenceState(quests[index], date).outcome;
        quests[index] = recordOccurrence(quests[index], date, previous === outcome ? null : outcome);
      });
      $(`[data-outcome="${outcome}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (target.dataset.recordDate) {
      state.occurrenceDate = target.dataset.recordDate; render(); $('#occurrence-date').focus({ preventScroll: true }); return;
    }
    if (target.dataset.addTask) {
      readEditorTasks();
      if (editorTasks.length >= 100) return;
      editorTasks.push({ id: uid(), title: '', kind: target.dataset.addTask, done: false });
      renderEditorTasks(); $('#edit-tasks').lastElementChild.querySelector('input').focus(); scheduleDraft(); return;
    }
    if (target.dataset.removeTask || target.dataset.moveTask) {
      readEditorTasks();
      const id = target.dataset.removeTask || target.dataset.moveTask;
      const index = editorTasks.findIndex(task => task.id === id);
      if (target.dataset.removeTask) editorTasks.splice(index, 1);
      else if (index > 0) [editorTasks[index - 1], editorTasks[index]] = [editorTasks[index], editorTasks[index - 1]];
      editorTasks = normalizeTasks(editorTasks); renderEditorTasks(); scheduleDraft(); return;
    }
    const action = target.dataset.action;
    if (action === 'new' || action === 'edit') {
      try { await openEditor(action === 'edit' ? state.selectedId : undefined); }
      catch (error) { finishEditing(); throw error; }
    }
    if (action === 'claim') await openReward();
    if (action === 'back') $('#journal-body').classList.remove('show-detail');
    if (action === 'clear-search') { state.query = ''; $('#quest-search').value = ''; render(); $('#quest-search').focus(); }
    if (action === 'clear-filters') {
      state.priorityFilter = 'all'; state.query = ''; $('#quest-search').value = '';
      render(); $('#quest-filter').focus();
    }
    if (action === 'help') { $('#npc-message').textContent = helpMessages.welcome; $('#help-dialog').showModal(); }
    if (action === 'settings') {
      renderCloudStatus();
      $('#install-button').hidden = !installPrompt;
      if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('#install-description').textContent = '지금 앱 모드로 사용하고 있어요. 인터넷 없이도 나만의 일지를 이어갈 수 있어요.';
      $('#settings-dialog').showModal();
    }
    if (action === 'export') await exportJournal();
    if (action === 'cloud-login') {
      await writeQueue;
      if (!cloud) throw new Error('로그인 연결 설정을 확인해주세요.');
      setAuthMode('signin');
      $('#auth-password').value = '';
      $('#auth-dialog').showModal();
      $('#auth-email').focus();
    }
    if (action === 'cloud-logout') {
      await writeQueue;
      if (journal.pendingCount) toast('동기화 대기 기록은 이 기기에 보관해요. 같은 계정으로 다시 로그인하면 이어서 전송해요.');
      await cloud.signOut();
      await receiveSession(null);
    }
    if (action === 'cloud-sync') await runSync(true);
    if (action === 'cloud-import') await importGuestQuests();
    if (action === 'install' && installPrompt) {
      await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#install-button').hidden = true;
    }
    if (action === 'delete') {
      const id = state.selectedId, quest = state.quests.find(q => q.id === id), scope = journal.scope;
      if (quest && await askConfirm('이 퀘스트를 삭제할까요?', `‘${quest.title || '이름 없는 퀘스트'}’의 진행 상황과 보상 기록이 함께 삭제돼요. 필요하다면 먼저 백업해주세요.`)) {
        await updateQuests(quests => {
          const index = quests.findIndex(q => q.id === id);
          if (index >= 0) quests.splice(index, 1);
        }, true, scope);
        toast('퀘스트를 정리했어요. 새로운 모험을 기다릴게요.');
      }
    }
    if (action === 'clear-examples') {
      const scope = journal.scope;
      if (!state.quests.some(q => q.isExample)) { toast('정리할 예시 퀘스트가 없어요.'); return; }
      if (await askConfirm('예시 퀘스트를 정리할까요?', '‘예시’ 표시가 있는 퀘스트만 삭제해요. 직접 만들거나 편집한 퀘스트는 그대로 보관해요.')) {
        await updateQuests(quests => { for (let index = quests.length - 1; index >= 0; index--) if (quests[index].isExample) quests.splice(index, 1); }, true, scope);
        toast('예시를 정리했어요. 이제 나만의 이야기를 채워보세요.');
      }
    }
    if (action === 'remove-photo') { photoJob++; rewardPhoto = null; photoPending = false; $('#claim-submit').disabled = false; $('#reward-photo').value = ''; clearPhotoPreview(); }
  } catch (error) {
    if (target.dataset.outcome) render();
    toast(error.message || '다시 한 번 시도해주세요.', true);
  }
});

$('#quest-search').addEventListener('input', event => { state.query = event.target.value; render(); });
$('#quest-sort').addEventListener('change', event => { state.activeSort = event.target.value; render(); });
function changeQuestFilter(event) {
  if (!state.ready || state.tab !== 'active' || state.priorityFilter === event.currentTarget.value) return;
  state.priorityFilter = event.currentTarget.value; state.selectedId = null;
  $('#journal-body').classList.remove('show-detail'); render();
}
$('#quest-filter').addEventListener('input', changeQuestFilter);
$('#quest-filter').addEventListener('change', changeQuestFilter);
$('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const current = tabs.findIndex(tab => tab.dataset.tab === state.tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  switchTab(tabs[next].dataset.tab); tabs[next].focus();
});

$('#quest-detail').addEventListener('change', async event => {
  const input = event.target;
  if (input.id === 'occurrence-date') {
    if (input.value && input.validity.valid) state.occurrenceDate = input.value;
    render(); $('#occurrence-date')?.focus({ preventScroll: true }); return;
  }
  if (!input.dataset.task && !input.dataset.goal) return;
  input.disabled = true;
  const focusId = input.id;
  try {
    let finished = false, reset = false;
    await updateQuests(quests => {
      const index = quests.findIndex(q => q.id === (input.dataset.goal || input.dataset.parent));
      if (index < 0) throw new Error('퀘스트를 찾지 못했어요.');
      const before = progress(quests[index]);
      quests[index] = input.dataset.goal ? toggleGoal(quests[index]) : toggleTask(quests[index], input.dataset.task);
      const after = progress(quests[index]);
      finished = canClaim(quests[index]); reset = before.done - after.done > 1;
    });
    document.getElementById(focusId)?.focus({ preventScroll: true });
    if (finished) toast('퀘스트를 해냈네요! 이제 나에게 약속한 선물을 건네주세요.');
    else if (reset) toast('앞선 발걸음을 해제해서 뒤의 연계 퀘스트도 함께 해제했어요.');
  } catch (error) { render(); toast(error.message, true); }
});

$('#quest-form').addEventListener('input', event => {
  if (event.target.id === 'edit-recurring' || event.target.name === 'repeat-day') renderRepeatEditor();
  scheduleDraft();
});
$('#edit-tasks').addEventListener('change', event => {
  if (event.target.tagName === 'SELECT') { readEditorTasks(); renderEditorTasks(); scheduleDraft(); }
});
$('#quest-form').addEventListener('submit', async event => {
  event.preventDefault(); clearTimeout(draftTimer);
  const submit = event.submitter || $('#quest-form button[type="submit"]');
  submit.disabled = true; $('#editor-error').hidden = true;
  try {
    const quest = startQuest(readDraft());
    await updateQuests(quests => replaceQuest(quests, quest), false);
    if (!matchesPriority(quest, state.priorityFilter)) state.priorityFilter = 'all';
    state.editorId = null; state.tab = quest.status; state.selectedId = quest.id; state.occurrenceDate = localDateKey();
    $('#editor-dialog').close(); render(); $('#journal-body').classList.add('show-detail');
    finishEditing();
    toast('새로운 모험의 시작이네요. 나만의 속도로, 한 걸음씩 함께해요!');
  } catch (error) { showError('editor-error', error.message); }
  finally { submit.disabled = false; }
});

$('#reward-photo').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const job = ++photoJob; photoPending = true; $('#claim-submit').disabled = true;
  $('#reward-error').hidden = true;
  try {
    const photo = await compressPhoto(file);
    if (job !== photoJob) return;
    rewardPhoto = photo; clearPhotoPreview(); previewPhotoUrl = URL.createObjectURL(photo.blob);
    $('#photo-preview').innerHTML = `<img src="${previewPhotoUrl}" alt="보상 사진 미리보기"><button type="button" class="icon-button" data-action="remove-photo" aria-label="첨부 사진 삭제">${icon('close')}</button>`;
    $('#photo-preview').hidden = false;
  } catch (error) { if (job === photoJob) { event.target.value = ''; showError('reward-error', error.message); } }
  finally { if (job === photoJob) { photoPending = false; $('#claim-submit').disabled = false; } }
});

$('#reward-form').addEventListener('submit', async event => {
  event.preventDefault(); if (photoPending) return;
  $('#claim-submit').disabled = true; $('#reward-error').hidden = true;
  try {
    const id = state.rewardId, note = $('#reward-note').value, photo = rewardPhoto;
    await updateQuests(quests => {
      const index = quests.findIndex(q => q.id === id);
      if (index < 0) throw new Error('퀘스트를 찾지 못했어요.');
      quests[index] = claimReward(quests[index], note, photo);
    }, false);
    $('#reward-dialog').close(); state.tab = 'completed'; state.selectedId = id; state.query = ''; $('#quest-search').value = '';
    render(); $('#journal-body').classList.add('show-detail');
    toast('정말 잘해냈어요! 노력도, 나에게 준 선물도 오래 기억해둘게요.');
  } catch (error) { showError('reward-error', error.message); }
  finally { $('#claim-submit').disabled = false; }
});

$('#reward-dialog').addEventListener('close', () => { photoJob++; photoPending = false; rewardPhoto = null; state.rewardId = null; clearPhotoPreview(); finishEditing(); });
$('#confirm-accept').addEventListener('click', () => {
  const resolve = confirmCallback; confirmCallback = null; $('#confirm-dialog').close(); resolve?.(true);
});
$('#confirm-dialog').addEventListener('close', () => { const resolve = confirmCallback; confirmCallback = null; resolve?.(false); });
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => { if (dialog.id === 'editor-dialog') { event.preventDefault(); closeDialog(dialog.id); } });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog.id);
  });
});
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { await importJournal(file); } catch (error) { toast(error.message || '백업 파일을 불러오지 못했어요.', true); }
  finally { event.target.value = ''; }
});
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('#install-button').hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-button').hidden = true; });
function updateConnection() { $('#connection-status').textContent = navigator.onLine ? '이 브라우저에 소중히 저장해요' : '오프라인 · 일지를 이어가세요'; }
window.addEventListener('online', () => { updateConnection(); scheduleSync(0); });
window.addEventListener('offline', () => { updateConnection(); renderCloudStatus(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.editorId) saveDraft().catch(() => {}); });
window.addEventListener('beforeunload', event => {
  if (draftTimer && state.editorId && $('#autosave-status').textContent !== '작성 중인 일지를 저장했어요') { event.preventDefault(); event.returnValue = ''; }
});

async function init() {
  try {
    state.quests = await journal.openGuest(exampleQuests);
    guestCount = state.quests.filter(q => !q.isExample).length;
    state.ready = true; render(); updateConnection(); setSaveStatus('이 기기에 저장돼요');
  } catch (error) {
    $('#quest-list').innerHTML = `<div class="empty-state">${icon('book')}<h3>일지를 열지 못했어요</h3><p>${escape(error.message)}</p><button class="button button-outline" onclick="location.reload()">다시 열기</button></div>`;
    toast(error.message, true); setSaveStatus('저장 공간을 확인해주세요');
  }
  if (state.ready) {
    try {
      cloud = await createCloud(cloudConfig, receiveSession);
      if (cloud) await receiveSession(await cloud.session());
      renderCloudStatus();
    } catch (error) { cloudMessage = error.message; cloudPhase = 'error'; renderCloudStatus(); }
  }
}

function renderCloudStatus() {
  const status = $('#cloud-status');
  if (!status) return;
  $('#cloud-account').textContent = accountUser?.email || (accountUser ? '로그인된 계정' : '이 기기의 일지');
  const messages = { local: '로그인하면 다른 기기에서도 같은 기록을 이어서 쓸 수 있어요.',
    pending: `${journal.pendingCount}개 변경 사항을 동기화할 예정이에요.`, syncing: '계정의 일지를 동기화하고 있어요.',
    synced: '계정에 동기화했어요. 다른 기기에서도 이어서 볼 수 있어요.',
    error: cloudMessage || '연결을 확인해주세요. 현재 기기 기록은 유지돼요.' };
  status.textContent = accountUser && !navigator.onLine ? '오프라인이에요. 수정한 기록은 이 기기에 보관해요.' : messages[cloudPhase];
  $('#cloud-login').hidden = !!accountUser;
  $('#cloud-login').disabled = !cloud;
  $('#cloud-account-actions').hidden = !accountUser;
  $('#cloud-sync').disabled = cloudPhase === 'syncing' || !navigator.onLine;
  $('#cloud-import').hidden = !accountUser || !guestCount;
  $('#cloud-import').textContent = `이 기기 기록 ${guestCount}개 가져오기`;
  $('#backup-description').textContent = accountUser
    ? '현재 계정의 기록과 사진을 백업할 수 있어요. 오프라인 수정은 이 기기에 보관하고, 연결되면 계정에 동기화해요.'
    : '퀘스트와 보상 사진은 현재 브라우저에 저장돼요. 다른 기기로 옮기거나 안전하게 보관하려면 백업 파일을 저장해주세요.';
  setSaveStatus(accountUser ? ({ synced: '계정에 동기화됨', syncing: '계정 동기화 중', pending: '기기 저장 · 동기화 대기', error: '기기 저장 · 연결 확인' }[cloudPhase] || '기기에 저장돼요') : '이 기기에 저장돼요');
}

function finishEditing() {
  editLock = false;
  if (deferredSession !== undefined) {
    const session = deferredSession; deferredSession = undefined; receiveSession(session);
  } else scheduleSync(0);
}

function receiveSession(session) {
  if (editLock) { deferredSession = session; return Promise.resolve(); }
  const task = authQueue.then(async () => {
    if (!cloud || (accountUser?.id || null) === (session?.user.id || null)) return;
    accountSwitching = true; clearTimeout(syncTimer);
    try {
      await writeQueue;
      try { await journal.running; } catch { /* Pending writes remain in the old account cache. */ }
      const nextUser = session?.user || null;
      const quests = nextUser
        ? await journal.openAccount(`${new URL(cloud.url).hostname}:${nextUser.id}`, cloud.forUser(nextUser))
        : await journal.openGuest(exampleQuests);
      accountUser = nextUser; state.quests = quests;
      state.query = ''; state.priorityFilter = 'all'; $('#quest-search').value = ''; state.selectedId = null; state.tab = 'active';
      $('#journal-body').classList.remove('show-detail');
      cloudPhase = nextUser ? 'pending' : 'local'; cloudMessage = '';
      render(); renderCloudStatus();
    } finally { accountSwitching = false; }
    scheduleSync(0);
  });
  authQueue = task.catch(error => { cloudPhase = 'error'; cloudMessage = error.message; renderCloudStatus(); });
  return task;
}

function scheduleSync(delay = 800) {
  clearTimeout(syncTimer);
  if (!accountUser || editLock || accountSwitching) return;
  syncTimer = setTimeout(() => runSync().catch(() => {}), delay);
}

async function runSync(showErrors = false) {
  if (!accountUser || editLock || accountSwitching || !navigator.onLine) return;
  await writeQueue;
  try {
    await journal.sync();
    renderCloudStatus();
    if (journal.pendingCount) scheduleSync(1200);
  } catch (error) { if (showErrors) toast(error.message, true); }
}

async function importGuestQuests() {
  if (!accountUser) return;
  const scope = journal.scope;
  const guest = validateQuests((await loadQuests()) || []).filter(q => !q.isExample);
  await updateQuests(quests => {
    for (const original of guest) {
      const existing = quests.find(q => q.id === original.id);
      if (existing && signature({ ...existing, updatedAt: '' }) === signature({ ...original, updatedAt: '' })) continue;
      const quest = { ...original, isExample: false, updatedAt: new Date().toISOString() };
      if (existing) { quest.id = uid(); quest.title = `${quest.title.slice(0, 65)} (가져온 기록)`; }
      quests.unshift(quest);
    }
  }, true, scope);
  toast('이 기기의 기록을 계정 일지에 추가했어요. 원래 기기 기록도 그대로 보관해요.');
}

setInterval(() => { if (!document.hidden) runSync().catch(() => {}); }, 30000);
window.addEventListener('focus', () => scheduleSync(0));
let calendarDay = localDateKey();
function refreshCalendarDay() {
  const today = localDateKey();
  if (today === calendarDay) return;
  if (state.occurrenceDate === calendarDay) state.occurrenceDate = today;
  calendarDay = today;
  if (state.ready) render();
}
setInterval(() => { if (!document.hidden) refreshCalendarDay(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshCalendarDay(); scheduleSync(0); } });

function setAuthMode(mode) {
  authMode = mode;
  const signingUp = mode === 'signup';
  document.querySelectorAll('[data-auth-mode]').forEach(button => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#auth-submit').textContent = signingUp ? '계정 만들고 시작하기' : '로그인하고 일지 열기';
  $('#auth-password').autocomplete = signingUp ? 'new-password' : 'current-password';
  $('#auth-password').minLength = signingUp ? 8 : 1;
  $('#auth-hint').textContent = signingUp
    ? 'Quest Maker에서 사용할 계정을 만들어요. 비밀번호는 8자 이상으로 정해주세요.'
    : '다른 기기에서도 같은 이메일과 비밀번호로 로그인해주세요.';
  $('#auth-error').hidden = true;
  $('#auth-notice').hidden = true;
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('#auth-form').reportValidity()) return;
  const button = $('#auth-submit'); button.disabled = true;
  $('#auth-error').hidden = true; $('#auth-notice').hidden = true;
  const email = $('#auth-email').value.trim(), password = $('#auth-password').value;
  try {
    const result = authMode === 'signup' ? await cloud.signUp(email, password) : await cloud.signIn(email, password);
    $('#auth-password').value = '';
    if (!result.session) {
      $('#auth-notice').textContent = '가입 요청을 받았어요. 이메일 확인이 켜져 있다면 확인 메일을 열어준 뒤 로그인해주세요.';
      $('#auth-notice').hidden = false;
      return;
    }
    await receiveSession(result.session);
    $('#auth-dialog').close();
    toast('계정의 일지를 열었어요. 기존 기기 기록은 설정에서 한 번 가져올 수 있어요.');
  } catch (error) { showError('auth-error', error.message || '로그인하지 못했어요. 다시 시도해주세요.'); }
  finally { button.disabled = false; }
});
$('#auth-dialog').addEventListener('close', () => { $('#auth-password').value = ''; });
init();
