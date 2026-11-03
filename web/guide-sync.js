import { GUIDES, GUIDE_STORAGE_KEY, loadGuidePreference, saveGuidePreference } from './guides.js';

const validGuide = id => GUIDES.some(guide => guide.id === id);
export const guideAccountKey = scope => `${GUIDE_STORAGE_KEY}:account:${scope}`;

// Small appearance settings have their own account cache and durable outbox.
export class GuideSync {
  constructor({ storage, onChange = () => {} } = {}) {
    this.storage = storage; this.onChange = onChange;
    this.context = { scope: null, remote: null, data: { guideId: loadGuidePreference(this.storage), pending: null } };
  }
  get disk() { return this.storage ?? globalThis.localStorage; }
  get selected() { return this.context.data.guideId; }
  get pendingCount() { return this.context.scope && this.context.data.pending ? 1 : 0; }
  get storageKey() { return this.context.scope ? guideAccountKey(this.context.scope) : GUIDE_STORAGE_KEY; }
  readAccount(scope) {
    let raw;
    try { raw = JSON.parse(this.disk.getItem(guideAccountKey(scope))); } catch { /* Use a valid local fallback. */ }
    const pending = raw?.pending;
    const validPending = validGuide(pending?.guideId) && typeof pending?.token === 'string' && pending.token.length > 0 && pending.token.length <= 100;
    return { guideId: validPending ? pending.guideId : raw && validGuide(raw.guideId) ? raw.guideId : loadGuidePreference(this.storage),
      seenServer: raw?.seenServer === true,
      pending: validPending ? { guideId: pending.guideId, token: pending.token } : null };
  }
  publish() { this.onChange(this.selected); }
  openGuest() {
    this.context = { scope: null, remote: null, data: { guideId: loadGuidePreference(this.storage), pending: null } };
    this.publish();
  }
  openAccount(scope, remote) {
    let legacy = null;
    try { const saved = this.disk.getItem(GUIDE_STORAGE_KEY); if (validGuide(saved)) legacy = saved; } catch { /* Optional migration. */ }
    this.context = { scope, remote, legacy, data: this.readAccount(scope) };
    this.publish();
  }
  persist(context, data) {
    try { this.disk.setItem(guideAccountKey(context.scope), JSON.stringify(data)); }
    catch { throw new Error('길잡이 선택을 기기에 저장하지 못했어요. 브라우저 저장 공간을 확인해주세요.'); }
    context.data = data;
    if (context === this.context) this.publish();
  }
  select(id) {
    if (!validGuide(id)) throw new Error('선택할 길잡이를 확인해주세요.');
    const context = this.context;
    if (!context.scope) {
      saveGuidePreference(id, this.storage); context.data.guideId = id; this.publish(); return;
    }
    const data = this.readAccount(context.scope);
    data.guideId = id; data.pending = { guideId: id, token: crypto.randomUUID() };
    this.persist(context, data);
  }
  refresh() {
    const context = this.context;
    context.data = context.scope ? this.readAccount(context.scope) : { guideId: loadGuidePreference(this.storage), pending: null };
    this.publish();
  }
  async sync() {
    const context = this.context;
    if (!context.remote) return;
    if (context.running) return context.running;
    context.running = this.performSync(context).finally(() => { context.running = null; });
    return context.running;
  }
  async performSync(context) {
    const serverGuide = await context.remote.read();
    if (context !== this.context) return;
    if (serverGuide !== null && !validGuide(serverGuide)) throw new Error('서버의 길잡이 설정을 확인해주세요.');
    const data = this.readAccount(context.scope);
    if (!data.pending) {
      if (serverGuide !== null) data.guideId = serverGuide;
      else if (!data.seenServer && context.legacy) {
        data.guideId = context.legacy;
        data.pending = { guideId: context.legacy, token: crypto.randomUUID() };
      }
    }
    data.seenServer = true;
    this.persist(context, data);
    const job = data.pending;
    if (!job) return;
    await context.remote.write(job.guideId);
    if (context !== this.context) return;
    const current = this.readAccount(context.scope);
    // A newer choice made during this request must stay pending.
    if (current.pending?.token === job.token) current.pending = null;
    this.persist(context, current);
  }
}
