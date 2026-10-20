-- Friends leaderboard for Lifts. Needs friends.sql to have been run first.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run. Safe to run again.

-- You and your accepted friends, with finished workouts and total weight moved since the start of the period.
-- period: 'week' (since Monday), 'month' (since the 1st) or anything else for all time.
-- Weight moved counts working and drop sets (weight x reps), not warmups or cardio, matching the workout summary.
-- Friends whose workouts are set to 'Only me' are left out.
create or replace function public.friends_leaderboard(period text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (
    select auth.uid() as id
  ),
  since as (
    select case period
      when 'week' then date_trunc('week', current_date)::date
      when 'month' then date_trunc('month', current_date)::date
      else null
    end as d
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
  stats as (
    select v.uid,
      (select count(*)
         from public.workouts w cross join since
         where w.user_id = v.uid and w.ended_at is not null
           and (since.d is null or w.workout_date >= since.d)) as workouts,
      (select coalesce(sum(x.weight_kg * x.reps), 0)
         from public.sets x
         join public.workouts w on w.id = x.workout_id
         cross join since
         where x.user_id = v.uid and w.ended_at is not null
           and not x.is_cardio and x.set_type <> 'warmup'
           and (since.d is null or w.workout_date >= since.d)) as volume_kg
    from visible v
  )
  select coalesce(jsonb_agg(
           public.lifts_card(s.uid) || jsonb_build_object(
             'me', s.uid = (select id from me),
             'workouts', s.workouts,
             'volume_kg', round(s.volume_kg, 1))), '[]'::jsonb)
  from stats s
  where public.lifts_card(s.uid) is not null;
$$;

revoke all on function public.friends_leaderboard(text) from public, anon;
grant execute on function public.friends_leaderboard(text) to authenticated;
