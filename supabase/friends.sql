-- Friends, per-section privacy and verified ticks for Lifts.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.
--
-- How access works: nobody can read anyone else's tables directly (the existing "own rows" policies stay as they are).
-- Other people's data only comes out through view_profile(), which checks the owner's privacy setting for each section.

-- 1. Privacy settings, one row per account. Each section is 'public' (anyone signed in),
--    'friends' (accepted friends) or 'private' (only you). No row means the defaults below.
create table if not exists public.sharing (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  workouts   text not null default 'friends',
  meals      text not null default 'private',
  plans      text not null default 'friends',
  body       text not null default 'private',
  updated_at timestamptz not null default now(),
  constraint sharing_levels check (
    workouts in ('public', 'friends', 'private') and meals in ('public', 'friends', 'private') and
    plans in ('public', 'friends', 'private') and body in ('public', 'friends', 'private'))
);
alter table public.sharing enable row level security;

drop policy if exists "read own sharing" on public.sharing;
create policy "read own sharing" on public.sharing
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "add own sharing" on public.sharing;
create policy "add own sharing" on public.sharing
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "change own sharing" on public.sharing;
create policy "change own sharing" on public.sharing
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2. Verified accounts. No policies, so the app can never add or remove a tick itself:
--    only you can, from the SQL Editor (see step 6).
create table if not exists public.verified (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.verified enable row level security;

-- 3. Friendships. A row is a request until the other person accepts it.
--    No policies: every change goes through friend_action() below.
create table if not exists public.friendships (
  requester  uuid not null references auth.users (id) on delete cascade,
  addressee  uuid not null references auth.users (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- Only one row per pair of people, whichever way round the request went.
create unique index if not exists friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
alter table public.friendships enable row level security;

-- 4. Internal helpers (not callable from the app).

-- How the viewer relates to the owner: self, friends, outgoing (viewer asked), incoming (owner asked) or none.
create or replace function public.lifts_relation(viewer uuid, owner uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when viewer is null then 'none'
    when viewer = owner then 'self'
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
  select rel = 'self' or coalesce(level, 'private') = 'public' or (level = 'friends' and rel = 'friends');
$$;

-- What anyone signed in can see about an account: @username, display name and the verified tick.
create or replace function public.lifts_card(uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'username', u.username,
    'name', coalesce(nullif(trim(p.calc ->> 'name'), ''), u.username),
    'verified', exists (select 1 from public.verified v where v.user_id = uid))
  from public.usernames u
  left join public.profiles p on p.user_id = uid
  where u.user_id = uid;
$$;

revoke all on function public.lifts_relation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.lifts_can_see(text, text) from public, anon, authenticated;
revoke all on function public.lifts_card(uuid) from public, anon, authenticated;

-- 5. Functions the app calls.

-- Usernames starting with what was typed (at least 2 characters), with how you relate to each person.
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
    order by n.username
    limit 20
  ) u;
$$;

-- Your friends, plus requests you have sent and received.
create or replace function public.my_friends()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.card || jsonb_build_object('relation', x.rel) order by x.card ->> 'username'), '[]'::jsonb)
  from (
    select public.lifts_card(case when f.requester = auth.uid() then f.addressee else f.requester end) as card,
           case when f.status = 'accepted' then 'friends'
                when f.requester = auth.uid() then 'outgoing'
                else 'incoming' end as rel
    from public.friendships f
    where auth.uid() in (f.requester, f.addressee)
  ) x
  where x.card is not null;
$$;

-- act = 'add': send a request, or accept theirs if they already asked you.
-- act = 'remove': unfriend, cancel your request or decline theirs.
-- Returns the new relation.
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
  if act = 'add' then
    if rel = 'none' then
      insert into public.friendships (requester, addressee) values (me, other);
    elsif rel = 'incoming' then
      update public.friendships set status = 'accepted' where requester = other and addressee = me;
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

-- Someone's profile, with each section included only if their privacy setting lets you see it.
-- Workouts: last 30 finished. Meals: last 14 days. Schedule: from a week ago onwards, plus repeating ones.
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

-- Whether your own account has the verified tick.
create or replace function public.am_i_verified()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.verified v where v.user_id = auth.uid());
$$;

revoke all on function public.search_users(text) from public, anon;
revoke all on function public.my_friends() from public, anon;
revoke all on function public.friend_action(text, text) from public, anon;
revoke all on function public.view_profile(text) from public, anon;
revoke all on function public.am_i_verified() from public, anon;
grant execute on function public.search_users(text) to authenticated;
grant execute on function public.my_friends() to authenticated;
grant execute on function public.friend_action(text, text) to authenticated;
grant execute on function public.view_profile(text) to authenticated;
grant execute on function public.am_i_verified() to authenticated;

-- 6. Give @alex the verified tick. To verify someone else later, run this line with their username.
insert into public.verified (user_id)
select user_id from public.usernames where username = 'alex'
on conflict (user_id) do nothing;
