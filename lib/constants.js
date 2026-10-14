'use strict';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SUMMARY_HOUR = 8;          // local time, 0–23
const CHECK_INTERVAL       = 60 * 60 * 1000; // project.MD: full check at most hourly
// Let other apps start after a boot before the post-mortem reads Insights, so
// its work doesn't add to the busiest minutes. Insights keeps the minutes
// before the restart for 6 hours, so waiting costs nothing.
const FIRST_CHECK_DELAY    = 10 * 60 * 1000;

module.exports = { DEFAULT_SUMMARY_HOUR, CHECK_INTERVAL, FIRST_CHECK_DELAY };
