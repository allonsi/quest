import { validateQuests } from './domain.js';
const BUCKET = 'quest-rewards';
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
let sdkPromise;

function loadSDK() {
  if (globalThis.supabase?.createClient) return Promise.resolve(globalThis.supabase);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/supabase-2.118.0.js', location.href).href;
    script.onload = () => {
      if (globalThis.supabase?.createClient) resolve(globalThis.supabase);
      else { sdkPromise = null; reject(new Error('로그인 기능을 준비하지 못했어요.')); }
    };
    script.onerror = () => { sdkPromise = null; script.remove(); reject(new Error('로그인 파일을 불러오지 못했어요. 연결 후 다시 열어주세요.')); };
    document.head.append(script);
  });
  return sdkPromise;
}

export function validateCloudConfig(config) {
  if (!config.url && !config.publishableKey) return false;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(config.url)) throw new Error('Supabase 프로젝트 주소를 확인해주세요.');
  const key = config.publishableKey || '';
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role === 'anon') return true;
  } catch { /* Reject secret and service-role keys in browser configuration. */ }
  throw new Error('브라우저 연결에는 Publishable key 또는 anon 공개 키만 사용할 수 있어요.');
}

async function timedFetch(input, init = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}

function authError(error) {
  const messages = {
    invalid_credentials: '이메일 또는 비밀번호를 확인해주세요.',
    email_not_confirmed: '아직 이메일 확인이 필요해요. 확인 메일 또는 프로젝트의 Confirm email 설정을 확인해주세요.',
    user_already_exists: '이미 가입한 이메일이에요. 로그인 탭을 이용해주세요.',
    email_exists: '이미 가입한 이메일이에요. 로그인 탭을 이용해주세요.',
    signup_disabled: '현재 가입이 꺼져 있어요. 프로젝트의 Allow new users to sign up 설정을 확인해주세요.',
    weak_password: '더 긴 비밀번호를 사용해주세요. 최소 8자 이상을 권장해요.',
    over_email_send_rate_limit: '확인 메일 전송 한도에 도달했어요. 잠시 후 다시 시도해주세요.',
  };
  return new Error(messages[error.code] || '로그인 요청을 완료하지 못했어요. 입력 내용과 연결을 확인해주세요.');
}

export function createAuthActions(client) {
  return {
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw authError(error);
      return data;
    },
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email: email.trim(), password });
      if (error) throw authError(error);
      return data;
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw authError(error);
    }
  };
}

export async function createCloud(config, onSession) {
  if (!validateCloudConfig(config)) return null;
  const { createClient } = await loadSDK();
  const url = config.url.replace(/\/$/, '');
  const client = createClient(url, config.publishableKey, {
    auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
      storageKey: `quest-maker-auth-${new URL(url).hostname}` }, global: { fetch: timedFetch }
  });
  client.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
  return {
    ...createAuthActions(client), client, url,
    async session() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },
    forUser(user) {
      // Bind every request to this account, even when another tab changes sessions.
      const accountClient = createClient(url, config.publishableKey, {
        accessToken: async () => {
          const { data, error } = await client.auth.getSession();
          if (error || data.session?.user.id !== user.id) throw new Error('다시 로그인한 뒤 동기화해주세요.');
          return data.session.access_token;
        }, global: { fetch: timedFetch }
      });
      return new QuestRemote(accountClient, user.id);
    }
  };
}

export class QuestRemote {
  constructor(client, userId) { this.client = client; this.userId = userId; }
  async list() {
    const result = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.client.from('quest_records').select('*').eq('user_id', this.userId).order('id').range(offset, offset + 999);
      if (error) throw new Error('서버 일지를 읽지 못했어요. 연결과 Supabase 설정을 확인해주세요.');
      result.push(...data);
      if (data.length < 1000) return result;
    }
  }
  async prepare(quest, mutationId) {
    const data = structuredClone(quest), photo = quest.rewardRecord?.photo;
    let photoPath = null;
    if (photo) {
      const folder = await digest(new TextEncoder().encode(quest.id));
      const contentHash = await digest(await photo.blob.arrayBuffer());
      const hash = await digest(new TextEncoder().encode(`${contentHash}:${mutationId}`));
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[photo.blob.type];
      if (!extension || photo.blob.size > 10 * 1024 * 1024) throw new Error('동기화할 사진의 형식이나 크기를 확인해주세요.');
      photoPath = `${this.userId}/${folder}/${hash}.${extension}`;
      const { data: exists, error: existsError } = await this.client.storage.from(BUCKET).exists(photoPath);
      if (existsError && String(existsError.statusCode) !== '404') throw new Error('사진 저장소를 확인하지 못했어요.');
      if (!exists) {
        const { error } = await this.client.storage.from(BUCKET).upload(photoPath, photo.blob, { contentType: photo.blob.type, upsert: false });
        if (error && String(error.statusCode) !== '409') throw new Error('사진을 업로드하지 못했어요. 기기에는 보관하고 있어요.');
      }
      data.rewardRecord.photo = { name: photo.name, type: photo.blob.type, size: photo.blob.size };
    }
    return { data, photoPath };
  }
  async push(id, job, prepared) {
    const { data, error } = await this.client.rpc('save_quest', {
      p_id: id, p_data: prepared.data, p_photo_path: prepared.photoPath,
      p_expected_version: job.base, p_mutation_id: job.token, p_deleted: job.quest === null
    });
    if (error) throw new Error('서버에 저장하지 못했어요. 연결을 확인해주세요. 기기 기록은 유지돼요.');
    return data;
  }
  async restore(record, cached) {
    if (record.user_id !== this.userId) throw new Error('다른 계정의 기록은 불러올 수 없어요.');
    const quest = structuredClone(record.data);
    if (!quest || quest.id !== record.id) throw new Error('서버의 퀘스트 형식을 확인해주세요.');
    if (record.photo_path) {
      if (!record.photo_path.startsWith(`${this.userId}/`) || !quest.rewardRecord?.photo) throw new Error('사진 소유자 정보를 확인해주세요.');
      const metadata = quest.rewardRecord.photo;
      let blob = cached?.meta?.photoPath === record.photo_path ? cached.quest?.rewardRecord?.photo?.blob : null;
      if (!blob) {
        const { data, error } = await this.client.storage.from(BUCKET).download(record.photo_path);
        if (error) throw new Error('사진을 불러오지 못했어요. 연결 후 다시 동기화해주세요.');
        blob = data;
      }
      quest.rewardRecord.photo = { name: metadata.name, blob };
    } else if (quest.rewardRecord?.photo) throw new Error('서버의 사진 경로가 비어 있어요.');
    return validateQuests([quest])[0];
  }
  async cleanup(path) {
    if (!path.startsWith(`${this.userId}/`)) return;
    const { data, error } = await this.client.from('quest_records').select('id').eq('user_id', this.userId).eq('photo_path', path).eq('deleted', false).limit(1);
    if (error || data.length) return;
    const { error: removeError } = await this.client.storage.from(BUCKET).remove([path]);
    if (removeError) throw removeError;
  }
}
