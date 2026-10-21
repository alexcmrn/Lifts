-- Profile photos for Lifts. Needs friends.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.
--
-- Like your name and @username, your profile photo can be seen by anyone signed in to Lifts.
-- The bucket is private, so it is never visible to people who are not signed in.

-- 1. Where your current photo is stored. Each person can only point at a file in their own folder.
alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles drop constraint if exists profiles_avatar_own_folder;
alter table public.profiles add constraint profiles_avatar_own_folder
  check (avatar_path is null or split_part(avatar_path, '/', 1) = user_id::text);

-- 2. Private bucket: JPEG, PNG or WebP up to 2 MB (the app shrinks photos to 512 x 512 first).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: upload own" on storage.objects;
create policy "avatars: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: delete own" on storage.objects;
create policy "avatars: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars: signed-in users can see" on storage.objects;
create policy "avatars: signed-in users can see" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

-- 3. Add the photo to what anyone signed in can see about an account.
--    This replaces the version in friends.sql; search, friends, profiles, the leaderboard and the feed all use it.
create or replace function public.lifts_card(uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'username', u.username,
    'name', coalesce(nullif(trim(p.calc ->> 'name'), ''), u.username),
    'verified', exists (select 1 from public.verified v where v.user_id = uid),
    'avatar', p.avatar_path)
  from public.usernames u
  left join public.profiles p on p.user_id = uid
  where u.user_id = uid;
$$;
revoke all on function public.lifts_card(uuid) from public, anon, authenticated;
