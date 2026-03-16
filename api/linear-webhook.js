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
      content: `You are writing a changelog entry for UserEvidence, a B2B SaaS product.

UserEvidence has three product areas:
- Advocacy: advocate hub, missions, badges, rewards, leaderboards, events, email triggers, advocate profiles
- References: reference matching, case studies, testimonials, reviews, reference requests, ROI
- Community: community forum, member directory, posts, channels, discussions, announcements

Given the Linear ticket below, return JSON with exactly these fields:
- "title": 3-6 plain words describing what changed. No buzzwords, no jargon, no gerunds like "introducing" or "enabling." Just say what it is.
- "description": 1-2 sentences max. Start with the problem it solved, then say what you can do now. Write at a 5th grade reading level. Be specific and concrete. No fluff.
- "product": one of "Advocacy", "References", "Community" (pick the best fit)
- "tag": one of "New Feature", "Improvement", "Bug Fix", "Integration", "Announcement"

Example output:
{"title":"CC multiple people on reference emails","description":"You used to have to pick one person to send reference outreach to. Now you can add your AE and CSM at the same time.","product":"References","tag":"Improvement"}

Ticket title: ${title}
Ticket description: ${(description || 'No description provided.').slice(0, 2000)}

Reply with only valid JSON. No markdown, no code blocks.`
    }],
  });
  const raw = msg.content?.[0]?.text?.trim() || '';
  console.log('Anthropic response:', raw.slice(0, 300));
  // Strip markdown code blocks if present
  const text = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    console.log('JSON parse failed, raw:', raw.slice(0, 200));
    return null;
  }
}

async function extractAndUploadImage(description, linearId, db) {
  if (!description) return null;
  const match = description.match(/!\[.*?\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/);
  if (!match) return null;
  const imageUrl = match[1];
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) return null;
    const buffer = await res.arrayBuffer();
    const ext = contentType.split('/')[1]?.split(';')[0] || 'png';
    const path = `${linearId}.${ext}`;
    const { error } = await db.storage.from('changelog-media').upload(path, buffer, { contentType, upsert: true });
    if (error) { console.error('Storage upload error:', error.message); return null; }
    const { data } = db.storage.from('changelog-media').getPublicUrl(path);
    console.log('Image uploaded:', data.publicUrl);
    return data.publicUrl;
  } catch (err) {
    console.error('Image upload failed:', err.message);
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
    title: result?.title || cleanedTitle,
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
    const [rewritten, mediaUrl] = await Promise.all([
      rewriteForCustomers(issue.title, issue.description, fallbackTag),
      extractAndUploadImage(issue.description, issue.id, db),
    ]);
    const people = [];
    if (issue.assignee?.name) people.push({ name: issue.assignee.name, avatar: issue.assignee.avatarUrl || null });
    if (issue.creator?.name && issue.creator.name !== issue.assignee?.name) people.push({ name: issue.creator.name, avatar: issue.creator.avatarUrl || null });
    const builtBy = people.length ? people : null;
    const { error } = await db.from('changelog').insert({
      title: rewritten.title, tag: rewritten.tag, product: rewritten.product,
      date: new Date().toISOString().slice(0, 10),
      description: rewritten.description,
      media_url: mediaUrl, media_type: mediaUrl ? 'image' : null,
      built_by: builtBy,
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
