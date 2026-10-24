// Temporary diagnostic for the cohort hub launch. Safe to delete.
// Reports only sizes, never values.
exports.handler = async () => {
  const env = process.env;
  const total = Object.keys(env).reduce((n, k) => n + k.length + String(env[k]).length, 0);
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, envBytes: total, node: process.version }) };
};
