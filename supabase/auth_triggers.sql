-- Triggers on Supabase's built-in auth.users table.
-- pg_dump --schema=public (used for schema.sql) leaves these out, so they live here.
-- Run after schema.sql: SQL Editor > New query > paste > Run. Safe to run again.

-- Claims the username chosen at sign-up (function public.claim_username_on_signup is in schema.sql).
-- If the name is already taken, the sign-up fails and the app asks for another one.
drop trigger if exists on_auth_user_created_username on auth.users;
create trigger on_auth_user_created_username
  after insert on auth.users
  for each row execute function public.claim_username_on_signup();
