# Lifts database (Supabase)

Run SQL in the Supabase dashboard: **SQL Editor → New query → paste → Run**. Every file is safe to run again.

## Setting up from scratch
1. `schema.sql` — every table, privacy rule and function (an export of the live database).
2. `auth_triggers.sql` — the sign-up trigger that claims a username.
3. `posts.sql` and `avatars.sql` — the private photo buckets and their access rules (storage is not part of the export).

## The files in the order they were added
| File | Adds |
|---|---|
| `friends.sql` | friends, per-section privacy, verified ticks |
| `leaderboard.sql` | the friends leaderboard |
| `posts.sql` | posts and the post photo bucket |
| `avatars.sql` | profile photos |
| `reactions.sql` | reactions and per-person post lists |
| `profile.sql` | profile header counts |
| `safety.sql` | blocking and reporting |
| `community.sql` | comments, who reacted, activity, leaderboard by exercise |

Some files replace functions from earlier ones. **If you re-run an older file, re-run every file after it in this list**, or newer behaviour (blocking, photos, comments) is lost.

## Checking the privacy rules
Run `tests/privacy_tests.sql`. It creates pretend users in a transaction, checks 40 privacy rules, then rolls everything back. It ends with "All privacy tests passed" or stops at the first rule that failed.

## Moderation
Reports appear in **Table Editor → reports** (only visible in the dashboard). To remove a post, delete its row in `posts`, then its photo in **Storage → posts**. Mark the report `actioned` or `reviewed`.

To give someone a verified tick:
```sql
insert into public.verified (user_id) select user_id from public.usernames where username = 'their_username';
```

## Keeping `schema.sql` up to date
After changing the database, re-export it (structure only, no data):
```
"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" "postgresql://postgres.opmkdaqsvjsvonrxjlpp@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" --schema-only --schema=public --no-owner -f supabase/schema.sql
```
Then delete the `\restrict ...` line near the top and the `\unrestrict ...` line at the bottom. pg_dump adds them for its own command-line tool, and the SQL Editor cannot run them.

`schema.sql` is a record of the database, not a change to it: only run it when setting up a brand-new Supabase project.
