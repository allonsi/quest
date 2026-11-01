-- Already run for quest-maker. Kept here for review and new project setup.
begin;
create table if not exists public.quest_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id) between 1 and 100),
  data jsonb, photo_path text,
  version bigint not null default 1 check (version > 0),
  mutation_id uuid not null, deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (deleted or (jsonb_typeof(data) = 'object' and data->>'id' = id)),
  check (data is null or octet_length(data::text) <= 262144)
);
alter table public.quest_records enable row level security;
revoke all on public.quest_records from public, anon, authenticated;
grant select on public.quest_records to authenticated;
drop policy if exists "Read own quests" on public.quest_records;
create policy "Read own quests" on public.quest_records for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.save_quest(p_id text, p_data jsonb, p_photo_path text,
  p_expected_version bigint, p_mutation_id uuid, p_deleted boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_record public.quest_records;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_id is null or length(p_id) not between 1 and 100 or p_mutation_id is null
    or p_expected_version < 0 or p_expected_version is null or p_deleted is null then raise exception 'Invalid quest request'; end if;
  if not p_deleted and (p_data is null or jsonb_typeof(p_data) <> 'object'
    or p_data->>'id' is distinct from p_id) then raise exception 'Invalid quest data'; end if;
  if p_photo_path is not null and p_photo_path !~
    ('^' || v_user::text || '/[a-f0-9]{64}/[a-f0-9]{64}\.(jpg|png|webp)$') then raise exception 'Invalid photo path'; end if;
  select * into v_record from public.quest_records where user_id = v_user and id = p_id;
  if found and v_record.mutation_id = p_mutation_id then return jsonb_build_object('ok', true, 'record', to_jsonb(v_record)); end if;
  if p_expected_version = 0 then
    insert into public.quest_records (user_id, id, data, photo_path, mutation_id, deleted)
      values (v_user, p_id, case when p_deleted then null else p_data end,
        case when p_deleted then null else p_photo_path end, p_mutation_id, p_deleted)
      on conflict (user_id, id) do nothing returning * into v_record;
  else
    update public.quest_records set data = case when p_deleted then null else p_data end,
      photo_path = case when p_deleted then null else p_photo_path end, version = version + 1,
      mutation_id = p_mutation_id, deleted = p_deleted, updated_at = now()
      where user_id = v_user and id = p_id and version = p_expected_version returning * into v_record;
  end if;
  if found then return jsonb_build_object('ok', true, 'record', to_jsonb(v_record)); end if;
  select * into v_record from public.quest_records where user_id = v_user and id = p_id;
  if not found then return jsonb_build_object('ok', false, 'record', null); end if;
  return jsonb_build_object('ok', v_record.mutation_id = p_mutation_id, 'record', to_jsonb(v_record));
end;
$$;
revoke all on function public.save_quest(text,jsonb,text,bigint,uuid,boolean) from public, anon;
grant execute on function public.save_quest(text,jsonb,text,bigint,uuid,boolean) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('quest-rewards', 'quest-rewards', false, 10485760, array['image/jpeg','image/png','image/webp'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Read own reward photos" on storage.objects;
create policy "Read own reward photos" on storage.objects for select to authenticated
  using (bucket_id = 'quest-rewards' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Upload own reward photos" on storage.objects;
create policy "Upload own reward photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'quest-rewards' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Delete unused own reward photos" on storage.objects;
create policy "Delete unused own reward photos" on storage.objects for delete to authenticated
  using (bucket_id = 'quest-rewards' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.quest_records q where q.user_id = (select auth.uid()) and not q.deleted and q.photo_path = storage.objects.name));
commit;
