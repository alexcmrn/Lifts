
First, check the setup in the SQL Editor:

select username from public.usernames u join public.verified v using (user_id);
That should return alex. If it returns nothing, your username isn’t exactly alex; run the last part of friends.sql again with your real username.

The new app code isn’t committed or pushed yet, so your live site still has the old version. Test it locally from the project folder for now:

npx serve C:/Workspace/Lifts/Lifts
You’ll need two accounts: yours (A) and a test account with a username (B). Use a private browser window for B so you can be logged into both at once.

1. Setup

As A, open Profile. Your name should have the blue tick and a Privacy card should appear below.
As B, the Friends tab should show the search box, not “not switched on yet”.
2. Requests

As A, search B's first 2 letters and tap Add. It should change to Requested.
As B, open Friends (tap the tab to refresh). A’s request should appear with Accept/Decline, and your blue tick should show next to your name.
B taps Accept. Both of you should now see each other under Your friends.
3. Privacy, from A’s side (have B view A’s profile after each change, re-opening it to refresh):

A sets	B should see
Workouts: Friends	A’s workouts
Workouts: Only me	🔒 “Only Alex can see this”
Meals: Public, then unfriend	A’s meals still visible to B
Meals: Friends, while not friends	🔒 “Only Alex’s friends can see this”
Body: Only me	🔒 Body section
4. Other actions

Remove friend (tap twice) on one side. Both lists should update.
Cancel a sent request, and Decline an incoming one. Each should disappear from both accounts.
Search your own username: you shouldn’t appear.
Search for a name nobody has: you should see “No one found…”.
5. Things that shouldn’t have changed

Log a workout and a meal as A, and check no “couldn’t sync” error appears.
Change a privacy setting, reload the page, and check it stuck.
If something fails

Red error mentioning “not set up”: the app can’t find the functions. Re-run friends.sql and check for an error at the bottom of the SQL Editor output.
Anything else: paste me the red error, or the console error (F12).
When it all passes, tell me and I’ll commit and push.

okay push

Pushed main
Pushed. The friends tab, privacy settings and verified tick are on GitHub as def2485 in alexcmrn/Lifts. If your site is served from the repo, it should update within a minute or two; hard-refresh with Ctrl+Shift+R if you still see the old version.

supabase/schema.sql doesn’t include the new friends tables yet. friends.sql is in the repo, so nothing is lost, but to bring the export up to date, re-run the same pg_dump command from before. Then tell me and I’ll commit the new version.

okay i think it would be good to add a leaderboard in the friends section and u can filter by different things eventually exercises but for right now maybe just total workouts or total weight moved,  i think after each workout it would be good to show total weight moved

Ran a command, created leaderboard.sql
The SQL is written. Now the app: a Friends | Leaderboard switch at the top of the Friends tab, and a “Total weight moved” card on the workout summary.

Created board.js, ran 2 commands, used a tool
Ranking, ties and filters all work. Next, the workout summary: I’ll finish a Push day in the preview so it compares with the previous one.

Used 2 tools
The leaderboard and the “total weight moved” card are both built and working in the preview with fake data. To switch the leaderboard on for real, run supabase/leaderboard.sql in the Supabase SQL Editor. It needs friends.sql first, which you’ve already run. Nothing is committed yet.

Leaderboard (Friends tab)
The top of the Friends tab now has a Friends | Leaderboard switch.

Rank by: Weight moved or Workouts.
Time period: This week (from Monday), This month, or All time.
Your row is highlighted. The top 3 get gold, silver and bronze medals, and people level on the same number share a rank.
Each row also shows the other number: if you rank by weight, you still see how many workouts each person did.
Tap a friend to open their profile.
Privacy: friends who’ve set Workouts to “Only me” don’t appear.
Weight moved is weight × reps for working and drop sets. It leaves out warmups and cardio, so warming up with the empty bar doesn’t count. That’s the same rule the workout summary already used for its volume, so the two numbers always match.

Filtering by exercise later will slot into the same “Rank by” switch. On the database side it means one extra input to the same function.

After each workout
The summary now opens with a big Total weight moved card, followed by Time, Exercises and Sets. If you’ve done the same plan before, it compares with your last session: a green “+12% vs your last Push day”, or “−29% vs your last Push day” if you moved less.

Workouts with no lifting, such as cardio only, don’t show the card. The old Volume tile has gone, since the card replaces it.

Tested in the preview
Ranking: volume, workouts and ties all ranked correctly. Switching to This month reloaded the numbers.
Summary: I finished a Push day with 3 × 90 kg × 8, and it showed 2,160 kg, −29% vs your last Push day.
Untested: none of this has run against your live database yet.
The leaderboard is built in the Friends tab, ranking you and your friends by weight moved or workouts this week, this month or all time. Every workout summary now leads with total weight moved compared with your last session of the same plan. Both are tested in the preview with fake data. supabase/leaderboard.sql isn't run yet, and nothing is committed.
Have you run supabase/leaderboard.sql in Supabase?
Done, ran it
I ran supabase/leaderboard.sql. Commit and push.

Pushed main
I’ve committed and pushed the leaderboard and the “total weight moved” summary as e48a665 on alexcmrn/Lifts. If your site is served from the repo, it should update within a minute or two.

I haven’t seen it running against your live database yet. A quick check: open Friends → Leaderboard and confirm you and your test friend appear with the right numbers.

