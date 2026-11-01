const DB_NAME = 'quest-maker';
let database;

async function openDatabase() {
  if (database) return database;
  if (!globalThis.indexedDB) throw new Error('이 브라우저에서는 일지를 저장할 수 없어요. 일반 브라우저 창에서 다시 열어주세요.');
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('journal');
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(new Error('일지를 열 수 없어요. 브라우저의 저장 공간 설정을 확인해주세요.')); };
    request.onblocked = () => { database = undefined; reject(new Error('다른 Quest Maker 창을 닫고 다시 시도해주세요.')); };
  });
  return database;
}

export async function loadQuests() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('journal').objectStore('journal').get('quests');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('저장된 일지를 읽지 못했어요. 새로고침 후 다시 시도해주세요.'));
  });
}

export async function saveQuests(quests) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('journal', 'readwrite');
    transaction.objectStore('journal').put(quests, 'quests');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('저장하지 못했어요. 저장 공간을 확인하고, 일지를 백업해주세요.'));
    transaction.onabort = () => reject(new Error('저장이 중단됐어요. 다시 시도해주세요.'));
  });
}
