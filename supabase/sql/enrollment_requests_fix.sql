-- ════════════════════════════════════════════════════════════════════════
-- enrollment_requests_fix.sql — apply ONCE after the initial migration
-- ════════════════════════════════════════════════════════════════════════
-- The original policy used "TO public" which Postgres treats as "every role"
-- but PostgREST's anon role still needs an explicit table-level GRANT before
-- it'll even attempt the insert. Without the grant, requests come back as
-- 401 Unauthorized before the row-check policy is ever evaluated.
--
-- This patch:
--   1. Grants INSERT on the table to the anon role
--   2. Replaces the broad "TO public" policy with an explicit "TO anon, authenticated"
--      so the intent is unambiguous
--
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════

-- 1. Grant table-level INSERT to anon (and keep authenticated for completeness)
GRANT INSERT ON public.enrollment_requests TO anon, authenticated;

-- Allow anon/authenticated to use the schema (usually granted by default,
-- but harmless to ensure)
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- 2. Drop the original policy and recreate it with explicit roles
DROP POLICY IF EXISTS "Anyone can submit enrollment request" ON public.enrollment_requests;

CREATE POLICY "Anyone can submit enrollment request" ON public.enrollment_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    status = 'pending'
    AND length(first_name) BETWEEN 1 AND 80
    AND length(last_name)  BETWEEN 1 AND 80
    AND length(email)      BETWEEN 5 AND 200
    AND email LIKE '%@%'
  );

-- ════════════════════════════════════════════════════════════════════════
-- Verification
-- ════════════════════════════════════════════════════════════════════════
-- After running, the row count for anon's INSERT grant should be 1:
-- SELECT grantee, privilege_type
-- FROM information_schema.table_privileges
-- WHERE table_name = 'enrollment_requests' AND grantee = 'anon';
