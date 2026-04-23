// ────────────────────────────────────────────────────────────────────────────
//  submit-enrollment — Edge Function
// ────────────────────────────────────────────────────────────────────────────
//  WORKAROUND for a Supabase platform-level issue: anon role inserts on
//  public.enrollment_requests are rejected with `42501 row violates row-level
//  security policy` even with `WITH CHECK (true)` policy + INSERT grants +
//  row_security = on. Verified extensively; awaiting Supabase support.
//
//  This function is the temporary public submission endpoint:
//   1. Validates the submission server-side (same rules the RLS policy used)
//   2. Inserts via the service role key (bypasses the broken RLS)
//   3. Fires the existing notify-enrollment function for admin email
//
//  TO REVERT WHEN SUPABASE FIXES THE PLATFORM ISSUE:
//   - In join.html: change fetch URL from `/functions/v1/submit-enrollment`
//     back to `/rest/v1/enrollment_requests` and re-enable Prefer: return=
//     representation. Re-add the fire-and-forget notify-enrollment call.
//   - This file can be left in place (harmless) or deleted via the Supabase
//     dashboard.
//
//  Required env (auto-injected by Supabase runtime):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//  Required env (already configured for other functions):
//    (none used directly here — notify-enrollment handles email)
//
//  Deploy:
//    supabase functions deploy submit-enrollment --project-ref nclvgzirfzddrbsnzryo --no-verify-jwt
//
//  CRITICAL: --no-verify-jwt because anonymous visitors call this. The function
//  is safe to expose because it only writes a 'pending' enrollment row with
//  validated content — it has no other side effects.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

// Mirror the same validation the RLS WITH CHECK was doing, plus a couple of
// extras now that we control submission server-side.
const VALID_HEARD_FROM = new Set([
  'Facebook', 'Instagram', 'TikTok', 'Friend or Referral',
  'Event', 'Search engine', 'Other',
])
const VALID_PIN_STATUS = new Set([
  'not_yet', 'just_signed', 'awt', 'get', 'getp',
  'mt', 'mtp', 'pt', 'pt15k', 'pt20k', 'pt30k',
])

function validate(body: any): { ok: true; data: any } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request body' }

  const first   = (body.first_name   ?? '').toString().trim()
  const last    = (body.last_name    ?? '').toString().trim()
  const email   = (body.email        ?? '').toString().trim().toLowerCase()
  const sponsor = body.sponsor_name ? body.sponsor_name.toString().trim() : null
  const heard   = (body.heard_from   ?? '').toString().trim()
  const pin     = (body.pin_status   ?? '').toString().trim()
  const message = body.message ? body.message.toString().trim() : null

  if (first.length < 1 || first.length > 80)   return { ok: false, error: 'First name is required (max 80 chars)' }
  if (last.length  < 1 || last.length  > 80)   return { ok: false, error: 'Last name is required (max 80 chars)' }
  if (email.length < 5 || email.length > 200)  return { ok: false, error: 'Valid email is required' }
  if (!email.includes('@') || !email.includes('.')) return { ok: false, error: 'Valid email is required' }
  if (!VALID_HEARD_FROM.has(heard))            return { ok: false, error: 'Please select a valid "where did you hear about us" option' }
  if (!VALID_PIN_STATUS.has(pin))              return { ok: false, error: 'Please select a valid distributor status' }
  if (sponsor && sponsor.length > 120)         return { ok: false, error: 'Sponsor name too long (max 120 chars)' }
  if (message && message.length > 1000)        return { ok: false, error: 'Message too long (max 1000 chars)' }

  return {
    ok: true,
    data: {
      first_name:   first,
      last_name:    last,
      email,
      sponsor_name: sponsor || null,
      heard_from:   heard,
      pin_status:   pin,
      message:      message || null,
      status:       'pending',  // always force 'pending' — matches the RLS check
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405)

  try {
    const body = await req.json().catch(() => null)
    const v = validate(body)
    if (!v.ok) return json({ error: v.error }, 400)

    const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Server misconfigured — missing env vars' }, 500)
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Insert with service role — bypasses RLS. v.data has only validated fields.
    const { data: inserted, error: insErr } = await sb
      .from('enrollment_requests')
      .insert(v.data)
      .select('id, created_at')
      .single()

    if (insErr) {
      console.error('Insert failed:', insErr)
      return json({ error: 'Could not save your request. Please try again.' }, 500)
    }

    // Fire-and-forget admin notification. We don't block the response on this —
    // if notify fails, the row is still saved and the admin will see it on
    // their next admin-page visit.
    try {
      const notifyUrl = SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/notify-enrollment'
      // No await — we want this to NOT block. Catch errors so they don't unhandled-reject.
      fetch(notifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ request_id: inserted.id }),
      }).catch(e => console.warn('notify-enrollment dispatch failed:', e))
    } catch (e) {
      console.warn('notify-enrollment setup failed:', e)
    }

    return json({ success: true, id: inserted.id, created_at: inserted.created_at })
  } catch (e) {
    console.error('submit-enrollment unexpected error:', e)
    return json({ error: 'Unexpected server error' }, 500)
  }
})
