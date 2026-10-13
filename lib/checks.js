'use strict';

// ── Pure check logic ──────────────────────────────────────────────────────────
// No Homey dependencies: everything here takes plain data in and returns
// { state, events } out, so it can be unit-tested locally (see test/).
//
// Verified API facts this relies on (FINDINGS.md, 2026-10-13):
//   system.getInfo()  → bootId, bootDate, rebootReason, uptime, homeyVersion
//   apps.getApps()    → per app: version, state, enabled, crashed, crashedCount,
//                       crashedMessage, updateAvailable ({version} | null)
//   devices.getDevices() → per device: class, lastSeenAt, available, zone
//   crashedCount resets when an app is (re)installed; whether it resets on a
//   Homey reboot is unverified, so a decreasing counter is treated as a reset.

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// ── System ────────────────────────────────────────────────────────────────────

function checkSystem(info, prev, now) {
  const events = [];
  const state = {
    bootId:       info.bootId,
    bootDate:     info.bootDate,
    rebootReason: info.rebootReason ?? null,
    homeyVersion: info.homeyVersion,
    boots:        Array.isArray(prev.boots) ? prev.boots.slice() : [],
  };

  if (prev.bootId && prev.bootId !== info.bootId) {
    const prevUptimeMs = prev.bootDate
      ? new Date(info.bootDate).getTime() - new Date(prev.bootDate).getTime()
      : null;
    const boot = {
      bootDate:     info.bootDate,
      rebootReason: info.rebootReason ?? null,
      prevUptimeMs,
      seenAt:       new Date(now).toISOString(),
    };
    state.boots.push(boot);
    events.push({ type: 'homey_restarted', ...boot });
  }
  state.boots = state.boots.slice(-10);

  if (prev.homeyVersion && prev.homeyVersion !== info.homeyVersion) {
    events.push({ type: 'homey_version_changed', from: prev.homeyVersion, to: info.homeyVersion });
  }

  return { state, events };
}

function checkFirmware(updates, prev) {
  const list = Array.isArray(updates) ? updates : Object.values(updates || {});
  const versions = list.map(u => u && (u.version || u.name || u.id)).filter(Boolean).map(String);
  const latest = versions.length ? versions[versions.length - 1] : null;
  const events = [];
  if (latest && latest !== prev.firmwareAvailable) {
    events.push({ type: 'firmware_available', version: latest });
  }
  return { state: { firmwareAvailable: latest }, events };
}

// ── Apps ──────────────────────────────────────────────────────────────────────
// prev.apps[id] = { version, state, enabled, count, crashes: [{t, n}] }
// crashes holds only hours with new crashes, pruned to 24 h, so it stays tiny.

function checkApps(apps, prev, now, selfId) {
  const events = [];
  const prevApps = prev.apps || {};
  const next = {};

  for (const app of apps) {
    if (!app || !app.id || app.id === selfId) continue;
    const p = prevApps[app.id];
    const count = Number(app.crashedCount) || 0;
    const entry = {
      name:    app.name,
      version: app.version,
      state:   app.state,
      enabled: app.enabled,
      count,
      crashes: [],
      update:  app.updateAvailable && app.updateAvailable.version ? String(app.updateAvailable.version) : null,
    };

    if (!p) {
      // First sighting: baseline only. Existing crashes are history, not news.
      next[app.id] = entry;
      continue;
    }

    if (p.version !== app.version) {
      // New version = new app: statistics start over (user decision 2026-10-13).
      events.push({ type: 'app_version_changed', id: app.id, name: app.name, from: p.version, to: app.version });
      next[app.id] = entry;
      continue;
    }

    entry.crashes = (p.crashes || []).filter(c => now - c.t < DAY);
    const delta = count >= p.count ? count - p.count : count; // decrease = counter was reset
    if (delta > 0) {
      entry.crashes.push({ t: now, n: delta });
      events.push({
        type: 'app_crashed', id: app.id, name: app.name, version: app.version,
        delta, last24h: sum(entry.crashes), message: app.crashedMessage || null,
      });
    }

    if (p.enabled && app.enabled === false) {
      events.push({ type: 'app_disabled', id: app.id, name: app.name, version: app.version });
    }
    if (p.state === 'running' && app.state !== 'running' && app.enabled !== false) {
      events.push({ type: 'app_not_running', id: app.id, name: app.name, version: app.version, state: app.state });
    }
    if (entry.update && entry.update !== p.update) {
      events.push({ type: 'app_update_available', id: app.id, name: app.name, version: app.version, update: entry.update });
    }

    next[app.id] = entry;
  }

  return { state: { apps: next }, events };
}

