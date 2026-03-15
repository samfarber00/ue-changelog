# UE Changelog — Setup Instructions

## Files in this folder
- `index.html` — the changelog site (public + admin)
- `api/linear-webhook.js` — serverless function that receives Linear events
- `vercel.json` — Vercel routing config
- `supabase-migration.sql` — run this in Supabase first

---

## Step 1 — Run the SQL migration

Go to Supabase → SQL Editor → paste and run `supabase-migration.sql`.
This adds `status`, `linear_id`, and `linear_url` columns to your changelog table.

---

## Step 2 — Deploy to Vercel

1. Put all files in a folder (keep the `api/` subfolder intact)
2. Go to vercel.com → New Project → drag the whole folder in
3. Deploy — you'll get a URL like `https://ue-changelog.vercel.app`

---

## Step 3 — Add environment variables in Vercel

Go to your Vercel project → Settings → Environment Variables.
Add these 4 variables:

| Name                    | Value                                      |
|-------------------------|--------------------------------------------|
| SUPABASE_URL            | https://kuquzlspmzkduftnwbwf.supabase.co   |
| SUPABASE_SERVICE_KEY    | (your Supabase service_role secret key)    |
| ANTHROPIC_API_KEY       | (your Anthropic API key from console.anthropic.com) |
| LINEAR_WEBHOOK_SECRET   | (any random string, e.g. "ue-linear-2025") |

⚠️ SUPABASE_SERVICE_KEY is different from the publishable key.
   Go to Supabase → Project Settings → API Keys → Legacy tab → copy service_role key.
   This key is ONLY used server-side in the webhook function — it's never exposed to the browser.

---

## Step 4 — Set up the Linear webhook

1. Go to Linear → Settings → API → Webhooks → New Webhook
2. URL: `https://your-vercel-url.vercel.app/api/linear-webhook`
3. Check: Issues (updated)
4. Save

---

## Step 5 — Set up Linear labels

Make sure you have a label called exactly `Changelog` in Linear
(Linear → Settings → Labels → New label → "Changelog").

Also make sure tickets have labels like `Feature`, `Bug`, `Improvement`, or `Integration`
so the webhook can pick the right changelog tag automatically.

---

## How it works day-to-day

1. You're working a ticket in Linear
2. Add the `Changelog` label to it
3. Move it to Done
4. Within seconds, a draft appears in your admin panel at `changelog.userevidence.com?admin=true`
5. You review the Claude-rewritten description, edit if needed, click Publish
6. It goes live instantly

---

## Admin access
URL: `https://changelog.userevidence.com?admin=true`
Password: `ue-admin-2025`
