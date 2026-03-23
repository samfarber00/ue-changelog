-- Run this in your Supabase SQL Editor
-- Adds the columns needed for the Linear webhook integration

ALTER TABLE changelog
  ADD COLUMN IF NOT EXISTS status     text DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS linear_id  text,
  ADD COLUMN IF NOT EXISTS linear_url text;

-- Make sure existing entries stay published
UPDATE changelog SET status = 'published' WHERE status IS NULL;

-- Index for fast draft lookups
CREATE INDEX IF NOT EXISTS idx_changelog_status ON changelog(status);

-- Prevent duplicate drafts from the same Linear ticket
CREATE UNIQUE INDEX IF NOT EXISTS idx_changelog_linear_id ON changelog(linear_id) WHERE linear_id IS NOT NULL;

-- ── FEATURE IDEAS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_ideas (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL,
  description text,
  vote_count  int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idea_votes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idea_id     bigint REFERENCES feature_ideas(id) ON DELETE CASCADE,
  voter_token text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (idea_id, voter_token)
);

CREATE TABLE IF NOT EXISTS idea_comments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idea_id     bigint REFERENCES feature_ideas(id) ON DELETE CASCADE,
  author_name text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE feature_ideas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE idea_votes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE idea_comments  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read ideas"    ON feature_ideas FOR SELECT USING (true);
CREATE POLICY "public insert ideas"  ON feature_ideas FOR INSERT WITH CHECK (true);
CREATE POLICY "public read votes"    ON idea_votes    FOR SELECT USING (true);
CREATE POLICY "public insert votes"  ON idea_votes    FOR INSERT WITH CHECK (true);
CREATE POLICY "public delete votes"  ON idea_votes    FOR DELETE USING (true);
CREATE POLICY "public read comments" ON idea_comments FOR SELECT USING (true);
CREATE POLICY "public insert comments" ON idea_comments FOR INSERT WITH CHECK (true);

-- Atomic vote function (avoids direct update of vote_count from client)
CREATE OR REPLACE FUNCTION vote_idea(p_idea_id bigint, p_voter_token text, p_vote boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_vote THEN
    INSERT INTO idea_votes (idea_id, voter_token) VALUES (p_idea_id, p_voter_token) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM idea_votes WHERE idea_id = p_idea_id AND voter_token = p_voter_token;
  END IF;
  UPDATE feature_ideas SET vote_count = (SELECT COUNT(*) FROM idea_votes WHERE idea_id = p_idea_id) WHERE id = p_idea_id;
END;
$$;

-- ── ROADMAP ITEMS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'Planned',
  item_type   text NOT NULL DEFAULT 'project',
  target      text,
  sort_order  int DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- If table already exists from a prior migration run, add the column safely
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'project';

ALTER TABLE roadmap_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read roadmap"   ON roadmap_items FOR SELECT USING (true);

INSERT INTO roadmap_items (name, description, status, target, sort_order) VALUES
  ('Community Hub Revamp', 'Adding direct messaging between members, upvoting on replies, space editing after creation, and search across the entire community. Making your hub feel like a real destination, not just a forum.', 'In Progress', null, 0),
  ('Smart Reference Matching', 'Set a quota, rank a pool of nominees, and the system activates them in waves — auto-backfilling when someone declines. No more chasing one person at a time.', 'In Progress', null, 1),
  ('CSV Import & Custom Fields', 'Upload a spreadsheet, map columns to fields, and get custom data (industry, region, CSM, revenue tier) living on every advocate profile.', 'In Progress', null, 2),
  ('Smart Segmentation & Targeting', 'Build AND/OR/exclude rules that automatically determine which advocates qualify for which missions, rewards, and programs. Target by any field — custom or native.', 'Planned', 'May 2026', 0),
  ('Advocacy ROI Analytics', 'Track the direct connection between advocacy acts and GRR, NRR, and new ARR. Dashboards built for the CMO — not just the program manager.', 'Planned', null, 1),
  ('MCP Server', 'An MCP server that lets AI tools like Claude trigger advocacy actions via natural language. Enroll advocates, fire missions, or request references directly from Slack, your CRM, or any AI workflow.', 'Planned', null, 2),
  ('Reference Management Enhancements', 'Branch logic for routing requests, bulk reference requests, and deeper Airtable/Carta integrations.', 'Planned', null, 3),
  ('Referrals', 'A full referral program — advocates refer new customers, earn rewards, and you get attribution. Built-in payout tracking.', 'Coming Soon', null, 0),
  ('Embedded Advocacy (In-App)', 'Missions and advocacy moments delivered inside your product as pop-ups — no portal, no login friction.', 'Coming Soon', null, 1),
  ('AI-Powered Engagements', 'AI builds and personalizes journeys automatically — right message, right advocate, right moment — without you having to manually configure every step.', 'Coming Soon', null, 2)
ON CONFLICT DO NOTHING;

-- Seed initial ideas
INSERT INTO feature_ideas (title, description, vote_count) VALUES
  ('Bulk Advocate Management', 'Filter down to a specific group of advocates and take bulk actions — add to segment, lock accounts, apply notes, or change status in one shot.', 0),
  ('Evi Slack Bot', 'Ask @evi anything in Slack — "get me a reference for this deal", "who are our top advocates at Acme", "enroll these people in the Q2 mission". Natural language, instant results.', 0),
  ('Advocate Onboarding Flow', 'A simple setup wizard for new admins based on their goals and products. Get from zero to first mission in under 10 minutes.', 0),
  ('Next Best Actions', 'AI-powered recommendations that tell you which advocates to engage, when, and how — based on signals from your product, CRM, and review sites.', 0),
  ('Multi-Tenant Support', 'Let advocates belong to multiple community spaces with the same email. Useful for agencies, consultants, and customers who work across multiple brands.', 0),
  ('AI-Powered Journeys', 'Instead of manually building engagement sequences, AI personalizes every journey automatically — right message, right advocate, right moment.', 0)
ON CONFLICT DO NOTHING;
