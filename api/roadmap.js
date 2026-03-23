const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const TEAM_ID = '9747c7f4-4095-41a2-bc04-953bc6a42b57'; // Zealot team

const QUERY = `
  query RoadmapProjects {
    projects(
      first: 100
      orderBy: updatedAt
    ) {
      nodes {
        id
        name
        description
        startDate
        targetDate
        url
        priority { value name }
        lead { name }
        status { name }
        updatedAt
      }
    }
  }
`;

const SHOW_STATUSES = new Set(['In Progress', 'Planned']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!LINEAR_API_KEY) {
    return res.status(500).json({ error: 'LINEAR_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': LINEAR_API_KEY,
      },
      body: JSON.stringify({ query: QUERY }),
    });

    const json = await response.json();
    if (json.errors) {
      console.error('Linear API errors:', json.errors);
      return res.status(500).json({ error: json.errors[0]?.message || 'Linear API error' });
    }

    const projects = (json.data?.projects?.nodes || [])
      .filter(p => SHOW_STATUSES.has(p.status?.name));

    // Group by status category
    const grouped = {
      inProgress: projects.filter(p => p.status?.name === 'In Progress'),
      planned: projects.filter(p => p.status?.name === 'Planned'),
    };

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      projects,
      grouped,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Roadmap fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
};
