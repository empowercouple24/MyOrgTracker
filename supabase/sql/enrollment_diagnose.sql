-- ════════════════════════════════════════════════════════════════════════
-- enrollment_diagnose.sql — read-only diagnostic
-- ════════════════════════════════════════════════════════════════════════
-- Run this in the Supabase SQL editor to dump the current state of the
-- enrollment_requests table — policies, grants, and a test insert.
-- Paste the results back so we can see exactly what's installed.
-- ════════════════════════════════════════════════════════════════════════

-- 1. What policies exist on this table?
SELECT '=== POLICIES ===' AS section;
SELECT
  policyname,
  cmd,
  roles,
  permissive,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'enrollment_requests'
ORDER BY policyname;

-- 2. What table-level grants exist?
SELECT '=== TABLE GRANTS ===' AS section;
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public' AND table_name = 'enrollment_requests'
ORDER BY grantee, privilege_type;

-- 3. Is RLS actually enabled?
SELECT '=== RLS STATUS ===' AS section;
SELECT schemaname, tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'enrollment_requests';

-- 4. What columns / NOT NULL constraints exist?
SELECT '=== COLUMNS ===' AS section;
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'enrollment_requests'
ORDER BY ordinal_position;
