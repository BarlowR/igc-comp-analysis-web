# 0004 — Feedback email alerts

- **Status:** Accepted
- **Date:** 2026-08-23

## What

Each new row in `public.feedback` (migration 0012) sends one email to the site owner. The daily `Feedback gate` Action stays the triage list. The email tells the owner immediately.

## How it works

1. A Supabase Database Webhook watches `INSERT` on `public.feedback`.
2. The webhook calls the Edge Function `supabase/functions/feedback-alert`.
3. The function sends the email through the Resend API.

The function accepts a request only when the `x-webhook-secret` header matches the `FEEDBACK_WEBHOOK_SECRET` secret. The webhook sends no user JWT, so we deploy the function with `--no-verify-jwt`.

## Configuration

Do these steps one time for each project.

1. Make a Resend account. Copy an API key.
2. Set the function secrets:

   ```sh
   supabase secrets set RESEND_API_KEY=re_… \
     FEEDBACK_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
     FEEDBACK_ALERT_TO=you@example.com
   ```

   `FEEDBACK_ALERT_FROM` is optional. The default sender is `onboarding@resend.dev`. Resend lets that sender mail only the address that owns the Resend account. To send from a different address, verify a domain in Resend.

3. Deploy the function:

   ```sh
   supabase functions deploy feedback-alert --no-verify-jwt
   ```

4. In the dashboard, open `Database → Webhooks → Create a new hook`:
   - Table: `feedback`. Events: `Insert`.
   - Type: `Supabase Edge Functions`. Function: `feedback-alert`.
   - HTTP header: `x-webhook-secret` with the same value that you set in step 2.

5. Send a test report from `/feedback`. The email must come in less than a minute. If it does not, read the function logs in `Edge Functions → feedback-alert → Logs`.

## Why not the Action

The Action runs one time each day and writes to a public job summary. An email is private and comes immediately. A bug report can then get a reply on the same day.

## Why Resend

Supabase does not send custom email. Resend has a no-cost tier, one HTTP request, and no SDK. The function has no dependencies.
