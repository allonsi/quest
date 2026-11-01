import { uid, validateQuests } from './domain.js';

export function signature(quest) {
  return JSON.stringify(quest, (key, value) => key === 'blob' && value instanceof Blob
    ? { size: value.size, type: value.type } : value);
}

export class JournalSync {
  constructor({ disk, onChange = () => {}, onStatus = () => {}, onConflict = () => {} }) {
    Object.assign(this, { disk, onChange, onStatus, onConflict });
    this.queue = Promise.resolve(); this.scope = null; this.remote = null;
    this.data = { quests: [], meta: {}, pending: {}, revision: 0 };
  }
  serial(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  get quests() { return structuredClone(this.data.quests); }
  get pendingCount() { return Object.keys(this.data.pending).length; }
  async openGuest(seed) {
    return this.serial(async () => {
      const saved = await this.disk.loadGuest();
      const quests = saved === undefined ? seed() : validateQuests(saved);
      if (saved === undefined) await this.disk.saveGuest(quests);
      this.scope = null; this.remote = null;
      this.data = { quests, meta: {}, pending: {}, revision: 0 };
      return this.quests;
    });
  }
  async openAccount(scope, remote) {
    return this.serial(async () => {
      const data = (await this.disk.loadAccount(scope)) || { quests: [], meta: {}, pending: {}, revision: 0 };
      validateQuests(data.quests);
      this.scope = scope; this.remote = remote; this.data = data;
      return this.quests;
    });
  }
  async persist(next) {
    if (this.scope) {
      next.revision = this.data.revision + 1;
      await this.disk.saveAccount(this.scope, next, this.data.revision);
    } else await this.disk.saveGuest(next.quests);
    this.data = next;
  }
  async save(quests) { return this.mutate(current => current.splice(0, current.length, ...quests)); }
  async mutate(mutator) {
    return this.serial(async () => {
      const next = structuredClone(this.data), quests = structuredClone(next.quests);
      mutator(quests);
      if (this.scope) {
        const before = new Map(next.quests.map(q => [q.id, signature(q)]));
        const after = new Map(quests.map(q => [q.id, q]));
        for (const [id, quest] of after) if (before.get(id) !== signature(quest)) {
          Object.defineProperty(next.pending, id, { value: { token: uid(),
            base: Object.hasOwn(next.pending, id) ? next.pending[id].base : (Object.hasOwn(next.meta, id) ? next.meta[id].version : 0),
            quest: structuredClone(quest) }, enumerable: true, configurable: true, writable: true });
        }
        for (const id of before.keys()) if (!after.has(id)) {
          Object.defineProperty(next.pending, id, { value: { token: uid(),
            base: Object.hasOwn(next.pending, id) ? next.pending[id].base : (Object.hasOwn(next.meta, id) ? next.meta[id].version : 0),
            quest: null }, enumerable: true, configurable: true, writable: true });
        }
      }
      next.quests = structuredClone(quests); await this.persist(next);
    });
  }
  async sync() {
    if (!this.remote) return;
    if (this.running) return this.running;
    this.running = this.performSync().finally(() => { this.running = null; });
    return this.running;
  }
  async performSync() {
    const scope = this.scope, remote = this.remote;
    this.onStatus('syncing');
    try {
      const jobs = await this.serial(() => structuredClone(this.data.pending));
      for (const [id, job] of Object.entries(jobs)) {
        if (this.scope !== scope) return;
        const oldPath = await this.serial(() => Object.hasOwn(this.data.meta, id) ? this.data.meta[id].photoPath : null);
        const prepared = job.quest ? await remote.prepare(job.quest, job.token) : { data: null, photoPath: null };
        const result = await remote.push(id, job, prepared);
        if (!result.record) throw new Error('서버 응답을 확인하지 못했어요. 다시 동기화해주세요.');
        const restored = !result.ok && !result.record.deleted ? await remote.restore(result.record, null) : null;
        let conflicted = false, copied = false;
        await this.serial(async () => {
          if (this.scope !== scope) return;
          const next = structuredClone(this.data), current = Object.hasOwn(next.pending, id) ? next.pending[id] : null;
          Object.defineProperty(next.meta, id, { value: { version: result.record.version, photoPath: result.record.photo_path }, enumerable: true, configurable: true, writable: true });
          if (result.ok) {
            if (current?.token === job.token) delete next.pending[id];
            else if (current) current.base = result.record.version;
          } else if (current) {
            next.quests = next.quests.filter(q => q.id !== id);
            if (current.quest) {
              const copy = { ...current.quest, id: uid(), isExample: false,
                title: `${(current.quest.title || '이름 없는 퀘스트').slice(0, 63)} (다른 기기 수정본)`, updatedAt: new Date().toISOString() };
              next.quests.unshift(copy); copied = true;
              next.pending[copy.id] = { token: uid(), base: 0, quest: copy };
            }
            if (restored) next.quests.unshift(restored);
            delete next.pending[id]; conflicted = true;
          }
          await this.persist(next); this.onChange(this.quests);
        });
        if (conflicted) this.onConflict({ copied });
        if (prepared.photoPath) await remote.cleanup(prepared.photoPath).catch(() => {});
        if (oldPath && oldPath !== prepared.photoPath) await remote.cleanup(oldPath).catch(() => {});
      }
      const records = await remote.list();
      for (const record of records) {
        if (this.scope !== scope) return;
        const current = await this.serial(() => ({
          pending: Object.hasOwn(this.data.pending, record.id),
          meta: Object.hasOwn(this.data.meta, record.id) ? this.data.meta[record.id] : null,
          quest: this.data.quests.find(q => q.id === record.id)
        }));
        if (current.pending || (current.meta?.version || 0) >= record.version) continue;
        const quest = record.deleted ? null : await remote.restore(record, current);
        await this.serial(async () => {
          if (this.scope !== scope || Object.hasOwn(this.data.pending, record.id)
            || (Object.hasOwn(this.data.meta, record.id) && this.data.meta[record.id].version >= record.version)) return;
          const next = structuredClone(this.data);
          const previousPath = Object.hasOwn(next.meta, record.id) ? next.meta[record.id].photoPath : null;
          next.quests = next.quests.filter(q => q.id !== record.id);
          if (quest) next.quests.unshift(quest);
          Object.defineProperty(next.meta, record.id, { value: { version: record.version, photoPath: record.photo_path }, enumerable: true, configurable: true, writable: true });
          await this.persist(next); this.onChange(this.quests);
          if (previousPath && previousPath !== record.photo_path) remote.cleanup(previousPath).catch(() => {});
        });
      }
      if (this.scope === scope) this.onStatus(this.pendingCount ? 'pending' : 'synced');
    } catch (error) {
      if (this.scope === scope) this.onStatus('error', error.message);
      throw error;
    }
  }
}
