const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

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

async function analyzeTicket(title, description) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You are categorizing a completed software ticket for UserEvidence's product changelog.

UserEvidence has three product areas:
- Advocacy: advocate hub, missions, badges, rewards, leaderboards, events, email triggers, advocate profiles
- References: reference matching, case studies, testimonials, reviews, reference requests, ROI
- Community: community forum, member directory, posts, channels, discussions, announcements

Analyze this ticket and return JSON with exactly these fields:
- "description": 1-2 sentence customer-facing description (plain prose, no markdown, no "We", focus on benefit)
- "product": one of "Advocacy", "References", "Community" (pick the best fit)
- "tag": one of "New Feature", "Improvement", "Bug Fix", "Integration", "Announcement"

Ticket title: ${title}
Ticket description: ${(description || 'No description provided.').slice(0, 2000)}

Reply with only valid JSON. No markdown, no code blocks.`
    }],
  });
  const raw = msg.content?.[0]?.text?.trim() || '';
  console.log('Anthropic response:', raw.slice(0, 300));
  // Strip markdown code blocks if present
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    console.log('JSON parse failed, raw:', raw.slice(0, 200));
    return null;
  }
}

async function rewriteForCustomers(title, description, fallbackTag) {
  const cleanedTitle = cleanTitle(title);
  let result = null;
  try {
    result = await analyzeTicket(title, description);
  } catch (err) {
    console.error('AI rewrite failed, using fallback:', err.message);
  }
  return {
    title: cleanedTitle,
    description: result?.description || description || '',
    product: result?.product || 'Advocacy',
    tag: result?.tag || fallbackTag || 'New Feature',
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
    const fallbackTag = pickTag(labels);
    const rewritten = await rewriteForCustomers(issue.title, issue.description, fallbackTag);
    const { error } = await db.from('changelog').insert({
      title: rewritten.title, tag: rewritten.tag, product: rewritten.product,
      date: new Date().toISOString().slice(0, 10),
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
