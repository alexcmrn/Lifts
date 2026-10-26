-- Comments, who reacted, the activity list and the leaderboard by exercise for Lifts.
-- Needs friends.sql, posts.sql, reactions.sql and safety.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.
--
-- Comments follow the same rule as reactions: anyone who can see a post (its owner and their friends) can comment.
-- This file replaces post_json from reactions.sql. If you ever re-run reactions.sql, run this file again afterwards.

-- 1. Comments. No policies: they are only read and written through the functions below.
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_created on public.comments (post_id, created_at);
alter table public.comments enable row level security;

-- 2. Posts now carry their comment count.
create or replace function public.post_json(pid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.lifts_card(p.user_id) || jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'caption', p.caption, 'image_path', p.image_path,
    'details', p.details, 'created_at', p.created_at, 'mine', p.user_id = auth.uid(),
    'reactions', public.post_reactions(p.id),
    'comments', (select count(*) from public.comments c where c.post_id = p.id))
  from public.posts p
  where p.id = pid;
$$;
revoke all on function public.post_json(uuid) from public, anon, authenticated;

-- 3. Functions the app calls.

-- One post, if you can see it (used when opening a post from the activity list).
create or replace function public.get_post(pid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.can_see_post(pid) then public.post_json(pid) end;
$$;

-- A post's comments, oldest first. can_delete is true for your own comments and for any comment on your post.
create or replace function public.post_comments(pid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.lifts_card(c.user_id) || jsonb_build_object(
           'id', c.id, 'body', c.body, 'created_at', c.created_at, 'mine', c.user_id = auth.uid(),
           'can_delete', c.user_id = auth.uid() or p.user_id = auth.uid())
         order by c.created_at), '[]'::jsonb)
  from public.comments c
  join public.posts p on p.id = c.post_id
  where c.post_id = pid
    and public.can_see_post(pid)
    and public.lifts_relation(auth.uid(), c.user_id) <> 'blocked'
    and public.lifts_card(c.user_id) is not null;
$$;

