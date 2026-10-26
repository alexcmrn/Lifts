-- Blocking and reporting for Lifts. Needs friends.sql, posts.sql, reactions.sql and profile.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.
--
-- How blocking works: lifts_relation() now answers 'blocked' when either person has blocked the other.
-- Every privacy check is built on it, so a block hides each person's profile, posts, photos, comments and
-- reactions from the other, removes them from search and stops friend requests. Blocking also unfriends.
--
-- This file replaces lifts_relation, lifts_can_see, search_users, friend_action, view_profile and profile_stats.
-- If you ever re-run friends.sql or profile.sql, run this file again afterwards.

-- 1. Blocks. Only you can see who you have blocked, through my_blocks().
create table if not exists public.blocks (
  blocker    uuid not null references auth.users (id) on delete cascade,
  blocked    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
alter table public.blocks enable row level security;

-- 2. Reports. Nobody can read these from the app: review them in the dashboard (Table Editor > reports).
--    snapshot keeps what the post looked like when it was reported, in case it is deleted afterwards.
--    To remove a reported post: delete its row in the posts table, then its photo in Storage > posts.
create table if not exists public.reports (
  id         uuid primary key default gen_random_uuid(),
  reporter   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  post_id    uuid references public.posts (id) on delete set null,
  user_id    uuid references auth.users (id) on delete cascade,
  reason     text not null check (reason in ('spam', 'inappropriate', 'harassment', 'other')),
  details    text check (char_length(details) <= 1000),
  snapshot   jsonb,
  status     text not null default 'open' check (status in ('open', 'reviewed', 'actioned')),
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;

-- When a friend request was accepted, for the activity list.
alter table public.friendships add column if not exists accepted_at timestamptz;

-- 3. Blocks feed into every privacy check.
create or replace function public.lifts_relation(viewer uuid, owner uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when viewer is null then 'none'
    when viewer = owner then 'self'
    when exists (select 1 from public.blocks b
                 where (b.blocker = viewer and b.blocked = owner) or (b.blocker = owner and b.blocked = viewer)) then 'blocked'
    else coalesce((
      select case when f.status = 'accepted' then 'friends'
                  when f.requester = viewer then 'outgoing'
                  else 'incoming' end
      from public.friendships f
      where (f.requester = viewer and f.addressee = owner) or (f.requester = owner and f.addressee = viewer)
      limit 1), 'none')
  end;
$$;

create or replace function public.lifts_can_see(level text, rel text)
returns boolean language sql immutable set search_path = '' as $$
  select rel is distinct from 'blocked'
    and (rel = 'self' or coalesce(level, 'private') = 'public' or (level = 'friends' and rel = 'friends'));
$$;

revoke all on function public.lifts_relation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.lifts_can_see(text, text) from public, anon, authenticated;

-- 4. Search leaves out anyone either of you has blocked.
create or replace function public.search_users(q text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with term as (select lower(trim(both '@' from trim(coalesce(q, '')))) as t)
  select coalesce(jsonb_agg(public.lifts_card(u.user_id) || jsonb_build_object('relation', public.lifts_relation(auth.uid(), u.user_id))
                            order by u.username), '[]'::jsonb)
  from (
    select n.user_id, n.username
    from public.usernames n, term
    where auth.uid() is not null
      and length(term.t) >= 2
      and left(n.username, length(term.t)) = term.t
      and n.user_id <> auth.uid()
      and public.lifts_relation(auth.uid(), n.user_id) <> 'blocked'
    order by n.username
    limit 20
  ) u;
$$;

-- 5. Friend requests: refused while either of you has blocked the other, and accepted_at is recorded.
create or replace function public.friend_action(uname text, act text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  other uuid;
  rel text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select user_id into other from public.usernames where username = lower(trim(both '@' from trim(uname)));
  if other is null then raise exception 'No one has that username'; end if;
  if other = me then raise exception 'You cannot add yourself'; end if;
  rel := public.lifts_relation(me, other);
  if rel = 'blocked' then raise exception 'No one has that username'; end if;
  if act = 'add' then
    if rel = 'none' then
      insert into public.friendships (requester, addressee) values (me, other);
    elsif rel = 'incoming' then
      update public.friendships set status = 'accepted', accepted_at = now() where requester = other and addressee = me;
    end if;
  elsif act = 'remove' then
    delete from public.friendships
    where (requester = me and addressee = other) or (requester = other and addressee = me);
  else
    raise exception 'Unknown action';
  end if;
  return public.lifts_relation(me, other);
end;
$$;

-- 6. A blocked profile looks the same as one that does not exist.
create or replace function public.view_profile(uname text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  uid uuid;
  rel text;
  lv_w text; lv_m text; lv_p text; lv_b text;
  result jsonb;
begin
  if me is null then return null; end if;
  select user_id into uid from public.usernames where username = lower(trim(both '@' from trim(uname)));
  if uid is null then return null; end if;
  rel := public.lifts_relation(me, uid);
  if rel = 'blocked' then return null; end if;

  select coalesce(s.workouts, 'friends'), coalesce(s.meals, 'private'), coalesce(s.plans, 'friends'), coalesce(s.body, 'private')
    into lv_w, lv_m, lv_p, lv_b
  from (select 1) one
  left join public.sharing s on s.user_id = uid;

  result := public.lifts_card(uid) || jsonb_build_object(
    'relation', rel,
    'sharing', jsonb_build_object('workouts', lv_w, 'meals', lv_m, 'plans', lv_p, 'body', lv_b));

  if public.lifts_can_see(lv_b, rel) then
    result := result || jsonb_build_object('body', (
      select jsonb_build_object('weight_kg', p.body_kg, 'age', p.calc -> 'age', 'gender', p.calc -> 'gender')
      from public.profiles p where p.user_id = uid));
  end if;

  if public.lifts_can_see(lv_w, rel) then
    result := result || jsonb_build_object('workouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', w.workout_date, 'started_at', w.started_at, 'ended_at', w.ended_at, 'plan', w.plan_name,
        'sets', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'exercise', x.exercise, 'kg', x.weight_kg, 'reps', x.reps, 'mins', x.minutes, 'cardio', x.is_cardio, 'type', x.set_type)
            order by x.logged_at), '[]'::jsonb)
          from public.sets x where x.workout_id = w.id and x.user_id = uid)
        ) order by w.workout_date desc, w.started_at desc), '[]'::jsonb)
      from (
        select * from public.workouts
        where user_id = uid and ended_at is not null
        order by workout_date desc, started_at desc
        limit 30
      ) w));
  end if;

  if public.lifts_can_see(lv_m, rel) then
    result := result || jsonb_build_object(
      'cal_target', (select p.cal_target from public.profiles p where p.user_id = uid),
      'meals', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'date', m.meal_date, 'name', m.name, 'category', m.category,
          'kcal', m.kcal, 'protein', m.protein, 'carbs', m.carbs, 'fats', m.fats)
          order by m.meal_date desc, m.logged_at), '[]'::jsonb)
        from public.meals m
        where m.user_id = uid and m.meal_date >= current_date - 13));
  end if;

  if public.lifts_can_see(lv_p, rel) then
    result := result || jsonb_build_object(
      'plans', (
        select coalesce(jsonb_agg(jsonb_build_object('name', pl.name, 'exercises', pl.exercises) order by pl.name), '[]'::jsonb)
        from public.plans pl where pl.user_id = uid),
      'schedule', (
        select coalesce(jsonb_agg(jsonb_build_object('date', sc.on_date, 'repeat', sc.repeat_weekly, 'plan', pl.name)
                                  order by sc.on_date), '[]'::jsonb)
        from public.schedule sc
        left join public.plans pl on pl.id = sc.plan_id
        where sc.user_id = uid and (sc.on_date >= current_date - 7 or sc.repeat_weekly)));
  end if;

  return result;
