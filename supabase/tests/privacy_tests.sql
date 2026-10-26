-- Privacy tests for Lifts. Run in the Supabase SQL Editor after all the other SQL files.
--
-- It creates four pretend users inside a transaction, checks what each one can and cannot see,
-- then rolls everything back, so nothing is left behind in your database.
--   Passed: the last result says "All privacy tests passed".
--   Failed: it stops with an error starting "FAIL" that says which rule broke.
--
-- The pretend users: alice_t shares workouts with friends, plans publicly, and keeps meals and body stats private.
-- bob_t is her friend, carl_t is a stranger, dana_t is her friend until dana_t blocks her.

begin;

-- ---------- setup (as the database owner, so the privacy rules do not get in the way) ----------
insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'alice_t@example.invalid', '{}', '{"username":"alice_t"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'bob_t@example.invalid',   '{}', '{"username":"bob_t"}',   now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'carl_t@example.invalid',  '{}', '{"username":"carl_t"}',  now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', 'dana_t@example.invalid',  '{}', '{"username":"dana_t"}',  now(), now());

insert into public.profiles (user_id, body_kg, calc) values
  ('a0000000-0000-4000-8000-00000000000a', 61, '{"name":"Alice Test","age":30,"gender":"f"}'),
  ('b0000000-0000-4000-8000-00000000000b', 80, '{"name":"Bob Test"}'),
  ('c0000000-0000-4000-8000-00000000000c', 75, '{"name":"Carl Test"}'),
  ('d0000000-0000-4000-8000-00000000000d', 70, '{"name":"Dana Test"}');

insert into public.sharing (user_id, workouts, meals, plans, body) values
  ('a0000000-0000-4000-8000-00000000000a', 'friends', 'private', 'public', 'private');

insert into public.friendships (requester, addressee, status, accepted_at) values
  ('a0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-00000000000b', 'accepted', now()),
  ('d0000000-0000-4000-8000-00000000000d', 'a0000000-0000-4000-8000-00000000000a', 'accepted', now());

insert into public.workouts (id, user_id, workout_date, started_at, ended_at) values
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', current_date, now() - interval '1 hour', now());
insert into public.sets (user_id, workout_id, exercise, weight_kg, reps) values
  ('a0000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-000000000001', 'Bench press', 60, 5);
insert into public.meals (user_id, name, kcal) values ('a0000000-0000-4000-8000-00000000000a', 'Secret snack', 500);
insert into public.plans (user_id, name) values ('a0000000-0000-4000-8000-00000000000a', 'Alice plan');
insert into public.posts (id, user_id, kind, image_path, details) values
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'workout', 'a0000000-0000-4000-8000-00000000000a/p1.jpg', '{}');

