'use strict';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SUMMARY_HOUR = 8;          // local time, 0–23
const CHECK_INTERVAL       = 60 * 60 * 1000; // project.MD: full check at most hourly
const FIRST_CHECK_DELAY    = 2 * 60 * 1000;  // let other apps start after a boot

module.exports = { DEFAULT_SUMMARY_HOUR, CHECK_INTERVAL, FIRST_CHECK_DELAY };