-- Add a comment. Returns the post's comments.
create or replace function public.add_comment(pid uuid, msg text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not public.can_see_post(pid) then raise exception 'Post not found'; end if;
  if char_length(trim(coalesce(msg, ''))) = 0 then raise exception 'Write a comment first'; end if;
  insert into public.comments (post_id, user_id, body) values (pid, auth.uid(), left(trim(msg), 500));
  return public.post_comments(pid);
end;
$$;

-- Delete a comment: your own, or any comment on your post. Returns the post's comments.
create or replace function public.delete_comment(cid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select c.post_id into pid from public.comments c join public.posts p on p.id = c.post_id
  where c.id = cid and (c.user_id = auth.uid() or p.user_id = auth.uid());
  if pid is null then raise exception 'Comment not found'; end if;
  delete from public.comments where id = cid;
  return public.post_comments(pid);
end;
$$;

-- Who reacted to a post, newest first.
create or replace function public.post_reactors(pid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.lifts_card(r.user_id) || jsonb_build_object('kind', r.kind, 'me', r.user_id = auth.uid())
         order by r.created_at desc), '[]'::jsonb)
  from public.reactions r
  where r.post_id = pid
    and public.can_see_post(pid)
    and public.lifts_relation(auth.uid(), r.user_id) <> 'blocked'
    and public.lifts_card(r.user_id) is not null;
$$;

-- What has happened to you lately: reactions and comments on your posts, friend requests, and accepted requests.
create or replace function public.my_activity()
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  ev as (
    select r.created_at as ts, 'reaction' as kind, r.user_id as who, r.post_id, r.kind as detail
    from public.reactions r join public.posts p on p.id = r.post_id cross join me
    where p.user_id = me.id and r.user_id <> me.id
    union all
    select c.created_at, 'comment', c.user_id, c.post_id, left(c.body, 140)
    from public.comments c join public.posts p on p.id = c.post_id cross join me
    where p.user_id = me.id and c.user_id <> me.id
    union all
    select f.created_at, 'request', f.requester, null::uuid, null::text
    from public.friendships f cross join me
    where f.addressee = me.id and f.status = 'pending'
    union all
    select coalesce(f.accepted_at, f.created_at), 'accepted', f.addressee, null::uuid, null::text
    from public.friendships f cross join me
    where f.requester = me.id and f.status = 'accepted'
  ),
  recent as (
    select ev.* from ev cross join me
    where public.lifts_relation(me.id, ev.who) <> 'blocked'
    order by ev.ts desc
    limit 50
  )
  select coalesce(jsonb_agg(public.lifts_card(e.who) || jsonb_build_object('kind', e.kind, 'ts', e.ts, 'post_id', e.post_id, 'detail', e.detail)
         order by e.ts desc), '[]'::jsonb)
  from recent e
  where public.lifts_card(e.who) is not null;
$$;

-- 4. Leaderboard, version 2:
--   since:    the first day of the period in your own time zone (the app works out your Monday or the 1st);
--             null for all time. This replaces the server's UK-time week and month.
--   exercise: when given, also returns best_kg, the heaviest working or drop set of that exercise in the period.
-- Friends whose workouts are set to 'Only me' are left out, as before.
create or replace function public.friends_leaderboard(period text, since date, exercise text default null)
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
  visible as (
    select p.uid
    from people p
    cross join me m
    left join public.sharing s on s.user_id = p.uid
    where p.uid = m.id or public.lifts_can_see(coalesce(s.workouts, 'friends'), 'friends')
  ),
  opts as (
    select case when friends_leaderboard.period in ('week', 'month') then friends_leaderboard.since end as d,
           nullif(lower(trim(coalesce(friends_leaderboard.exercise, ''))), '') as ex
  ),
  stats as (
    select v.uid,
      (select count(*)
         from public.workouts w cross join opts
         where w.user_id = v.uid and w.ended_at is not null
           and (opts.d is null or w.workout_date >= opts.d)) as workouts,
      (select coalesce(sum(x.weight_kg * x.reps), 0)
         from public.sets x
         join public.workouts w on w.id = x.workout_id
         cross join opts
         where x.user_id = v.uid and w.ended_at is not null
           and not x.is_cardio and x.set_type <> 'warmup'
           and (opts.d is null or w.workout_date >= opts.d)) as volume_kg,
      (select max(x.weight_kg)
         from public.sets x
         join public.workouts w on w.id = x.workout_id
         cross join opts
         where opts.ex is not null and x.user_id = v.uid and w.ended_at is not null
           and not x.is_cardio and x.set_type <> 'warmup'
           and lower(trim(x.exercise)) = opts.ex
           and (opts.d is null or w.workout_date >= opts.d)) as best_kg
    from visible v
  )
  select coalesce(jsonb_agg(
           public.lifts_card(s.uid) || jsonb_build_object(
             'me', s.uid = (select id from me),
             'workouts', s.workouts,
             'volume_kg', round(s.volume_kg, 1),
             'best_kg', s.best_kg)), '[]'::jsonb)
  from stats s
  where public.lifts_card(s.uid) is not null;
$$;

revoke all on function public.get_post(uuid) from public, anon;
revoke all on function public.post_comments(uuid) from public, anon;
revoke all on function public.add_comment(uuid, text) from public, anon;
revoke all on function public.delete_comment(uuid) from public, anon;
revoke all on function public.post_reactors(uuid) from public, anon;
revoke all on function public.my_activity() from public, anon;
revoke all on function public.friends_leaderboard(text, date, text) from public, anon;
grant execute on function public.get_post(uuid) to authenticated;
grant execute on function public.post_comments(uuid) to authenticated;
grant execute on function public.add_comment(uuid, text) to authenticated;
grant execute on function public.delete_comment(uuid) to authenticated;
grant execute on function public.post_reactors(uuid) to authenticated;
grant execute on function public.my_activity() to authenticated;
grant execute on function public.friends_leaderboard(text, date, text) to authenticated;
