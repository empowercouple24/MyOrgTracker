-- ────────────────────────────────────────────────────────────────────────────
--  reminders.sql — Daily 11am "missing entry" reminder system
-- ────────────────────────────────────────────────────────────────────────────
--  Adds two columns to distributors (timezone + reminder_opt_out) and schedules
--  an hourly pg_cron job that invokes the `send-reminders` Edge Function.
--
--  The Edge Function itself decides who to email on any given run — the cron
--  just fires the function hourly, because "11am local" for distributors
--  spread across timezones means the sweep has to run every hour.
--
--  Run in Supabase SQL editor. Safe to re-run (IF NOT EXISTS on columns,
--  cron.unschedule guards on the job name).
-- ────────────────────────────────────────────────────────────────────────────


-- ── 1. Schema ────────────────────────────────────────────────────────────────

ALTER TABLE distributors
  ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS reminder_opt_out boolean NOT NULL DEFAULT false;

-- Backfill any nulls on existing rows to the default timezone
UPDATE distributors SET timezone = 'America/New_York' WHERE timezone IS NULL;


-- ── 2. Extensions ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;


-- ── 3. Cron secret storage via Vault ─────────────────────────────────────────
-- The Edge Function validates a shared secret passed in the x-reminder-secret
-- header so only pg_cron (and anyone with the secret) can trigger sends.
--
-- BEFORE running this block:
--   1. In the Supabase dashboard → Edge Functions → Secrets, set
--      REMINDER_CRON_SECRET to a random string (e.g. `openssl rand -hex 32`)
--   2. Replace the placeholder below with the same string.
--
-- The secret is stored in pgsodium's Vault so it isn't exposed to roles that
-- can see the cron.job table.

-- SELECT vault.create_secret('PASTE_THE_SAME_SECRET_HERE', 'reminder_cron_secret');
-- Re-run with vault.update_secret_by_name if rotating.


-- ── 4. Deploy the Edge Function (reminder needed, not executed here) ─────────
--   supabase functions deploy send-reminders --project-ref nclvgzirfzddrbsnzryo --no-verify-jwt
--
-- --no-verify-jwt is required because pg_cron calls the function without a
-- user JWT. The function guards itself via the shared secret above.


-- ── 5. Schedule the hourly sweep ─────────────────────────────────────────────
-- Unschedule any existing version first so this file is safe to re-run.

SELECT cron.unschedule('myorgtracker-daily-reminder-sweep')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'myorgtracker-daily-reminder-sweep');

SELECT cron.schedule(
  'myorgtracker-daily-reminder-sweep',
  '0 * * * *',  -- top of every hour (UTC). Edge Function filters by local time.
  $$
  SELECT net.http_post(
    url     := 'https://nclvgzirfzddrbsnzryo.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-reminder-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'reminder_cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);


-- ── 6. Sanity check ──────────────────────────────────────────────────────────
-- Confirm the job is scheduled:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'myorgtracker%';
--
-- View recent runs:
--   SELECT runid, start_time, status, return_message
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'myorgtracker-daily-reminder-sweep')
--    ORDER BY start_time DESC LIMIT 10;
