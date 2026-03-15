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

async function rewriteForCustomers(title, description) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: `You are writing a product changelog entry for UserEvidence, a B2B customer evidence platform. Rewrite this completed ticket as a clean 2-4 sentence customer-facing description. Focus on the benefit, no jargon, no ticket numbers. Don't start with "We".\n\nTitle: ${title}\nDescription: ${description || 'No description provided.'}\n\nRespond with only the rewritten description.` }],
    }),
  });
  const data = await res.json();
  return data?.content?.[0]?.text?.trim() || description || '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const event = req.body;
    if (event.type !== 'Issue') return res.status(200).json({ ok: true, skipped: 'not an issue' });
    const issue = event.data;
    const labels = issue.labels?.nodes || issue.labels || [];
    if (!hasChangelogLabel(labels)) return res.status(200).json({ ok: true, skipped: 'no changelog label' });
    const stateName = (issue.state?.name || issue.state || '').toLowerCase();
    const isDone = ['done', 'completed', 'released', 'shipped'].includes(stateName);
    if (!isDone) return res.status(200).json({ ok: true, skipped: `state is ${stateName}` });
    const db = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data: existing } = await db.from('changelog').select('id').eq('linear_id', issue.id).single();
    if (existing) return res.status(200).json({ ok: true, skipped: 'draft already exists' });
    const tag = pickTag(labels);
    const description = await rewriteForCustomers(issue.title, issue.description);
    const { error } = await db.from('changelog').insert({
      title: issue.title, tag, date: new Date().toISOString().slice(0, 10),
      description, media_url: null, media_type: null,
      status: 'draft', linear_id: issue.id, linear_url: issue.url,
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, created: issue.title });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
