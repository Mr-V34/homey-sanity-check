'use strict';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SUMMARY_HOUR = 8;          // local time, 0–23
// Daily summary: 'short' = only what needs attention, 'full' = everything.
const SUMMARY_DETAILS      = ['short', 'full'];
// Let other apps start after a boot before the post-mortem reads Insights, so
// its work doesn't add to the busiest minutes. Insights keeps the minutes
// before the restart for 6 hours, so waiting costs nothing.
const FIRST_CHECK_DELAY    = 10 * 60 * 1000;

// rebootReason values of a restart someone asked for. Athom's Web API (V3 Local)
// has exactly two restart calls, ManagerSystem.reboot and .rebootOTA
// (/reboot-ota), and both were seen in getInfo().rebootReason on a real Homey:
// "reboot" from the Homey app (2026-10-13) and "reboot-ota" after a firmware
// update (2026-10-15). Athom doesn't document the values.
const PLANNED_REASONS = ['reboot', 'reboot-ota'];
// The only value seen for a restart nobody asked for (2026-10-11 and 10-14).
const UNEXPECTED_REASON = 'unexpected';

module.exports = {
  DEFAULT_SUMMARY_HOUR, SUMMARY_DETAILS, FIRST_CHECK_DELAY, PLANNED_REASONS, UNEXPECTED_REASON,
};
