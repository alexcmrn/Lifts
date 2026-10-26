--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: am_i_verified(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.am_i_verified() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (select 1 from public.verified v where v.user_id = auth.uid());
$$;


--
-- Name: can_see_post(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_see_post(pid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.posts p
    where p.id = pid and public.lifts_relation(auth.uid(), p.user_id) in ('self', 'friends'));
$$;


--
-- Name: can_see_post_image(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_see_post_image(path text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.posts p
    where p.image_path = path
      and public.lifts_relation(auth.uid(), p.user_id) in ('self', 'friends'));
$$;


--
-- Name: claim_username_on_signup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_username_on_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  u text := lower(trim(new.raw_user_meta_data ->> 'username'));
begin
  if u is not null and u <> '' then
    insert into public.usernames (user_id, username) values (new.id, u);
  end if;
  return new;
end;
$$;


--
-- Name: delete_my_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_my_account() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;


--
-- Name: friend_action(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.friend_action(uname text, act text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: friends_feed(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.friends_feed(before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: friends_leaderboard(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.friends_leaderboard(period text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: lifts_can_see(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lifts_can_see(level text, rel text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select rel = 'self' or coalesce(level, 'private') = 'public' or (level = 'friends' and rel = 'friends');
$$;


--
-- Name: lifts_card(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lifts_card(uid uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'username', u.username,
    'name', coalesce(nullif(trim(p.calc ->> 'name'), ''), u.username),
    'verified', exists (select 1 from public.verified v where v.user_id = uid),
    'avatar', p.avatar_path)
  from public.usernames u
  left join public.profiles p on p.user_id = uid
  where u.user_id = uid;
$$;


--
-- Name: lifts_relation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lifts_relation(viewer uuid, owner uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: my_friends(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_friends() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: post_json(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_json(pid uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select public.lifts_card(p.user_id) || jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'caption', p.caption, 'image_path', p.image_path,
    'details', p.details, 'created_at', p.created_at, 'mine', p.user_id = auth.uid(),
    'reactions', public.post_reactions(p.id))
  from public.posts p
  where p.id = pid;
$$;


--
-- Name: post_reactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_reactions(pid uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(c.kind, c.n)
      from (select r.kind, count(*) as n from public.reactions r where r.post_id = pid group by r.kind) c), '{}'::jsonb),
    'mine', (select r.kind from public.reactions r where r.post_id = pid and r.user_id = auth.uid()));
$$;


--
-- Name: profile_stats(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.profile_stats(uname text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: react_to_post(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.react_to_post(pid uuid, reaction text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: search_users(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_users(q text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: user_posts(text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_posts(uname text, before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: username_available(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.username_available(name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select not exists (
    select 1 from public.usernames
    where username = lower(trim(name))
      and user_id is distinct from auth.uid()
  );
$$;


--
-- Name: view_profile(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.view_profile(uname text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    requester uuid NOT NULL,
    addressee uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT friendships_check CHECK ((requester <> addressee)),
    CONSTRAINT friendships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text])))
);


--
-- Name: meals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    meal_date date DEFAULT CURRENT_DATE NOT NULL,
    category text,
    name text NOT NULL,
    kcal numeric DEFAULT 0 NOT NULL,
    protein numeric DEFAULT 0 NOT NULL,
    carbs numeric DEFAULT 0 NOT NULL,
    fats numeric DEFAULT 0 NOT NULL,
    nutrients jsonb,
    product_info jsonb,
    amount_g numeric,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meals_category_check CHECK ((category = ANY (ARRAY['breakfast'::text, 'lunch'::text, 'dinner'::text, 'snack'::text])))
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    name text NOT NULL,
    exercises jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    kind text NOT NULL,
    caption text,
    image_path text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT posts_caption_check CHECK ((char_length(caption) <= 500)),
    CONSTRAINT posts_image_in_own_folder CHECK (((image_path IS NULL) OR (split_part(image_path, '/'::text, 1) = (user_id)::text))),
    CONSTRAINT posts_kind_check CHECK ((kind = ANY (ARRAY['workout'::text, 'meal'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    user_id uuid DEFAULT auth.uid() NOT NULL,
    unit text DEFAULT 'kg'::text NOT NULL,
    body_kg numeric,
    cal_target integer,
    targets jsonb DEFAULT '{}'::jsonb NOT NULL,
    calc jsonb DEFAULT '{}'::jsonb NOT NULL,
    bench jsonb DEFAULT '{}'::jsonb NOT NULL,
    avatar_path text,
    CONSTRAINT profiles_avatar_own_folder CHECK (((avatar_path IS NULL) OR (split_part(avatar_path, '/'::text, 1) = (user_id)::text))),
    CONSTRAINT profiles_unit_check CHECK ((unit = ANY (ARRAY['kg'::text, 'lb'::text])))
);


--
-- Name: reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reactions (
    post_id uuid NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reactions_kind_check CHECK ((kind = ANY (ARRAY['strong'::text, 'fire'::text, 'clap'::text, 'heart'::text])))
);


--
-- Name: schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    plan_id uuid,
    on_date date NOT NULL,
    repeat_weekly boolean DEFAULT false NOT NULL
);


--
-- Name: sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    workout_id uuid NOT NULL,
    exercise text NOT NULL,
    weight_kg numeric DEFAULT 0 NOT NULL,
    reps integer DEFAULT 0 NOT NULL,
    minutes numeric,
    is_cardio boolean DEFAULT false NOT NULL,
    set_type text DEFAULT 'working'::text NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sets_reps_check CHECK (((reps >= 0) AND (reps <= 100))),
    CONSTRAINT sets_set_type_check CHECK ((set_type = ANY (ARRAY['warmup'::text, 'working'::text, 'drop'::text]))),
    CONSTRAINT sets_weight_kg_check CHECK ((weight_kg >= (0)::numeric))
);


--
-- Name: sharing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sharing (
    user_id uuid NOT NULL,
    workouts text DEFAULT 'friends'::text NOT NULL,
    meals text DEFAULT 'private'::text NOT NULL,
    plans text DEFAULT 'friends'::text NOT NULL,
    body text DEFAULT 'private'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sharing_levels CHECK (((workouts = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])) AND (meals = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])) AND (plans = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text])) AND (body = ANY (ARRAY['public'::text, 'friends'::text, 'private'::text]))))
);


--
-- Name: usernames; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usernames (
    user_id uuid NOT NULL,
    username text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usernames_format CHECK ((username ~ '^[a-z0-9_]{3,20}$'::text))
);


--
-- Name: verified; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verified (
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    plan_id uuid,
    plan_name text,
    workout_date date DEFAULT CURRENT_DATE NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (requester, addressee);


--
-- Name: meals meals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meals
    ADD CONSTRAINT meals_pkey PRIMARY KEY (id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: posts posts_image_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_image_path_key UNIQUE (image_path);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);


--
-- Name: reactions reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_pkey PRIMARY KEY (post_id, user_id);


--
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (id);


--
-- Name: sets sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sets
    ADD CONSTRAINT sets_pkey PRIMARY KEY (id);


--
-- Name: sharing sharing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sharing
    ADD CONSTRAINT sharing_pkey PRIMARY KEY (user_id);


--
-- Name: usernames usernames_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usernames
    ADD CONSTRAINT usernames_pkey PRIMARY KEY (user_id);


--
-- Name: usernames usernames_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usernames
    ADD CONSTRAINT usernames_username_key UNIQUE (username);


--
-- Name: verified verified_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified
    ADD CONSTRAINT verified_pkey PRIMARY KEY (user_id);


--
-- Name: workouts workouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workouts
    ADD CONSTRAINT workouts_pkey PRIMARY KEY (id);


--
-- Name: friendships_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX friendships_pair ON public.friendships USING btree (LEAST(requester, addressee), GREATEST(requester, addressee));


--
-- Name: posts_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX posts_user_created ON public.posts USING btree (user_id, created_at DESC);


--
-- Name: friendships friendships_addressee_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_addressee_fkey FOREIGN KEY (addressee) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_requester_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_requester_fkey FOREIGN KEY (requester) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: meals meals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meals
    ADD CONSTRAINT meals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plans plans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: posts posts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: schedule schedule_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;


--
-- Name: schedule schedule_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sets sets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sets
    ADD CONSTRAINT sets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sets sets_workout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sets
    ADD CONSTRAINT sets_workout_id_fkey FOREIGN KEY (workout_id) REFERENCES public.workouts(id) ON DELETE CASCADE;


--
-- Name: sharing sharing_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sharing
    ADD CONSTRAINT sharing_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: usernames usernames_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usernames
    ADD CONSTRAINT usernames_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: verified verified_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified
    ADD CONSTRAINT verified_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: workouts workouts_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workouts
    ADD CONSTRAINT workouts_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE SET NULL;


--
-- Name: workouts workouts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workouts
    ADD CONSTRAINT workouts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: posts add own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "add own posts" ON public.posts FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: sharing add own sharing; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "add own sharing" ON public.sharing FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: usernames add own username; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "add own username" ON public.usernames FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: sharing change own sharing; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "change own sharing" ON public.sharing FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: usernames change own username; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "change own username" ON public.usernames FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: posts delete own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "delete own posts" ON public.posts FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: friendships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

--
-- Name: meals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;

--
-- Name: meals own rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own rows" ON public.meals TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: plans own rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own rows" ON public.plans TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: profiles own rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own rows" ON public.profiles TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: schedule own rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own rows" ON public.schedule TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: sets own rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own rows" ON public.sets TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: workouts own rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own rows" ON public.workouts TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

--
-- Name: posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: posts read own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own posts" ON public.posts FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: sharing read own sharing; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own sharing" ON public.sharing FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: usernames read own username; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "read own username" ON public.usernames FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sets ENABLE ROW LEVEL SECURITY;

--
-- Name: sharing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sharing ENABLE ROW LEVEL SECURITY;

--
-- Name: usernames; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usernames ENABLE ROW LEVEL SECURITY;

--
-- Name: verified; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.verified ENABLE ROW LEVEL SECURITY;

--
-- Name: workouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workouts ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION am_i_verified(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.am_i_verified() FROM PUBLIC;
GRANT ALL ON FUNCTION public.am_i_verified() TO authenticated;
GRANT ALL ON FUNCTION public.am_i_verified() TO service_role;


--
-- Name: FUNCTION can_see_post(pid uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.can_see_post(pid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_see_post(pid uuid) TO service_role;


--
-- Name: FUNCTION can_see_post_image(path text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.can_see_post_image(path text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_see_post_image(path text) TO authenticated;
GRANT ALL ON FUNCTION public.can_see_post_image(path text) TO service_role;


--
-- Name: FUNCTION claim_username_on_signup(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_username_on_signup() TO anon;
GRANT ALL ON FUNCTION public.claim_username_on_signup() TO authenticated;
GRANT ALL ON FUNCTION public.claim_username_on_signup() TO service_role;


--
-- Name: FUNCTION delete_my_account(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_my_account() TO authenticated;
GRANT ALL ON FUNCTION public.delete_my_account() TO service_role;


--
-- Name: FUNCTION friend_action(uname text, act text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.friend_action(uname text, act text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.friend_action(uname text, act text) TO authenticated;
GRANT ALL ON FUNCTION public.friend_action(uname text, act text) TO service_role;


--
-- Name: FUNCTION friends_feed(before timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.friends_feed(before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.friends_feed(before timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.friends_feed(before timestamp with time zone) TO service_role;


--
-- Name: FUNCTION friends_leaderboard(period text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.friends_leaderboard(period text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.friends_leaderboard(period text) TO authenticated;
GRANT ALL ON FUNCTION public.friends_leaderboard(period text) TO service_role;


--
-- Name: FUNCTION lifts_can_see(level text, rel text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lifts_can_see(level text, rel text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lifts_can_see(level text, rel text) TO service_role;


--
-- Name: FUNCTION lifts_card(uid uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lifts_card(uid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lifts_card(uid uuid) TO service_role;


--
-- Name: FUNCTION lifts_relation(viewer uuid, owner uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lifts_relation(viewer uuid, owner uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lifts_relation(viewer uuid, owner uuid) TO service_role;


--
-- Name: FUNCTION my_friends(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.my_friends() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_friends() TO authenticated;
GRANT ALL ON FUNCTION public.my_friends() TO service_role;


--
-- Name: FUNCTION post_json(pid uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_json(pid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_json(pid uuid) TO service_role;


--
-- Name: FUNCTION post_reactions(pid uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_reactions(pid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_reactions(pid uuid) TO service_role;


--
-- Name: FUNCTION profile_stats(uname text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.profile_stats(uname text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.profile_stats(uname text) TO authenticated;
GRANT ALL ON FUNCTION public.profile_stats(uname text) TO service_role;


--
-- Name: FUNCTION react_to_post(pid uuid, reaction text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.react_to_post(pid uuid, reaction text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.react_to_post(pid uuid, reaction text) TO authenticated;
GRANT ALL ON FUNCTION public.react_to_post(pid uuid, reaction text) TO service_role;


--
-- Name: FUNCTION search_users(q text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.search_users(q text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_users(q text) TO authenticated;
GRANT ALL ON FUNCTION public.search_users(q text) TO service_role;


--
-- Name: FUNCTION user_posts(uname text, before timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_posts(uname text, before timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_posts(uname text, before timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.user_posts(uname text, before timestamp with time zone) TO service_role;


--
-- Name: FUNCTION username_available(name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.username_available(name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.username_available(name text) TO anon;
GRANT ALL ON FUNCTION public.username_available(name text) TO authenticated;
GRANT ALL ON FUNCTION public.username_available(name text) TO service_role;


--
-- Name: FUNCTION view_profile(uname text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.view_profile(uname text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.view_profile(uname text) TO authenticated;
GRANT ALL ON FUNCTION public.view_profile(uname text) TO service_role;


--
-- Name: TABLE friendships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.friendships TO anon;
GRANT ALL ON TABLE public.friendships TO authenticated;
GRANT ALL ON TABLE public.friendships TO service_role;


--
-- Name: TABLE meals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meals TO anon;
GRANT ALL ON TABLE public.meals TO authenticated;
GRANT ALL ON TABLE public.meals TO service_role;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.plans TO anon;
GRANT ALL ON TABLE public.plans TO authenticated;
GRANT ALL ON TABLE public.plans TO service_role;


--
-- Name: TABLE posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.posts TO anon;
GRANT ALL ON TABLE public.posts TO authenticated;
GRANT ALL ON TABLE public.posts TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE reactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reactions TO anon;
GRANT ALL ON TABLE public.reactions TO authenticated;
GRANT ALL ON TABLE public.reactions TO service_role;


--
-- Name: TABLE schedule; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedule TO anon;
GRANT ALL ON TABLE public.schedule TO authenticated;
GRANT ALL ON TABLE public.schedule TO service_role;


--
-- Name: TABLE sets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sets TO anon;
GRANT ALL ON TABLE public.sets TO authenticated;
GRANT ALL ON TABLE public.sets TO service_role;


--
-- Name: TABLE sharing; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sharing TO anon;
GRANT ALL ON TABLE public.sharing TO authenticated;
GRANT ALL ON TABLE public.sharing TO service_role;


--
-- Name: TABLE usernames; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.usernames TO anon;
GRANT ALL ON TABLE public.usernames TO authenticated;
GRANT ALL ON TABLE public.usernames TO service_role;


--
-- Name: TABLE verified; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.verified TO anon;
GRANT ALL ON TABLE public.verified TO authenticated;
GRANT ALL ON TABLE public.verified TO service_role;


--
-- Name: TABLE workouts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workouts TO anon;
GRANT ALL ON TABLE public.workouts TO authenticated;
GRANT ALL ON TABLE public.workouts TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