-- ---------- as bob_t, Alice's friend ----------
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.view_profile('alice_t');
  if v is null then raise exception 'FAIL 1: a friend should see Alice''s profile'; end if;
  if not (v ? 'workouts') then raise exception 'FAIL 2: a friend should see workouts shared with friends'; end if;
  if v ? 'meals' then raise exception 'FAIL 3: a friend must not see meals set to Only me'; end if;
  if not (v ? 'plans') then raise exception 'FAIL 4: public plans should be visible'; end if;
  if v ? 'body' then raise exception 'FAIL 5: a friend must not see body stats set to Only me'; end if;
  if jsonb_array_length(public.user_posts('alice_t')) <> 1 then raise exception 'FAIL 6: a friend should see Alice''s post'; end if;
  if not exists (select 1 from jsonb_array_elements(public.friends_feed()) e where e ->> 'id' = '10000000-0000-4000-8000-000000000001')
    then raise exception 'FAIL 7: Alice''s post should be in a friend''s feed'; end if;
  perform public.react_to_post('10000000-0000-4000-8000-000000000001', 'fire');
  if public.get_post('10000000-0000-4000-8000-000000000001') -> 'reactions' ->> 'mine' is distinct from 'fire'
    then raise exception 'FAIL 8: a friend''s reaction should be saved'; end if;
  perform public.add_comment('10000000-0000-4000-8000-000000000001', 'Nice one');
  if not public.can_see_post_image('a0000000-0000-4000-8000-00000000000a/p1.jpg') then raise exception 'FAIL 9: a friend should see the post photo'; end if;
  -- The tables themselves stay closed: everything above came through the privacy-checking functions.
  if (select count(*) from public.meals where user_id = 'a0000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'FAIL 10: meals table readable by others'; end if;
  if (select count(*) from public.workouts where user_id = 'a0000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'FAIL 11: workouts table readable by others'; end if;
  if (select count(*) from public.posts where user_id = 'a0000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'FAIL 12: posts table readable by others'; end if;
  update public.sharing set meals = 'public' where user_id = 'a0000000-0000-4000-8000-00000000000a';
  perform public.report_content('10000000-0000-4000-8000-000000000001', null, 'spam', 'test');
  if (select count(*) from public.reports) <> 0 then raise exception 'FAIL 13: reports must not be readable from the app'; end if;
end $$;
reset role;

do $$ begin
  if (select meals from public.sharing where user_id = 'a0000000-0000-4000-8000-00000000000a') <> 'private'
    then raise exception 'FAIL 14: someone else changed Alice''s privacy settings'; end if;
  if (select count(*) from public.reports) <> 1 then raise exception 'FAIL 15: the report was not saved'; end if;
end $$;

-- ---------- as carl_t, a stranger ----------
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v jsonb; st jsonb;
begin
  v := public.view_profile('alice_t');
  if v is null then raise exception 'FAIL 16: anyone signed in can see a name and @username'; end if;
  if v ? 'workouts' then raise exception 'FAIL 17: a stranger must not see friends-only workouts'; end if;
  if not (v ? 'plans') then raise exception 'FAIL 18: public plans should be visible to anyone signed in'; end if;
  if v ? 'meals' or v ? 'body' then raise exception 'FAIL 19: a stranger must not see private meals or body stats'; end if;
  if jsonb_array_length(public.user_posts('alice_t')) <> 0 then raise exception 'FAIL 20: a stranger must not see posts'; end if;
  if public.get_post('10000000-0000-4000-8000-000000000001') is not null then raise exception 'FAIL 21: a stranger opened a post'; end if;
  if public.can_see_post_image('a0000000-0000-4000-8000-00000000000a/p1.jpg') then raise exception 'FAIL 22: a stranger can see a post photo'; end if;
  if jsonb_array_length(public.post_comments('10000000-0000-4000-8000-000000000001')) <> 0 then raise exception 'FAIL 23: a stranger can read comments'; end if;
  begin
    perform public.react_to_post('10000000-0000-4000-8000-000000000001', 'fire');
    raise exception 'FAIL 24: a stranger reacted to a friends-only post';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    perform public.add_comment('10000000-0000-4000-8000-000000000001', 'hi');
    raise exception 'FAIL 25: a stranger commented on a friends-only post';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    perform public.report_content('10000000-0000-4000-8000-000000000001', null, 'spam', null);
    raise exception 'FAIL 26: a stranger reported a post they cannot see';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  st := public.profile_stats('alice_t');
  if st ->> 'posts' is not null or st ->> 'workouts' is not null then raise exception 'FAIL 27: counts leak to a stranger'; end if;
  if not exists (select 1 from jsonb_array_elements(public.search_users('alic')) e where e ->> 'username' = 'alice_t')
    then raise exception 'FAIL 28: search should find alice_t'; end if;
  begin
    insert into public.verified (user_id) values ('c0000000-0000-4000-8000-00000000000c');
    raise exception 'FAIL 29: someone gave themselves a verified tick';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;
reset role;

-- ---------- Alice switches workouts to Only me ----------
update public.sharing set workouts = 'private' where user_id = 'a0000000-0000-4000-8000-00000000000a';
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if public.view_profile('alice_t') ? 'workouts' then raise exception 'FAIL 30: Only me workouts are still visible to friends'; end if;
  if exists (select 1 from jsonb_array_elements(public.friends_leaderboard('all', null::date, null::text)) e where e ->> 'username' = 'alice_t')
    then raise exception 'FAIL 31: someone with private workouts appears on a friend''s leaderboard'; end if;
end $$;
reset role;

-- ---------- as alice_t: her activity, and her own comments view ----------
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
do $$
declare c jsonb;
begin
  if not exists (select 1 from jsonb_array_elements(public.my_activity()) e where e ->> 'kind' = 'reaction' and e ->> 'username' = 'bob_t')
    then raise exception 'FAIL 32: Bob''s reaction should be in Alice''s activity'; end if;
  c := public.post_comments('10000000-0000-4000-8000-000000000001');
  if jsonb_array_length(c) <> 1 or (c -> 0 ->> 'can_delete')::boolean is not true then raise exception 'FAIL 33: the post owner should see and be able to delete comments'; end if;
  if (select count(*) from public.meals) <> 1 then raise exception 'FAIL 34: you should still see your own meals'; end if;
end $$;
reset role;

-- ---------- dana_t blocks Alice ----------
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  perform public.block_user('alice_t');
  if public.view_profile('alice_t') is not null then raise exception 'FAIL 35: the blocker can still open the profile'; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  if public.view_profile('dana_t') is not null then raise exception 'FAIL 36: a blocked person can open the blocker''s profile'; end if;
  if jsonb_array_length(public.search_users('dana')) <> 0 then raise exception 'FAIL 37: a blocked person can find the blocker in search'; end if;
  if exists (select 1 from jsonb_array_elements(public.my_friends()) e where e ->> 'username' = 'dana_t') then raise exception 'FAIL 38: blocking should unfriend'; end if;
  begin
    perform public.friend_action('dana_t', 'add');
    raise exception 'FAIL 39: a blocked person sent a friend request';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
  if not exists (select 1 from jsonb_array_elements(public.my_friends()) e where e ->> 'username' = 'bob_t') then raise exception 'FAIL 40: blocking someone else should not affect other friends'; end if;
end $$;
reset role;

rollback;

select 'All privacy tests passed (40 checks). Nothing was saved.' as result;
