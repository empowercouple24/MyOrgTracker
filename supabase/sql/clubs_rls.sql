-- ════════════════════════════════════════════════════════════════════════
-- clubs_rls.sql
-- ════════════════════════════════════════════════════════════════════════
-- Row-Level Security policies for the public.clubs table.
--
-- Model:
--   • A "distributor" is a user whose profiles row has slug = '<their slug>'.
--   • Each distributor sees & manages ONLY clubs whose distributor_slug
--     matches their profile slug.
--   • An "admin" (profiles.role = 'admin') can SELECT all clubs across all
--     distributors. Admins do NOT have insert/update/delete here — that is
--     intentional and matches the read-only Clubs tab on the admin UI.
--
-- Run once in the Supabase SQL editor. Safe to re-run: drops named policies
-- before recreating. Existing policies with different names are left in
-- place (PostgreSQL RLS combines policies with OR for SELECT and OR for
-- INSERT WITH CHECK, so leaving extras is non-breaking).
-- ════════════════════════════════════════════════════════════════════════

-- 1. Make sure RLS is on (it already is — that's why you saw the 42501 error)
ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;

-- 2. Drop any prior versions of these specific policies so re-running is safe
DROP POLICY IF EXISTS "Distributors read own clubs"   ON public.clubs;
DROP POLICY IF EXISTS "Distributors insert own clubs" ON public.clubs;
DROP POLICY IF EXISTS "Distributors update own clubs" ON public.clubs;
DROP POLICY IF EXISTS "Distributors delete own clubs" ON public.clubs;
DROP POLICY IF EXISTS "Admins read all clubs"         ON public.clubs;

-- 3. Distributor: SELECT only their own clubs
CREATE POLICY "Distributors read own clubs" ON public.clubs
  FOR SELECT TO authenticated
  USING (
    distributor_slug = (SELECT slug FROM public.profiles WHERE id = auth.uid())
  );

-- 4. Distributor: INSERT clubs only with their own slug
CREATE POLICY "Distributors insert own clubs" ON public.clubs
  FOR INSERT TO authenticated
  WITH CHECK (
    distributor_slug = (SELECT slug FROM public.profiles WHERE id = auth.uid())
  );

-- 5. Distributor: UPDATE only their own clubs (and can't move them to someone else)
CREATE POLICY "Distributors update own clubs" ON public.clubs
  FOR UPDATE TO authenticated
  USING (
    distributor_slug = (SELECT slug FROM public.profiles WHERE id = auth.uid())
  )
  WITH CHECK (
    distributor_slug = (SELECT slug FROM public.profiles WHERE id = auth.uid())
  );

-- 6. Distributor: DELETE only their own clubs
CREATE POLICY "Distributors delete own clubs" ON public.clubs
  FOR DELETE TO authenticated
  USING (
    distributor_slug = (SELECT slug FROM public.profiles WHERE id = auth.uid())
  );

-- 7. Admin: SELECT all clubs (for the read-only admin distributor-detail Clubs tab)
CREATE POLICY "Admins read all clubs" ON public.clubs
  FOR SELECT TO authenticated
  USING (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'admin'
  );

-- ════════════════════════════════════════════════════════════════════════
-- Verification (optional — run after the above to confirm)
-- ════════════════════════════════════════════════════════════════════════
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'clubs'
-- ORDER BY policyname;
