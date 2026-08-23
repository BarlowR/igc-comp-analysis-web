// feedback-alert — one email per row inserted into public.feedback.
//
// Called by a Supabase Database Webhook (Dashboard → Database → Webhooks):
//   table public.feedback, event INSERT, type "Supabase Edge Functions",
//   function feedback-alert, HTTP header  x-webhook-secret: <FEEDBACK_WEBHOOK_SECRET>
//
// Deploy:  supabase functions deploy feedback-alert --no-verify-jwt
//   (--no-verify-jwt because the webhook carries no user JWT; the shared
//   secret header is the auth instead.)
// Secrets: supabase secrets set RESEND_API_KEY=… FEEDBACK_WEBHOOK_SECRET=… \
//            FEEDBACK_ALERT_TO=you@example.com [FEEDBACK_ALERT_FROM=…]
//
// Resend's sandbox sender (onboarding@resend.dev, the default FROM) can only
// mail the address that owns the Resend account — fine for a single-owner
// alert. Verify a domain to use any FROM.
//
// See docs/decisions/0004-feedback-alerts.md.

interface FeedbackRow {
  id: string;
  created_at: string;
  kind: 'bug' | 'idea' | 'task';
  body: string;
  page: string | null;
  contact: string | null;
  user_id: string | null;
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: FeedbackRow | null;
}

const env = (key: string): string => {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`missing secret ${key}`);
  return v;
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (req.headers.get('x-webhook-secret') !== env('FEEDBACK_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }

  const payload = (await req.json()) as WebhookPayload;
  if (payload.type !== 'INSERT' || payload.table !== 'feedback' || !payload.record) {
    return new Response('ignored', { status: 200 });
  }
  const r = payload.record;

  const label = { bug: '🐛 Bug report', idea: '💡 Idea', task: '🗂 Task request' }[r.kind] ?? r.kind;
  const subject = `[Outclimb] ${label}${r.page ? ` — ${r.page}` : ''}`;
  const who = r.user_id ? `account ${r.user_id}` : 'anonymous';
  const contact = r.contact ? esc(r.contact) : '—';
  const html = `
    <p><strong>${label}</strong> · ${esc(r.created_at)} · ${esc(who)}</p>
    <p><strong>Where:</strong> ${r.page ? esc(r.page) : '—'}<br>
       <strong>Contact:</strong> ${contact}</p>
    <pre style="white-space:pre-wrap;font-family:inherit">${esc(r.body)}</pre>
    <p style="color:#777">Resolve: <code>update public.feedback set resolved_at = now() where id = '${r.id}';</code></p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: Deno.env.get('FEEDBACK_ALERT_FROM') ?? 'Outclimb feedback <onboarding@resend.dev>',
      to: env('FEEDBACK_ALERT_TO').split(',').map((s) => s.trim()),
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('resend failed', res.status, text);
    return new Response(`resend failed: ${res.status}`, { status: 502 });
  }
  return new Response('sent', { status: 200 });
});
