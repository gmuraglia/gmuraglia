// Vercel Serverless Function: GET /api/leads?date=YYYY-MM-DD
// Auth: header "x-admin-password" must match process.env.ADMIN_PASSWORD
// Filters via env (optional): PROJECT_IDS (comma), LEADS_TRACKER_ID (id), REPORT_TZ_OFFSET (hours, default -3)

function toYMD(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayRangeUTC(dateStr, tzOffsetHours) {
  // Interpret dateStr as local day in tzOffset; convert to UTC range
  const [y, m, d] = dateStr.split('-').map(Number);
  const startLocal = new Date(y, m - 1, d, 0, 0, 0);
  const endLocal = new Date(y, m - 1, d, 23, 59, 59);
  const startUTC = new Date(startLocal.getTime() - tzOffsetHours * 3600 * 1000);
  const endUTC = new Date(endLocal.getTime() - tzOffsetHours * 3600 * 1000);
  return { startUTC, endUTC };
}

async function redmineGet(baseUrl, apiKey, path, params = {}) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { 'X-Redmine-API-Key': apiKey, Accept: 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Redmine GET ${url} -> ${res.status} ${res.statusText} ${t}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  try {
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
    const BASE_URL = process.env.REDMINE_BASE_URL || '';
    const API_KEY = process.env.REDMINE_API_KEY || '';
    if (!BASE_URL || !API_KEY) return res.status(500).json({ error: 'Missing REDMINE env' });

    const headerPwd = req.headers['x-admin-password'];
    if (!headerPwd || headerPwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

    const PROJECT_IDS = (process.env.PROJECT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const LEADS_TRACKER_ID = process.env.LEADS_TRACKER_ID || '';
    const tzOffset = parseInt(process.env.REPORT_TZ_OFFSET || '-3', 10);

    const dateStr = (req.query.date || '').toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });

    const { startUTC, endUTC } = dayRangeUTC(dateStr, tzOffset);

    const results = [];
    const limit = 100;
    let offset = 0;
    const paramsCommon = { status_id: '*', sort: 'created_on:desc', limit };

    while (true) {
      if (PROJECT_IDS.length > 0) {
        for (const pid of PROJECT_IDS) {
          const page = await redmineGet(BASE_URL, API_KEY, '/issues.json', {
            ...paramsCommon, offset,
            project_id: pid,
            ...(LEADS_TRACKER_ID ? { tracker_id: LEADS_TRACKER_ID } : {}),
          });
          results.push(...(page.issues || []));
        }
      } else {
        const page = await redmineGet(BASE_URL, API_KEY, '/issues.json', {
          ...paramsCommon, offset,
          ...(LEADS_TRACKER_ID ? { tracker_id: LEADS_TRACKER_ID } : {}),
        });
        results.push(...(page.issues || []));

        const total = page.total_count ?? (page.issues || []).length;
        if (offset + limit >= total) break;
      }

      offset += limit;
      if (offset >= 2000) break; // safety
      const last = results[results.length - 1];
      if (!last) break;
      const lastCreated = new Date(last.created_on);
      if (lastCreated < startUTC) break;
    }

    const leads = results.filter(it => {
      created = new Date(it.created_on);
      return created >= startUTC && created <= endTTC;
    }).map(it => ({
      id: it.id,
      subject: it.subject,
      project: it.project?.name,
      author: it.author?.name,
      created_on: it.created_on,J
      tracker: it.tracker?.name,
      status: it.status?.name,
    }));

    res.json({ date: dateStr, count: leads.length, leads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

