// ────────────────────────────────────────────────────────────────────────────
//  send-reminders — Edge Function
// ────────────────────────────────────────────────────────────────────────────
//  Invoked hourly by pg_cron (see supabase/sql/reminders.sql). For each
//  active, opted-in distributor:
//    1. Compute their current local hour in their IANA timezone
//    2. If local hour != 11, skip them this run
//    3. Check if they have an entry dated "yesterday local" in org_volume
//    4. If no entry → send branded reminder via Brevo
//
//  "Yesterday local" is used because in Herbalife land the number that appears
//  in Bizworks in the morning covers the prior day; logging yesterday's total
//  is the user's morning task. If it hasn't been logged by 11am local, we nudge.
//
//  Required env (auto-injected by Supabase):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//  Required env (set via Supabase Dashboard → Edge Functions → Secrets):
//    BREVO_API_KEY, FROM_EMAIL, FROM_NAME, REMINDER_CRON_SECRET
//  Optional env:
//    TRACKER_URL (defaults to https://myorgtracker.com)
//
//  Deploy:
//    supabase functions deploy send-reminders --project-ref nclvgzirfzddrbsnzryo --no-verify-jwt
//
//  Security: --no-verify-jwt is required because pg_cron can't present a user
//  JWT. The function guards itself by requiring x-reminder-secret to match
//  REMINDER_CRON_SECRET.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reminder-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const UPLIFT = 1.32

const PIN_LABELS: Record<string, string> = {
  pt30k: 'Presidents Team 30K',
  pt20k: 'Presidents Team 20K',
  pt15k: 'Presidents Team 15K',
  pt:    'Presidents Team',
  mtp:   'Millionaire Team Plus',
  mt:    'Millionaire Team',
  getp:  'GET Plus 2500',
  get:   'GET Team',
  awt:   'Active World Team',
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']


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


// ── Timezone helpers ─────────────────────────────────────────────────────────
// Uses Intl so DST is handled automatically from the IANA database.

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number }

function getLocalParts(utcDate: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:   'numeric',
    month:  '2-digit',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const out: Record<string, string> = {}
  for (const p of f.formatToParts(utcDate)) if (p.type !== 'literal') out[p.type] = p.value
  // Intl can return '24' for midnight in hour12:false; normalize to 0.
  const hour = out.hour === '24' ? 0 : parseInt(out.hour, 10)
  return {
    year:   parseInt(out.year, 10),
    month:  parseInt(out.month, 10),
    day:    parseInt(out.day, 10),
    hour,
    minute: parseInt(out.minute, 10),
  }
}

