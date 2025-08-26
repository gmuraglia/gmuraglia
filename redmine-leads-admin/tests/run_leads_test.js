// Local test harness for redmine-leads-admin/api/leads.js
const leadsFn = require('../api/leads');

function makeReq(date, password) {
  return {
    query: { date },
    headers: { x-admin-password: password },
  };
}

function makeRes() {
  return {
    _status: 200,
    _json: null,
    status(code) { this._status = code; return this; },
    json(obj) { this._json = obj ; console.log('STATUS', this._status); console.log(JSON.stringify(obj, null, 2)); },
  };
}

(io => {
  const date = process.argv[2];
  if (!date) { console.error('Usage: node redmine-leads-admin/tests/run_leads_test.js YYYY-MM-DD'); process.exit(1) }
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
  if (!ADMIN_PASSWORD) { console.error("Set ADMIN_PASSWORD env var"); process.exit(2) }
  const req = makeReq(date, ADMIN_PASSWORD);
  const res = makeRes();
  await leadsFn(req, res);
})();
