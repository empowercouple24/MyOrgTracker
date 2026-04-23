-- ════════════════════════════════════════════════════════════════════════
-- enrollment_requests.sql
-- ════════════════════════════════════════════════════════════════════════
-- Public-facing "request to enroll" inbox.
--
-- Anyone (anonymous, no JWT) can INSERT — that's the public /join form.
-- Only admins (profiles.role = 'admin') can SELECT, UPDATE, or DELETE.
--
-- Statuses:
--   'pending'   — newly submitted, awaiting admin review
--   'invited'   — admin clicked "Convert to invite" and a magic link was sent
--   'declined'  — admin dismissed the request
--   'archived'  — soft-deleted from the queue
--
-- Run once in the Supabase SQL editor. Re-runnable: drops named policies
-- before recreating, but does NOT drop the table.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.enrollment_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  email           text NOT NULL,
  sponsor_name    text,
  heard_from      text NOT NULL,
  pin_status      text NOT NULL,
  message         text,
  status          text NOT NULL DEFAULT 'pending',
  admin_notes     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT enrollment_requests_status_check
    CHECK (status IN ('pending','invited','declined','archived'))
);

-- Index for the admin queue (newest first, filtered by status)
CREATE INDEX IF NOT EXISTS enrollment_requests_status_created_idx
  ON public.enrollment_requests (status, created_at DESC);

-- Enable RLS
ALTER TABLE public.enrollment_requests ENABLE ROW LEVEL SECURITY;

-- Grant table-level access. RLS still gates what each role can do via policies
-- below, but PostgREST needs these table-level grants before it'll even attempt
-- the operation (otherwise: 401 Unauthorized before the policy is checked).
GRANT INSERT ON public.enrollment_requests TO anon, authenticated;
GRANT SELECT, UPDATE, DELETE ON public.enrollment_requests TO authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Drop prior policies (safe re-run)
DROP POLICY IF EXISTS "Anyone can submit enrollment request" ON public.enrollment_requests;
DROP POLICY IF EXISTS "Admins read all enrollment requests" ON public.enrollment_requests;
DROP POLICY IF EXISTS "Admins update enrollment requests"   ON public.enrollment_requests;
DROP POLICY IF EXISTS "Admins delete enrollment requests"   ON public.enrollment_requests;

-- 1. Public INSERT — anon visitors AND authenticated users can submit
CREATE POLICY "Anyone can submit enrollment request" ON public.enrollment_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    -- Force status to 'pending' on submission so users can't pre-mark themselves invited
    status = 'pending'
    -- Basic length sanity (defense in depth — the client also validates)
    AND length(first_name) BETWEEN 1 AND 80
    AND length(last_name)  BETWEEN 1 AND 80
    AND length(email)      BETWEEN 5 AND 200
    AND email LIKE '%@%'
  );

-- 2. Admin SELECT — full read of the queue
CREATE POLICY "Admins read all enrollment requests" ON public.enrollment_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
  );

-- 3. Admin UPDATE — change status, add admin_notes, set reviewed_*
CREATE POLICY "Admins update enrollment requests" ON public.enrollment_requests
  FOR UPDATE TO authenticated
  USING (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
  )
  WITH CHECK (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
  );

-- 4. Admin DELETE — hard-delete from the queue (rare; usually use status='archived' instead)
CREATE POLICY "Admins delete enrollment requests" ON public.enrollment_requests
  FOR DELETE TO authenticated
  USING (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
  );

-- ════════════════════════════════════════════════════════════════════════
-- Verification (optional)
-- ════════════════════════════════════════════════════════════════════════
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'enrollment_requests'
-- ORDER BY policyname;
