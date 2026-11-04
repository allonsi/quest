import { filterQuests, sortQuests } from './domain.js';
import { questStatus } from './time-limit.js';

export function getQuestView(quests, { tab = 'active', priorityFilter = 'all', activeSort = 'newest', query = '' } = {}, now = new Date()) {
  const controlsVisible = tab === 'active';
  const inTab = quests.filter(quest => questStatus(quest, now) === tab);
  const filter = controlsVisible ? priorityFilter : 'all';
  const matches = filterQuests(inTab, filter, query);
  return {
    quests: controlsVisible ? sortQuests(matches, activeSort, now) : matches,
    total: inTab.length,
    constrained: filter !== 'all' || query.trim().length > 0,
    controlsVisible
  };
}
