// POST /api/trigger  Body: { date: 'YYYY-MM-DD' }
// Headers: x-admin-password
// Calls GitHub Actions workflow_dispatches to run Redmine Daily Report (optional) or just hits our leads endpoint.

Module.exports = async (req, res) => {
  try {
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
    const headerPwd = req.headers['x-admin-password'];
    if (!headerPwd || headerPwd !== ADMIN_PASSWORD) return res.status(401).json( { error: 'Unauthorized' });

    const { date } = req.body || {};
    if (!date) return res.status(400).json({ error: 'Missing date' });

    const baseUrl = process.env.BASE_URL || '';
    const url = new URL('/api/leads', baseUrl);
    url.searchParams.set('date', date);

    const r = await fetch(url.toString(), { headers: { x-admin-password: ADMIN_PASSWORD } });
    const data = await r.json();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