// Apps ranked by crashes within the 24 h before `until` — the "fingervisning".
function suspects(appsState, until, limit = 3) {
  const end = new Date(until).getTime();
  return Object.entries(appsState || {})
    .map(([id, a]) => ({
      id, name: a.name, version: a.version, update: a.update,
      crashes: sum((a.crashes || []).filter(c => c.t <= end && end - c.t < DAY)),
    }))
    .filter(s => s.crashes > 0)
    .sort((x, y) => y.crashes - x.crashes)
    .slice(0, limit);
}

// ── Sensors ───────────────────────────────────────────────────────────────────
// thresholds: { [deviceClass]: hours }, 0 or missing = class not monitored.
// Some drivers never set lastSeenAt (verified 2026-10-13: Aqara weather and
// leak sensors), so the newest capability lastUpdated is the fallback.
// Devices with neither (virtual buttons etc.) are skipped: nothing to judge.
//
// lastSeenAt is NOT kept across a Homey reboot (verified 2026-10-13: 12 devices
// without it before a reboot, 58 after). Until Homey has been up longer than a
// device's threshold, a device without lastSeenAt cannot be judged: it keeps
// its previous status and no event is sent. Without this, lights that simply
// had not changed value for a day were reported as silent after every reboot.

function lastSeen(d) {
  if (d.lastSeenAt) return new Date(d.lastSeenAt).getTime();
  const stamps = Object.values(d.capabilitiesObj || {})
    .map(c => c && c.lastUpdated && new Date(c.lastUpdated).getTime())
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

function checkSensors(devices, prev, thresholds, now, bootDate) {
  const events = [];
  const wasSilent = new Set(prev.silent || []);
  const silent = [];
  const current = [];
  const upMs = bootDate ? now - new Date(bootDate).getTime() : Infinity;

  for (const d of devices) {
    if (!d || !d.id) continue;
    const hours = Number(thresholds[d.class]) || 0;
    const seen = hours > 0 ? lastSeen(d) : null;
    if (seen == null) continue;

    const limit = hours * HOUR;
    const age = now - seen;
    if (age > limit && !d.lastSeenAt && upMs <= limit) {
      // Undecidable since the reboot: keep the previous status quietly.
      if (wasSilent.has(d.id)) {
        silent.push(d.id);
        current.push({ id: d.id, name: d.name, zone: d.zone, class: d.class, ageMs: age });
      }
      continue;
    }
    if (age > limit) {
      silent.push(d.id);
      current.push({ id: d.id, name: d.name, zone: d.zone, class: d.class, ageMs: age });
      if (!wasSilent.has(d.id)) {
        events.push({ type: 'sensor_silent', id: d.id, name: d.name, zone: d.zone, class: d.class, ageMs: age });
      }
    } else if (wasSilent.has(d.id)) {
      events.push({ type: 'sensor_back', id: d.id, name: d.name, zone: d.zone, class: d.class });
    }
  }

  return { state: { silent }, events, current };
}

function sum(list) {
  return list.reduce((acc, c) => acc + (c.n || 0), 0);
}

module.exports = {
  HOUR, DAY, checkSystem, checkFirmware, checkApps, checkSensors, suspects,
};