end;
$$;

-- 7. Profile counts: nothing for a blocked profile.
create or replace function public.profile_stats(uname text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  uid uuid;
  rel text;
  lv text;
begin
  if me is null then return null; end if;
  select user_id into uid from public.usernames where username = lower(trim(both '@' from trim(uname)));
  if uid is null then return null; end if;
  rel := public.lifts_relation(me, uid);
  if rel = 'blocked' then return null; end if;
  select coalesce(s.workouts, 'friends') into lv from (select 1) one left join public.sharing s on s.user_id = uid;
  return jsonb_build_object(
    'friends', (select count(*) from public.friendships f where f.status = 'accepted' and uid in (f.requester, f.addressee)),
    'posts', case when rel in ('self', 'friends') then (select count(*) from public.posts p where p.user_id = uid) end,
    'workouts', case when public.lifts_can_see(lv, rel) then (select count(*) from public.workouts w where w.user_id = uid and w.ended_at is not null) end);
end;
$$;

-- 8. Block, unblock and list.
create or replace function public.block_user(uname text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  other uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select user_id into other from public.usernames where username = lower(trim(both '@' from trim(uname)));
  if other is null or other = me then raise exception 'No one has that username'; end if;
  insert into public.blocks (blocker, blocked) values (me, other) on conflict do nothing;
  delete from public.friendships where (requester = me and addressee = other) or (requester = other and addressee = me);
end;
$$;

create or replace function public.unblock_user(uname text)
returns void language sql security definer set search_path = '' as $$
  delete from public.blocks b
  using public.usernames u
  where u.username = lower(trim(both '@' from trim(uname))) and b.blocker = auth.uid() and b.blocked = u.user_id;
$$;

create or replace function public.my_blocks()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c.card order by c.card ->> 'username'), '[]'::jsonb)
  from (select public.lifts_card(b.blocked) as card from public.blocks b where b.blocker = auth.uid()) c
  where c.card is not null;
