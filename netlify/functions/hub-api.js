// hub-api.js — the web endpoint for the Cohort Hub page (projectc.com/tiktok-cohort).
// All the logic lives in cohort-hub.js. Netlify wouldn't serve that file directly as a
// web endpoint (it sits next to the scheduled cohort-hub-scheduled.js), so the page calls this.
module.exports = require('./cohort-hub.js');
