export const GUIDE_STORAGE_KEY = 'quest-maker-guide';
export const DEFAULT_GUIDE = 'lumi';
export const GUIDES = [
  { id: 'lumi', name: '루미', image: './assets/guide.png', alt: '세이지색 머리의 길잡이 루미', description: '찰랑이는 세이지색 머리와 밝은 크림색 옷이 환하고 다정한 성격을 돋보이게 합니다.' },
  { id: 'rua', name: '루아', image: './assets/guide-rua.png', alt: '갈색 머리의 길잡이 루아', description: '잔잔한 물결 같은 갈색 머리가 이마를 살짝 가리고, 숲색 재킷이 차분한 성격을 보여줍니다.' }
];

export function getGuide(id) {
  return GUIDES.find(guide => guide.id === id) || GUIDES.find(guide => guide.id === DEFAULT_GUIDE);
}

// Appearance is a browser preference, separate from guest/account journals.
export function loadGuidePreference(storage) {
  try { return getGuide((storage ?? globalThis.localStorage).getItem(GUIDE_STORAGE_KEY)).id; }
  catch { return DEFAULT_GUIDE; }
}

export function saveGuidePreference(id, storage) {
  if (!GUIDES.some(guide => guide.id === id)) throw new Error('선택할 길잡이를 확인해주세요.');
  try { (storage ?? globalThis.localStorage).setItem(GUIDE_STORAGE_KEY, id); }
  catch { throw new Error('길잡이 선택을 저장하지 못했어요. 브라우저 저장 공간 설정을 확인해주세요.'); }
  return id;
}

export function guideWelcome(id) {
  return `안녕하세요, 모험가님! 저는 길잡이 ${getGuide(id).name}예요.\n무엇이든 편하게 물어보세요. 오늘도 작은 한 걸음만 나아가면 충분해요.`;
}