$$;

-- 9. Report a post (target_post) or an account (target_user). You can only report a post you can see.
create or replace function public.report_content(target_post uuid, target_user text, reason text, details text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  uid uuid;
  snap jsonb;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if target_post is not null then
    if not public.can_see_post(target_post) then raise exception 'Post not found'; end if;
    select p.user_id, public.post_json(p.id) into uid, snap from public.posts p where p.id = target_post;
  else
    select user_id into uid from public.usernames where username = lower(trim(both '@' from trim(target_user)));
    if uid is null then raise exception 'No one has that username'; end if;
    snap := public.lifts_card(uid);
  end if;
  insert into public.reports (reporter, post_id, user_id, reason, details, snapshot)
  values (me, target_post, uid, reason, nullif(left(trim(coalesce(details, '')), 1000), ''), snap);
end;
$$;

revoke all on function public.search_users(text) from public, anon;
revoke all on function public.friend_action(text, text) from public, anon;
revoke all on function public.view_profile(text) from public, anon;
revoke all on function public.profile_stats(text) from public, anon;
revoke all on function public.block_user(text) from public, anon;
revoke all on function public.unblock_user(text) from public, anon;
revoke all on function public.my_blocks() from public, anon;
revoke all on function public.report_content(uuid, text, text, text) from public, anon;
grant execute on function public.search_users(text) to authenticated;
grant execute on function public.friend_action(text, text) to authenticated;
grant execute on function public.view_profile(text) to authenticated;
grant execute on function public.profile_stats(text) to authenticated;
grant execute on function public.block_user(text) to authenticated;
grant execute on function public.unblock_user(text) to authenticated;
grant execute on function public.my_blocks() to authenticated;
grant execute on function public.report_content(uuid, text, text, text) to authenticated;
