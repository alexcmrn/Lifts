-- Photo posts and the friends feed for Lifts. Needs friends.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.
--
-- Who can see a post: you and your accepted friends. Photos live in a private storage bucket,
-- so the app can only fetch a photo through a short-lived link that the same rule allows.

-- 1. Posts. details is a snapshot of what was shared (plan, weight moved, calories...) so the post
--    still reads correctly if the workout or meal is edited or deleted later. The photo is optional.
create table if not exists public.posts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('workout', 'meal')),
  caption    text check (char_length(caption) <= 500),
  image_path text unique,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint posts_image_in_own_folder check (image_path is null or split_part(image_path, '/', 1) = user_id::text)
);
-- Posts tables created before photos became optional: allow posts without one.
alter table public.posts alter column image_path drop not null;
alter table public.posts drop constraint if exists posts_image_in_own_folder;
alter table public.posts add constraint posts_image_in_own_folder
  check (image_path is null or split_part(image_path, '/', 1) = user_id::text);
create index if not exists posts_user_created on public.posts (user_id, created_at desc);
alter table public.posts enable row level security;

drop policy if exists "read own posts" on public.posts;
create policy "read own posts" on public.posts
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "add own posts" on public.posts;
create policy "add own posts" on public.posts
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "delete own posts" on public.posts;
create policy "delete own posts" on public.posts
  for delete to authenticated using (auth.uid() = user_id);

-- 2. Private photo bucket: JPEG, PNG or WebP up to 5 MB (the app shrinks photos to well under that).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('posts', 'posts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- True when the signed-in person may see the photo at this path: it belongs to them,
-- or it is attached to a post by one of their friends.
create or replace function public.can_see_post_image(path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.posts p
    where p.image_path = path
      and public.lifts_relation(auth.uid(), p.user_id) in ('self', 'friends'));
$$;
revoke all on function public.can_see_post_image(text) from public, anon;
grant execute on function public.can_see_post_image(text) to authenticated;

-- Each person uploads into a folder named after their user id, and can only delete their own photos.
drop policy if exists "posts: upload own photos" on storage.objects;
create policy "posts: upload own photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "posts: delete own photos" on storage.objects;
create policy "posts: delete own photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'posts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "posts: see own and friends' photos" on storage.objects;
create policy "posts: see own and friends' photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'posts' and ((storage.foldername(name))[1] = auth.uid()::text or public.can_see_post_image(name)));

-- 3. The feed: your posts and your friends' posts, newest first, 20 at a time.
--    Pass the created_at of the last post you have to get the next page.
create or replace function public.friends_feed(before timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (
    select auth.uid() as id
  ),
  people as (
    select m.id as uid from me m where m.id is not null
    union
    select case when f.requester = m.id then f.addressee else f.requester end
    from public.friendships f cross join me m
    where f.status = 'accepted' and m.id in (f.requester, f.addressee)
  ),
  page as (
    select p.*
    from public.posts p
    join people on people.uid = p.user_id
    where before is null or p.created_at < before
    order by p.created_at desc
    limit 20
  )
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
  from (
    select pg.created_at,
      public.lifts_card(pg.user_id) || jsonb_build_object(
        'id', pg.id, 'kind', pg.kind, 'caption', pg.caption, 'image_path', pg.image_path,
        'details', pg.details, 'created_at', pg.created_at, 'mine', pg.user_id = (select id from me)) as j
    from page pg
  ) x
  where x.j is not null;
$$;
revoke all on function public.friends_feed(timestamptz) from public, anon;
grant execute on function public.friends_feed(timestamptz) to authenticated;
