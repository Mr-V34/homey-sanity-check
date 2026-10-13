'use strict';

// ── Defaults ──────────────────────────────────────────────────────────────────
// Hours without a report before a device counts as silent, per device class.
// 0 = not monitored. Battery sensors may sleep for hours, so sensors get a
// full day. Users change these on the settings page.

const DEFAULT_THRESHOLDS = {
  sensor:     24,
  light:      12,
  socket:     12,
  thermostat: 24,
  heater:     24,
  lock:       24,
  windowcoverings: 24,
};

const DEFAULT_SUMMARY_HOUR = 8;          // local time, 0–23

// How silent devices reach the timeline (settings page):
//   'daily'   – only listed in the daily summary (default: no spam)
//   'grouped' – one message per check, all devices together
//   'each'    – one message per device
const SILENT_REPORT_MODES  = ['daily', 'grouped', 'each'];
const DEFAULT_SILENT_REPORT = 'daily';
const CHECK_INTERVAL       = 60 * 60 * 1000; // project.MD: full check at most hourly
const FIRST_CHECK_DELAY    = 2 * 60 * 1000;  // let other apps start after a boot

module.exports = {
  DEFAULT_THRESHOLDS, DEFAULT_SUMMARY_HOUR, CHECK_INTERVAL, FIRST_CHECK_DELAY,
  SILENT_REPORT_MODES, DEFAULT_SILENT_REPORT,
};
