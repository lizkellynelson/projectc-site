// Temporary diagnostic for the cohort hub launch. Safe to delete.
exports.handler = async (event) => {
  let load = 'ok', run = null;
  try {
    const hub = require('./cohort-hub.js');
    const r = await hub.handler({ httpMethod: 'OPTIONS', headers: {}, body: null });
    run = { status: r.statusCode, headerTypes: Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k, typeof v])) };
  } catch (e) { load = String(e && e.stack || e).slice(0, 1500); }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ load, run, node: process.version }) };
};
