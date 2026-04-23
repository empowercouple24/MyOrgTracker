// ────────────────────────────────────────────────────────────────────────────
//  notify-enrollment — Edge Function
// ────────────────────────────────────────────────────────────────────────────
//  Sends a "new enrollment request" email to all admins via Brevo when a
//  visitor submits the public /join form.
//
//  Called from the client AFTER the row insert succeeds. The function
//  re-reads the row from the DB (using the service key) so the notification
//  reflects what's actually persisted, not whatever the client claims.
//
//  Required env (auto-injected by Supabase):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//  Required env (you set in Supabase → Edge Functions → Secrets):
//    BREVO_API_KEY, FROM_EMAIL, FROM_NAME
//
//  Deploy:
//    supabase functions deploy notify-enrollment --project-ref nclvgzirfzddrbsnzryo
//
//  The function is INTENTIONALLY public (no JWT required) — it's safe because:
//    1. It validates that the request_id corresponds to a real, recently-
//       created row in enrollment_requests
//    2. It only emails admins (read from profiles.role = 'admin')
//    3. It only sends a notification, not the form data the client provides
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

// ── Brevo send helper ────────────────────────────────────────────────────────
async function sendViaBrevo(to: string, subject: string, html: string): Promise<void> {
  const apiKey = Deno.env.get('BREVO_API_KEY') ?? ''
  const fromEmail = Deno.env.get('FROM_EMAIL') ?? ''
  const fromName  = Deno.env.get('FROM_NAME')  ?? 'myOrgTracker'
  if (!apiKey)    throw new Error('BREVO_API_KEY is not set')
  if (!fromEmail) throw new Error('FROM_EMAIL is not set')

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender:      { name: fromName, email: fromEmail },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Brevo ${res.status}: ${txt.slice(0, 200)}`)
  }
}

// ── HTML notification body ───────────────────────────────────────────────────
function buildHtml(req: any, adminUrl: string): string {
  const PIN_LABELS: Record<string, string> = {
    not_yet:     "Not yet a Herbalife distributor",
    just_signed: "Just signed up — no pin yet",
    awt:         "Active World Team (AWT)",
    get:         "GET Team",
    getp:        "GET Plus 2500",
    mt:          "Millionaire Team",
    mtp:         "Millionaire Team Plus 7500",
    pt:          "Presidents Team",
    pt15k:       "Presidents Team 15K",
    pt20k:       "Presidents Team 20K",
    pt30k:       "Presidents Team 30K",
  }
  const pin = PIN_LABELS[req.pin_status] ?? req.pin_status
  const sponsor = req.sponsor_name ? req.sponsor_name : '<em style="color:#a89f8d">none provided</em>'
  const message = req.message
    ? `<div style="background:#f4ede1;border-radius:8px;padding:12px 14px;margin-top:6px;font-size:14px;color:#3d3a34;line-height:1.55;white-space:pre-wrap">${escapeHtml(req.message)}</div>`
    : '<em style="color:#a89f8d">none provided</em>'
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4ede1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4ede1">
    <tr><td align="center" style="padding:40px 16px">
      <table width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fbf6ec;border-radius:18px;border:1px solid rgba(61,46,31,0.08)">
        <tr><td style="padding:28px 28px 24px">
          <p style="margin:0 0 6px;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#a89f8d">New enrollment request</p>
          <h1 style="margin:0 0 18px;font-family:'EB Garamond',Georgia,serif;font-size:24px;font-weight:400;letter-spacing:-0.01em;color:#18181b">
            <em style="font-style:italic">${escapeHtml(req.first_name)} ${escapeHtml(req.last_name)}</em> wants in.
          </h1>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;color:#3d3a34">
            <tr><td style="padding:7px 0;color:#7a7568;width:130px">Email</td><td style="padding:7px 0"><a href="mailto:${encodeURIComponent(req.email)}" style="color:#18181b">${escapeHtml(req.email)}</a></td></tr>
            <tr><td style="padding:7px 0;color:#7a7568">Sponsor</td><td style="padding:7px 0">${sponsor}</td></tr>
            <tr><td style="padding:7px 0;color:#7a7568">Heard from</td><td style="padding:7px 0">${escapeHtml(req.heard_from)}</td></tr>
            <tr><td style="padding:7px 0;color:#7a7568">Status</td><td style="padding:7px 0">${escapeHtml(pin)}</td></tr>
            <tr><td style="padding:7px 0;color:#7a7568;vertical-align:top">Message</td><td style="padding:7px 0">${message}</td></tr>
          </table>
          <table cellpadding="0" cellspacing="0" border="0" style="margin-top:22px">
            <tr><td>
              <a href="${adminUrl}" style="display:inline-block;background:#18181b;color:#fafaf8;text-decoration:none;border-radius:10px;padding:11px 22px;font-size:14px;font-weight:500">Open admin queue →</a>
            </td></tr>
          </table>
          <p style="margin:18px 0 0;font-size:11px;color:#a89f8d;line-height:1.55">
            Submitted ${new Date(req.created_at).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const requestId = body?.request_id
    if (!requestId || typeof requestId !== 'string') {
      return json({ error: 'request_id (uuid string) required' }, 400)
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Server misconfigured — missing env vars' }, 500)
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // 1. Re-read the row from the DB so we email what's actually persisted
    const { data: rows, error: rowErr } = await sb
      .from('enrollment_requests')
      .select('*')
      .eq('id', requestId)
      .limit(1)
    if (rowErr) return json({ error: 'Lookup failed: ' + rowErr.message }, 500)
    if (!rows || !rows.length) return json({ error: 'Enrollment request not found' }, 404)
    const enrollment = rows[0]

    // 2. Defense-in-depth: only notify for rows created in the last 5 minutes.
    //    Stops someone from triggering re-notifications by submitting a stale uuid.
    const ageMs = Date.now() - new Date(enrollment.created_at).getTime()
    if (ageMs > 5 * 60 * 1000) {
      return json({ skipped: 'request too old to notify' }, 200)
    }

    // 3. Find admin recipients
    const { data: admins, error: adminErr } = await sb
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
    if (adminErr) return json({ error: 'Admin lookup failed: ' + adminErr.message }, 500)

    // Get email addresses for those admin user ids via auth.users
    const adminEmails: string[] = []
    for (const a of admins || []) {
      const { data: userData } = await sb.auth.admin.getUserById(a.id)
      if (userData?.user?.email) adminEmails.push(userData.user.email)
    }
    if (!adminEmails.length) {
      return json({ skipped: 'no admins to notify' }, 200)
    }

    // 4. Build & send the notification
    // Construct admin URL from the SUPABASE_URL? No — use env or hardcode.
    // For now use a generic placeholder; the email body links to /admin which
    // resolves correctly on whatever domain the user has deployed to.
    const ADMIN_URL = Deno.env.get('ADMIN_URL') ?? 'https://myorgtracker.com/admin'
    const html = buildHtml(enrollment, ADMIN_URL)
    const subject = `[myOrgTracker] New enrollment request — ${enrollment.first_name} ${enrollment.last_name}`

    // Send to each admin (Brevo doesn't BCC well; one send per recipient is simplest)
    const sendResults = await Promise.allSettled(
      adminEmails.map(email => sendViaBrevo(email, subject, html))
    )
    const failed = sendResults.filter(r => r.status === 'rejected')
    if (failed.length === sendResults.length) {
      return json({ error: 'All admin notifications failed' }, 500)
    }

    return json({
      success: true,
      notified: adminEmails.length - failed.length,
      failed: failed.length,
    })
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500)
  }
})