function ymdString(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

// Given a local date (year/month/day), return the previous local date as
// a YYYY-MM-DD string. Pure calendar arithmetic — no tz conversion needed
// since we're working within the distributor's local frame.
function yesterdayYmd(parts: LocalParts): string {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  d.setUTCDate(d.getUTCDate() - 1)
  return ymdString(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

function daysLeftInMonth(parts: LocalParts): number {
  // Days after today through end of month. April 24 → 6 (25,26,27,28,29,30).
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()
  return Math.max(0, lastDay - parts.day)
}


// ── Formatting helpers for email copy ────────────────────────────────────────
function nf(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function daysAgoLabel(entryYmd: string, today: LocalParts): string {
  // entryYmd is 'YYYY-MM-DD'
  const [y, m, d] = entryYmd.split('-').map(n => parseInt(n, 10))
  const entryUtc = Date.UTC(y, m - 1, d)
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day)
  const diff = Math.round((todayUtc - entryUtc) / 86400000)
  if (diff === 0) return 'earlier today'
  if (diff === 1) return 'yesterday'
  if (diff < 7)   return `${diff} days ago`
  const dow = new Date(entryUtc).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  return `${dow} · ${diff} days ago`
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}


// ── HTML email body ──────────────────────────────────────────────────────────
interface ReminderContext {
  firstName: string
  eyebrowDate: string       // "DAILY CHECK-IN · APRIL 24"
  lastDV: string            // pre-formatted with commas
  lastLoggedSub: string     // "Tue · 2 days ago" or "Never logged"
  dvTarget: string          // pre-formatted
  goalLabel: string         // "Millionaire Team"
  daysLeft: number
  monthEndLabel: string     // "through Apr 30"
  neededPerDay: string      // pre-formatted
  trackerUrl: string
  settingsUrl: string
}

function buildReminderHtml(ctx: ReminderContext): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4ede1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4ede1">
    <tr><td align="center" style="padding:40px 16px">
      <table width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#fbf6ec;border-radius:18px;border:1px solid rgba(61,46,31,0.08)">
        <tr><td style="padding:28px 28px 24px">

          <p style="margin:0 0 6px;font-family:'DM Mono',ui-monospace,'SF Mono',Menlo,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#a89f8d">${escapeHtml(ctx.eyebrowDate)}</p>

          <h1 style="margin:0 0 8px;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:400;letter-spacing:-0.01em;color:#18181b;line-height:1.25">
            Good morning, <em style="font-style:italic">${escapeHtml(ctx.firstName)}</em>.
          </h1>

          <p style="margin:0 0 20px;font-size:15px;color:#3d3a34;line-height:1.55">
            No entry for yesterday yet. Here&rsquo;s where things stand.
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:8px">
            <tr>
              <td width="50%" style="background:#f4ede1;border-radius:10px;padding:12px 14px;vertical-align:top">
                <p style="margin:0;font-family:'DM Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#a89f8d">Last logged</p>
                <p style="margin:4px 0 0;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:400;color:#18181b">${escapeHtml(ctx.lastDV)}</p>
                <p style="margin:2px 0 0;font-size:11px;color:#7a7568">${escapeHtml(ctx.lastLoggedSub)}</p>
              </td>
              <td width="50%" style="background:#f4ede1;border-radius:10px;padding:12px 14px;vertical-align:top">
                <p style="margin:0;font-family:'DM Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#a89f8d">DV target</p>
                <p style="margin:4px 0 0;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:400;color:#18181b">${escapeHtml(ctx.dvTarget)}</p>
                <p style="margin:2px 0 0;font-size:11px;color:#7a7568">${escapeHtml(ctx.goalLabel)}</p>
              </td>
            </tr>
            <tr>
              <td width="50%" style="background:#f4ede1;border-radius:10px;padding:12px 14px;vertical-align:top">
                <p style="margin:0;font-family:'DM Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#a89f8d">Days left</p>
                <p style="margin:4px 0 0;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:400;color:#18181b">${ctx.daysLeft}</p>
                <p style="margin:2px 0 0;font-size:11px;color:#7a7568">${escapeHtml(ctx.monthEndLabel)}</p>
              </td>
              <td width="50%" style="background:#f4ede1;border-radius:10px;padding:12px 14px;vertical-align:top">
                <p style="margin:0;font-family:'DM Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#a89f8d">Needed / day</p>
                <p style="margin:4px 0 0;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:400;color:#18181b">${escapeHtml(ctx.neededPerDay)}</p>
                <p style="margin:2px 0 0;font-size:11px;color:#7a7568">DV to close the gap</p>
              </td>
            </tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" style="margin-top:22px">
            <tr><td>
              <a href="${ctx.trackerUrl}" style="display:inline-block;background:#18181b;color:#fafaf8;text-decoration:none;border-radius:10px;padding:11px 22px;font-size:14px;font-weight:500">Log today&rsquo;s number &rarr;</a>
            </td></tr>
          </table>

          <p style="margin:20px 0 0;font-size:11px;color:#a89f8d;line-height:1.55">
            Sent because no entry was logged by 11:00 AM your local time. <a href="${ctx.settingsUrl}" style="color:#7a7568;text-decoration:underline">Turn these off in Settings</a>.
          </p>

        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}


// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405)

  // Shared-secret guard
  const expectedSecret = Deno.env.get('REMINDER_CRON_SECRET') ?? ''
  const providedSecret = req.headers.get('x-reminder-secret') ?? ''
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Server misconfigured — missing env vars' }, 500)
  }

  const TRACKER_URL = (Deno.env.get('TRACKER_URL') ?? 'https://myorgtracker.com').replace(/\/+$/, '')
  const SETTINGS_URL = `${TRACKER_URL}#settings`

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const now = new Date()

  // 1. Fetch all active, opted-in distributors
  const { data: dists, error: distErr } = await sb
    .from('distributors')
    .select('id, slug, name, first_name, last_name, email, timezone, reminder_opt_out, pin_goal, dv_goal, is_active')
    .eq('is_active', true)
    .eq('reminder_opt_out', false)
  if (distErr) return json({ error: 'Distributor query failed: ' + distErr.message }, 500)

  const results: Array<Record<string, unknown>> = []

  for (const d of dists ?? []) {
    const slug = d.slug as string
    const tz = (d.timezone as string) || 'America/New_York'
    const email = (d.email as string) || ''
    if (!email) { results.push({ slug, skipped: 'no email' }); continue }

    // 2. Check local hour — only fire at 11am local
    let local: LocalParts
    try {
      local = getLocalParts(now, tz)
    } catch (e) {
      results.push({ slug, skipped: 'bad timezone: ' + tz })
      continue
    }
    if (local.hour !== 11) {
      results.push({ slug, skipped: `local hour ${local.hour}` })
      continue
    }

    // 3. Has an entry been logged for YESTERDAY (local)?
    const yesterday = yesterdayYmd(local)
    const { data: existing, error: existErr } = await sb
      .from('org_volume')
      .select('id')
      .eq('user_slug', slug)
      .eq('entry_date', yesterday)
      .limit(1)
    if (existErr) { results.push({ slug, error: 'entry lookup: ' + existErr.message }); continue }
    if (existing && existing.length) {
      results.push({ slug, skipped: 'already logged ' + yesterday })
      continue
    }

    // 4. Pull most recent entry for context metrics
    const { data: latestRows } = await sb
      .from('org_volume')
      .select('entry_date, org_volume')
      .eq('user_slug', slug)
      .order('entry_date', { ascending: false })
      .limit(1)
    const latest = latestRows?.[0]

    // NOTE on column naming: the `org_volume` DB column actually stores the
    // DV value (the number the distributor types from Bizworks), and
    // `est_org_dv` stores DV × 1.32 (the Est Org Volume). This is inverted
    // from what the column names suggest — legacy from an older terminology
    // convention. Current terminology: DV = Bizworks input, Org Volume = tier
    // threshold, DV Target = Org Volume ÷ 1.32.
    const orgVolumeThreshold = Number(d.dv_goal) || 0
    const dvTargetNum = orgVolumeThreshold > 0 ? Math.round(orgVolumeThreshold / UPLIFT) : 0
    const lastDVNum = latest ? Math.round(Number(latest.org_volume)) : 0
    const lastLoggedSub = latest ? daysAgoLabel(String(latest.entry_date), local) : 'Never logged'

    const dl = daysLeftInMonth(local)
    const gap = Math.max(0, dvTargetNum - lastDVNum)
    const neededPerDayNum = dl > 0 ? Math.round(gap / dl) : gap

    const firstName = (d.first_name as string) || (d.name as string || '').split(/\s+/)[0] || 'there'
    const pinGoal = (d.pin_goal as string) || ''
    const goalLabel = PIN_LABELS[pinGoal] || pinGoal || 'Your goal'

    const monthEndDay = new Date(Date.UTC(local.year, local.month, 0)).getUTCDate()
    const monthEndLabel = `through ${MONTH_ABBR[local.month - 1]} ${monthEndDay}`
    const eyebrowDate = `DAILY CHECK-IN · ${MONTH_NAMES[local.month - 1].toUpperCase()} ${local.day}`

    const html = buildReminderHtml({
      firstName,
      eyebrowDate,
      lastDV: nf(lastDVNum),
      lastLoggedSub,
      dvTarget: nf(dvTargetNum),
      goalLabel,
      daysLeft: dl,
      monthEndLabel,
      neededPerDay: nf(neededPerDayNum),
      trackerUrl: TRACKER_URL,
      settingsUrl: SETTINGS_URL,
    })

    const subject = `Today's number is still missing`

    try {
      await sendViaBrevo(email, subject, html)
      results.push({ slug, sent: true, to: email })
    } catch (e) {
      results.push({ slug, error: `send failed: ${(e as Error).message}` })
    }
  }

  return json({
    ok: true,
    ts: now.toISOString(),
    considered: (dists ?? []).length,
    sent: results.filter(r => r.sent).length,
    skipped: results.filter(r => r.skipped).length,
    errors: results.filter(r => r.error).length,
    results,
  })
})
