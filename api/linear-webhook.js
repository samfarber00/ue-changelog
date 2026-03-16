const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CHANGELOG_LABEL = 'Changelog';

const LABEL_TAG_MAP = {
  'bug': 'Bug Fix', 'fix': 'Bug Fix',
  'feature': 'New Feature', 'improvement': 'Improvement',
  'integration': 'Integration', 'announce': 'Announcement', 'announcement': 'Announcement',
};

function getLabelsArray(labels) {
  if (!labels) return [];
  if (Array.isArray(labels)) return labels;
  if (labels.nodes) return labels.nodes;
  if (typeof labels === 'string') {
    try { return JSON.parse(labels); } catch { return [{ name: labels }]; }
  }
  return [];
}

function hasChangelogLabel(labels) {
  return getLabelsArray(labels).some(l =>
    (l.name || l || '').toString().toLowerCase() === CHANGELOG_LABEL.toLowerCase()
  );
}

function pickTag(labels) {
  for (const label of getLabelsArray(labels)) {
    const key = (label.name || label || '').toString().toLowerCase();
    if (key !== 'changelog' && LABEL_TAG_MAP[key]) return LABEL_TAG_MAP[key];
  }
  return 'New Feature';
}

function cleanTitle(title) {
  // Strip [Company] or [Co1, Co2] prefixes and trim
  return title.replace(/^\[.*?\]\s*/g, '').trim();
}

async function rewriteDescription(title, description) {
  const prompt = `You are writing a product changelog entry for UserEvidence, a B2B customer evidence and advocacy platform.

A software ticket has just been completed. Write a 1-2 sentence customer-facing description of what shipped.

Rules:
- Plain prose only, no markdown, no bullet points
- Focus on the customer benefit, not technical details
- Do not start with "We"
- Tone: clear, confident, professional

Ticket title: ${title}
Ticket description: ${description || 'No description provided.'}

Reply with only the description text. Nothing else.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const errorMsg = `[AI status:${res.status} err:${data?.error?.message || data?.error?.type || 'none'} type:${data?.type}]`;
  console.log('Anthropic:', errorMsg);
  const text = data?.content?.[0]?.text?.trim();
  if (!text) return errorMsg; // surface error in draft so we can see it
  return text;
}

async function rewriteForCustomers(title, description) {
  const cleanedTitle = cleanTitle(title);
  const rewrittenDesc = await rewriteDescription(title, description);
  return {
    title: cleanedTitle,
    description: rewrittenDesc || description || '',
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const event = req.body;
    if (event.type !== 'Issue') return res.status(200).json({ ok: true, skipped: 'not an issue' });
    const issue = event.data;
    const labels = getLabelsArray(issue.labels);
    if (!hasChangelogLabel(labels)) return res.status(200).json({ ok: true, skipped: 'no changelog label' });
    const stateName = (issue.state?.name || issue.state || '').toLowerCase();
    const isDone = ['done', 'completed', 'released', 'shipped'].includes(stateName);
    if (!isDone) return res.status(200).json({ ok: true, skipped: `state is "${stateName}", not done` });
    const db = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: existing } = await db.from('changelog').select('id').eq('linear_id', issue.id).single();
    if (existing) return res.status(200).json({ ok: true, skipped: 'draft already exists' });
    const tag = pickTag(labels);
    const rewritten = await rewriteForCustomers(issue.title, issue.description);
    const { error } = await db.from('changelog').insert({
      title: rewritten.title, tag, date: new Date().toISOString().slice(0, 10),
      description: rewritten.description, media_url: null, media_type: null,
      status: 'draft', linear_id: issue.id, linear_url: issue.url,
    });
    if (error) { console.error('Supabase insert error:', error); return res.status(500).json({ error: error.message }); }
    console.log(`Draft created for: ${rewritten.title}`);
    return res.status(200).json({ ok: true, created: rewritten.title });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
