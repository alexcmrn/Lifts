-- Profile header counts for Lifts (posts, friends, workouts). Needs friends.sql and posts.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.

-- Counts for someone's profile header. Each one follows the same rules as the thing it counts:
--   friends:  anyone signed in can see how many friends someone has.
--   posts:    only you and your friends (null for anyone else).
--   workouts: only if their Workouts privacy setting lets you see their workouts (null otherwise).
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
  select coalesce(s.workouts, 'friends') into lv from (select 1) one left join public.sharing s on s.user_id = uid;
  return jsonb_build_object(
    'friends', (select count(*) from public.friendships f where f.status = 'accepted' and uid in (f.requester, f.addressee)),
    'posts', case when rel in ('self', 'friends') then (select count(*) from public.posts p where p.user_id = uid) end,
    'workouts', case when public.lifts_can_see(lv, rel) then (select count(*) from public.workouts w where w.user_id = uid and w.ended_at is not null) end);
end;
$$;

revoke all on function public.profile_stats(text) from public, anon;
grant execute on function public.profile_stats(text) to authenticated;
