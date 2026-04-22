// ════════════════════════════════════════════════════════════════════════════
//  delete-user — Supabase Edge Function
// ════════════════════════════════════════════════════════════════════════════
//  Hard-deletes a row from auth.users. Requires the caller's JWT to belong to
//  a profile with role='admin'. Uses the service role key (auto-injected as
//  the SUPABASE_SERVICE_ROLE_KEY env var) so the secret never leaves the edge.
//
//  POST /functions/v1/delete-user
//    Headers: Authorization: Bearer <user JWT>
//    Body:    { "auth_user_id": "<uuid>" }
//
//  Returns:
//    200 { success: true }
//    400 { error: "<msg>" }   — bad input
//    401 { error: "<msg>" }   — missing/invalid JWT
//    403 { error: "<msg>" }   — caller is not an admin
//    500 { error: "<msg>" }   — unexpected failure
// ════════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  try {
    // ── Parse input ──
    let body: { auth_user_id?: string }
    try {
      body = await req.json()
    } catch {
      return json(400, { error: 'Invalid JSON body' })
    }
    const targetId = body?.auth_user_id
    if (!targetId || typeof targetId !== 'string') {
      return json(400, { error: 'auth_user_id (string) required' })
    }

    // ── Authorize the caller ──
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json(401, { error: 'Missing Authorization header' })
    }

    const SB_URL = Deno.env.get('SUPABASE_URL')!
    const SB_ANON = Deno.env.get('SUPABASE_ANON_KEY')!
    const SB_SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    if (!SB_URL || !SB_ANON || !SB_SVC) {
      return json(500, { error: 'Server misconfigured: missing env vars' })
    }

    // Use the caller's JWT to look up who they are
    const userClient = createClient(SB_URL, SB_ANON, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) {
      return json(401, { error: 'Invalid or expired session' })
    }
    const callerId = userData.user.id

    // Verify the caller has role='admin' in profiles
    const { data: profile, error: profileErr } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', callerId)
      .single()
    if (profileErr || !profile) {
      return json(403, { error: 'Profile lookup failed' })
    }
    if (profile.role !== 'admin') {
      return json(403, { error: 'Admin role required' })
    }

    // Defense-in-depth: refuse to let an admin delete their own auth row via this path.
    // (Use the dedicated revoke/self-demote flow instead.)
    if (callerId === targetId) {
      return json(400, { error: 'Cannot delete your own account through this endpoint' })
    }

    // ── Perform the privileged delete ──
    const adminClient = createClient(SB_URL, SB_SVC)
    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(targetId)
    if (deleteErr) {
      return json(500, { error: 'auth.admin.deleteUser failed: ' + deleteErr.message })
    }

    return json(200, { success: true, deleted: targetId })
  } catch (e) {
    return json(500, { error: (e as Error).message || 'Internal error' })
  }
})