supabase/schema.sql is still the export from before friends and the leaderboard. Re-run the pg_dump command from before to bring it up to date, then I’ll commit the new version.

okay next when u are doing a workout and it has like 1 drop set 2 working 3 working i think its a bit confusing as it looks like u r doing 2 working sets can u remove the numbers, and next i would like at the end of a workout if u can take a photo and upload it for ur friends to see their should be like a feed in the friends tabs and u can do the same for meals

Two things: dropping the set numbers, and photo posts with a feed. Starting with where the numbers appear.

Searched class="n"|'Set ' \+|\(j \+ 1\) \+ ' ' \+ typeName|class="srow
Found them. Also, while checking I spotted something: the last commit added a second function named setText, which may clash with one the workout screen already uses. Checking.

Ran 2 commands
I confirmed the issue: my friend-profile code accidentally overwrote the workout screen’s setText, causing logged sets to drop the “kg” unit and warmup/drop sets to show extra “(warmup)”/”(drop)” text next to their chip. I’ll fix both the unit display and the chip labeling now.

Ran 2 commands
Set numbers are gone and the clash is fixed. Next, the database side for photo posts: a private storage bucket, plus a posts table that only you and your friends can read.

Created posts.sql
SQL done. Before writing the app code, checking whether the in-app Privacy Policy lists what’s stored. Photos and friend sharing are new kinds of data.

Read the in-app privacy policy
The in-app Privacy Policy still claims data is only visible to your own login, which is now outdated since friends launched yesterday — I’ll update that text while I write the posts and feed code.

Created posts.js, ran a command
Code compiles. Now I’m giving the preview’s fake backend photo storage and a few sample posts so I can test sharing and the feed.

Ran 2 commands, used a tool
No numbers, and “kg” is back on logged sets. Next: finish the workout, then share a photo.

Used 3 tools
Found a variable name clash in the preview’s fake backend that was preventing my post from saving. Fixing that now and checking that photos load correctly.

Ran a command, used a tool
The feed works: my new meal post shows first with its photo, ahead of the sample posts. One thing to fix: “Delete” on my own post is being cut off at the card’s edge. Measuring why.

Ran a command, used a tool
The app’s top-bar styles target every <header> element, and the post card used one. Switching it to a plain <div>.

Ran a command, used 2 tools, finished a background task (1 stopped)
I made both changes and tested them in the preview with fake data; nothing is committed yet. I also found and fixed a bug I introduced in the friends update that’s affecting your live app now.

The live bug
A function I added for friend profiles had the same name as one the workout screen uses, and it replaced it. Since the friends push, logged sets on the live app show “80 × 5” with no “kg”. Warmup and drop sets also show an extra “(warmup)” or “(drop)” next to their chip. I renamed my function, and logged sets read “90 kg × 8” again. It stays broken on the live app until we push.

Set numbers removed
During a workout: logged sets no longer have a number in front. Sets you haven’t logged yet now say “Working set”, “Warmup set” or “Drop set” instead of “Set 2”. The type is shown by the coloured chip and edge.
Plan editor: the set buttons say just “Warmup”, “Working” or “Drop” instead of “1 Drop”, “2 Working”.
Photo posts and the feed
After a workout: the summary has a Share a photo button. It opens a sheet showing what you’re sharing, for example “Push day · 2,160 kg moved · 3 sets”. You add a photo (camera or library) and an optional caption, then tap Post.
Meals: each meal has a Share link that opens the same sheet, showing the meal name, calories and macros.
Feed: the Friends tab now opens on Feed | Friends | Leaderboard. The feed shows your posts and your friends’ posts, newest first, 20 at a time with “Load more”. Each post shows the person (tap to open their profile), the photo, the stats and the caption. You can delete your own posts by tapping twice.
Who sees posts: only you and your friends. Photos sit in a private storage bucket and each one is shown through a link that expires after an hour.
Photo size and privacy: photos are shrunk to 1600px on the phone before uploading (a 3000px test image came out at 1600×1067). This also strips hidden details such as GPS location.
Deleting your account now removes your photos first. Files aren’t deleted automatically with the database rows.
supabase/posts.sql creates the posts table, the photo bucket and its access rules, and the feed function. Run it after the friends SQL, which you’ve already done. Until it’s run, the Share buttons stay hidden and the Feed says posts aren’t switched on yet. So it’s safe to push before running it.

Privacy policy
The in-app policy still said your data was “only readable by your own login”, which stopped being true when friends shipped. I’ve updated it to cover usernames, friends, the Privacy settings and photo posts, and changed the date to 21 October 2026. One thing to know: Workouts and Plans default to “Friends”, so anyone who accepts a friend shares those until they change the setting.

Tested in the preview
Sets: set rows and plan buttons show no numbers.
Sharing: picking a photo, posting a workout and posting a meal all worked, and new posts appeared at the top of the feed with their photos.
Fix: the Delete button on your own posts was being cut off at the card’s edge, because the top bar’s styles were also hitting the post header. That’s fixed.
Not tested: real uploads to Supabase storage, which needs the SQL run first.
Set numbers are gone, and the live bug that dropped "kg" from logged sets is fixed. Photo posts and a Feed tab are built and tested in the preview, waiting on supabase/posts.sql. Nothing is committed yet.

Commit and push now to fix the live bug?



--
-- PostgreSQL database dump
--

\restrict Feawht197lSq6MJNVmYjAgvJd4tk3UQUw80sksd0SerPR6AvFPxQK2KbIXX3Oa1

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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
