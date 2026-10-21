-- Reactions on posts, and each person's own list of posts. Needs friends.sql and posts.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.
--
-- Anyone who can see a post (its owner and their friends) can react to it, with one reaction each.

-- 1. Reactions. The app shows the keys as emoji: strong 💪, fire 🔥, clap 👏, heart ❤️.
--    No policies: reactions are only read and written through the functions below.
create table if not exists public.reactions (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('strong', 'fire', 'clap', 'heart')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.reactions enable row level security;

-- 2. Internal helpers (not callable from the app).

-- True when the signed-in person may see this post: it is theirs or a friend's.
create or replace function public.can_see_post(pid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.posts p
    where p.id = pid and public.lifts_relation(auth.uid(), p.user_id) in ('self', 'friends'));
$$;

-- Reaction counts for a post, and which one the signed-in person chose.
create or replace function public.post_reactions(pid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(c.kind, c.n)
      from (select r.kind, count(*) as n from public.reactions r where r.post_id = pid group by r.kind) c), '{}'::jsonb),
    'mine', (select r.kind from public.reactions r where r.post_id = pid and r.user_id = auth.uid()));
$$;

-- Everything the app shows for one post. Used by the feed and by profile post lists.
create or replace function public.post_json(pid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.lifts_card(p.user_id) || jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'caption', p.caption, 'image_path', p.image_path,
    'details', p.details, 'created_at', p.created_at, 'mine', p.user_id = auth.uid(),
    'reactions', public.post_reactions(p.id))
  from public.posts p
  where p.id = pid;
$$;

revoke all on function public.can_see_post(uuid) from public, anon, authenticated;
revoke all on function public.post_reactions(uuid) from public, anon, authenticated;
revoke all on function public.post_json(uuid) from public, anon, authenticated;

-- 3. Functions the app calls.

-- Set your reaction to a post, or pass null to take it back. Returns the post's new reaction counts.
create or replace function public.react_to_post(pid uuid, reaction text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not public.can_see_post(pid) then raise exception 'Post not found'; end if;
  if reaction is null or reaction = '' then
    delete from public.reactions where post_id = pid and user_id = auth.uid();
  else
    insert into public.reactions (post_id, user_id, kind) values (pid, auth.uid(), reaction)
    on conflict (post_id, user_id) do update set kind = excluded.kind, created_at = now();
  end if;
  return public.post_reactions(pid);
end;
$$;

-- The feed: your posts and your friends' posts, newest first, 20 at a time, now with reactions.
-- This replaces the version in posts.sql, so run this file again after re-running posts.sql.
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
    select p.id, p.created_at
    from public.posts p
    join people on people.uid = p.user_id
    where before is null or p.created_at < before
    order by p.created_at desc
    limit 20
  )
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
  from (select pg.created_at, public.post_json(pg.id) as j from page pg) x
  where x.j is not null;
$$;

-- One person's posts, 20 at a time: yours, or a friend's. Anyone else gets an empty list.
create or replace function public.user_posts(uname text, before timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with who as (
    select u.user_id as uid from public.usernames u
    where u.username = lower(trim(both '@' from trim(uname)))
      and public.lifts_relation(auth.uid(), u.user_id) in ('self', 'friends')
  ),
  page as (
    select p.id, p.created_at
    from public.posts p join who on who.uid = p.user_id
    where before is null or p.created_at < before
    order by p.created_at desc
    limit 20
  )
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
  from (select pg.created_at, public.post_json(pg.id) as j from page pg) x
  where x.j is not null;
$$;

revoke all on function public.react_to_post(uuid, text) from public, anon;
revoke all on function public.friends_feed(timestamptz) from public, anon;
revoke all on function public.user_posts(text, timestamptz) from public, anon;
grant execute on function public.react_to_post(uuid, text) to authenticated;
grant execute on function public.friends_feed(timestamptz) to authenticated;
grant execute on function public.user_posts(text, timestamptz) to authenticated;
