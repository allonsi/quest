import { filterQuests, sortQuests } from './domain.js';

export function getQuestView(quests, { tab = 'active', priorityFilter = 'all', activeSort = 'newest', query = '' } = {}) {
  const controlsVisible = tab === 'active';
  const inTab = quests.filter(quest => quest.status === tab);
  const filter = controlsVisible ? priorityFilter : 'all';
  const matches = filterQuests(inTab, filter, query);
  return {
    quests: controlsVisible ? sortQuests(matches, activeSort) : matches,
    total: inTab.length,
    constrained: filter !== 'all' || query.trim().length > 0,
    controlsVisible
  };
}
