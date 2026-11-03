import assert from 'node:assert/strict';
import { GUIDE_STORAGE_KEY, getGuide, loadGuidePreference, saveGuidePreference, guideWelcome } from '../web/guides.js';

export const passed = [];
const test = (name, fn) => { fn(); passed.push(name); };
function storage(entries = []) {
  const data = new Map(entries);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('처음 사용하면 루미를 기본 길잡이로 선택한다', () => {
  assert.equal(loadGuidePreference(storage()), 'lumi');
});
test('루아를 선택한 뒤 다시 읽어도 선택과 그림이 유지된다', () => {
  const disk = storage();
  saveGuidePreference('rua', disk);
  assert.equal(loadGuidePreference(disk), 'rua');
  assert.equal(getGuide(loadGuidePreference(disk)).image, './assets/guide-rua.png');
});
test('루미로 다시 바꿔도 퀘스트·로그인 등 다른 저장 값은 건드리지 않는다', () => {
  const disk = storage([['quests', 'my journal'], ['session', 'my session']]);
  saveGuidePreference('rua', disk); saveGuidePreference('lumi', disk);
  assert.equal(loadGuidePreference(disk), 'lumi');
  assert.equal(disk.data.get('quests'), 'my journal'); assert.equal(disk.data.get('session'), 'my session');
  assert.equal(disk.data.size, 3);
});
test('저장된 길잡이가 없거나 알 수 없는 값이면 루미로 복구한다', () => {
  for (const value of ['', 'unknown', '__proto__', '{"id":"rua"}']) {
    assert.equal(loadGuidePreference(storage([[GUIDE_STORAGE_KEY, value]])), 'lumi');
  }
});
test('브라우저 저장 공간을 읽을 수 없어도 앱의 기본 길잡이를 사용할 수 있다', () => {
  assert.equal(loadGuidePreference({ getItem() { throw new Error('blocked'); } }), 'lumi');
});
test('선택 저장이 실패하면 실패를 알리고 기존 선택을 유지한다', () => {
  const disk = storage([[GUIDE_STORAGE_KEY, 'lumi']]);
  disk.setItem = () => { throw new Error('quota'); };
  assert.throws(() => saveGuidePreference('rua', disk), /저장하지 못했어요/);
  assert.equal(loadGuidePreference(disk), 'lumi');
});
test('알 수 없는 길잡이는 기존 선택에 덮어쓰지 않는다', () => {
  const disk = storage([[GUIDE_STORAGE_KEY, 'rua']]);
  assert.throws(() => saveGuidePreference('invalid', disk));
  assert.equal(loadGuidePreference(disk), 'rua');
});
test('도움말 인사에는 선택한 캐릭터의 이름만 사용한다', () => {
  assert.match(guideWelcome('rua'), /루아예요/); assert.doesNotMatch(guideWelcome('rua'), /루미/);
  assert.match(guideWelcome('lumi'), /루미예요/); assert.match(guideWelcome('unknown'), /루미예요/);
});

console.log(`${passed.length} guide preference behavior tests passed.`);
