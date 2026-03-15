// api/linear-webhook.js
// Vercel serverless function — receives Linear webhooks and creates changelog drafts

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;  // service role key (server-side only)
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const LINEAR_SECRET    = process.env.LINEAR_WEBHOOK_SECRET; // for verifying requests
const CHANGELOG_LABEL  = 'Changelog'; // Linear label name that opts a ticket in

// Map Linear labels → changelog tags
const LABEL_TAG_MAP = {
  'bug':          'Bug Fix',
  'fix':          'Bug Fix',
  'feature':      'New Feature',
  'improvement':  'Improvement',
  'integration':  'Integration',
  'announce':     'Announcement',
  'announcement': 'Announcement',
};

function pickTag(labels = []) {
  for (const label of labels) {
    const key = label.name.toLowerCase();
    if (LABEL_TAG_MAP[key]) return LABEL_TAG_MAP[key];
  }
  return 'New Feature'; // default
}

function hasChangelogLabel(labels = []) {
  return labels.some(l => l.name.toLowerCase() === CHANGELOG_LABEL.toLowerCase());
}

async function rewriteForCustomers(title, description) {
  const prompt = `You are writing a product changelog entry for UserEvidence, a B2B customer evidence and advocacy platform.

A software ticket has been completed. Rewrite it as a clean, customer-facing changelog description.

Rules:
- 2-4 sentences max
- Plain English, no jargon, no internal ticket language
- Focus on the customer benefit, not the technical implementation
- Do not mention ticket numbers, branch names, or engineer names
- Do not start with "We" — start with what the feature/fix does
- Tone: clear, confident, professional but warm

Ticket title: ${title}
Ticket description: ${description || 'No description provided.'}

Respond with only the rewritten description. No preamble, no quotes.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  return data?.content?.[0]?.text?.trim() || description || '';
}

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body;

    // We only care about Issue updates
    if (event.type !== 'Issue') {
      return res.status(200).json({ ok: true, skipped: 'not an issue event' });
    }

    const issue = event.data;
    const labels = issue.labels?.nodes || [];

    // Must have the Changelog label
    if (!hasChangelogLabel(labels)) {
      return res.status(200).json({ ok: true, skipped: 'no changelog label' });
    }

    // Must be moving to a "Done/Completed" state
    const stateName = (issue.state?.name || '').toLowerCase();
    const isDone = ['done', 'completed', 'released', 'shipped'].includes(stateName);
    if (!isDone) {
      return res.status(200).json({ ok: true, skipped: `state is "${issue.state?.name}", not done` });
    }

    // Check if we've already created a draft for this Linear issue
    const db = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: existing } = await db
      .from('changelog')
      .select('id')
      .eq('linear_id', issue.id)
      .single();

    if (existing) {
      return res.status(200).json({ ok: true, skipped: 'draft already exists for this issue' });
    }

    // Pick the best tag
    const tag = pickTag(labels.filter(l => l.name.toLowerCase() !== 'changelog'));

    // Rewrite the description with Claude
    const description = await rewriteForCustomers(issue.title, issue.description);

    // Insert as a draft
    const { error } = await db.from('changelog').insert({
      title:       issue.title,
      tag:         tag,
      date:        new Date().toISOString().slice(0, 10),
      description: description,
      media_url:   null,
      media_type:  null,
      status:      'draft',   // draft = pending review, published = live
      linear_id:   issue.id,  // prevent duplicate drafts
      linear_url:  issue.url,
    });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`Draft created for: ${issue.title}`);
    return res.status(200).json({ ok: true, created: issue.title });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
