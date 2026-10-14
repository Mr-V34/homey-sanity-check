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
//   apps usage.mem is RSS (incl. memory shared between apps); system memory
//   info types['homey:app:<id>'].size is PSS, the app's own share. Athom's
//   guideline is at most 30 MB PSS per app.

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;
const MB   = 1e6;
const PSS_GUIDELINE = 30 * MB;

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
      before:       beforeBoot(prev),
    };
    state.boots.push(boot);
    events.push({
      type: 'homey_restarted', ...boot,
      unplanned7d: state.boots.filter(b => isUnplanned(b) && now - new Date(b.bootDate).getTime() < 7 * DAY).length,
    });
  }
  state.boots = state.boots.slice(-10);

  if (prev.homeyVersion && prev.homeyVersion !== info.homeyVersion) {
    events.push({ type: 'homey_version_changed', from: prev.homeyVersion, to: info.homeyVersion });
  }

  return { state, events };
}

// The last picture we had before the restart. The next check overwrites
// prev.apps, so it is kept with the boot record: when we last looked, the
// system memory then, and the five largest apps (PSS).
function beforeBoot(prev) {
  const top = Object.entries(prev.apps || {})
    .filter(([, a]) => Number.isFinite(a.pss))
    .sort(([, x], [, y]) => y.pss - x.pss)
    .slice(0, 5)
    .map(([id, a]) => ({ id, name: a.name, pss: a.pss }));
  return { lastCheck: (prev.lastCheck && prev.lastCheck.at) || null, sys: prev.sys || null, topPss: top };
}

// 'reboot' is a restart the user asked for (verified 2026-10-13, FINDINGS 1.5b).
function isUnplanned(boot) {
  return !!boot && boot.rebootReason !== 'reboot';
}

// getInfo().freemem, getMemoryInfo().swap and types.homey.size (Homey's own
// process). Bytes, or null when a call failed.
function systemMemory(info, memory) {
  const num = v => (Number.isFinite(v) ? v : null);
  return {
    free: num(info && info.freemem),
    swap: num(memory && memory.swap),
    core: num(memory && memory.types && memory.types.homey && memory.types.homey.size),
  };
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

function checkApps(apps, prev, now, selfId, pssById = {}) {
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
      rss:     app.usage && Number.isFinite(app.usage.mem) && app.usage.mem > 0 ? app.usage.mem : null,
      pss:     Number.isFinite(pssById[app.id]) && pssById[app.id] > 0 ? pssById[app.id] : null,
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
      // Memory at the previous check is the last reading before the crash.
      // No error message after a crash suggests Homey stopped the app, e.g.
      // for too much memory (FINDINGS 1.1e/1.12: a JS error leaves a stack).
      const noMessage = !app.crashedMessage;
      entry.crashes.push({ t: now, n: delta, pss: p.pss ?? null, rss: p.rss ?? null, noMessage });
      events.push({
        type: 'app_crashed', id: app.id, name: app.name, version: app.version,
        delta, last24h: sum(entry.crashes), message: app.crashedMessage || null,
        pss: p.pss ?? null, noMessage,
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
    .map(([id, a]) => {
      const recent = (a.crashes || []).filter(c => c.t <= end && end - c.t < DAY);
      const pss = recent.map(c => c.pss).filter(Number.isFinite);
      return {
        id, name: a.name, version: a.version, update: a.update,
        crashes:   sum(recent),
        pss:       pss.length ? Math.max(...pss) : null,
        noMessage: recent.length > 0 && recent.every(c => c.noMessage === true),
      };
    })
    .filter(s => s.crashes > 0)
    .sort((x, y) => y.crashes - x.crashes)
    .slice(0, limit);
}

// Apps above Athom's 30 MB PSS guideline, largest first, with the change since
// the previous snapshot (taken at each daily summary).
function memoryReport(appsState, snapshot = {}, limit = 3) {
  const over = Object.entries(appsState || {})
    .filter(([, a]) => Number.isFinite(a.pss) && a.pss > PSS_GUIDELINE)
    .map(([id, a]) => ({
      id, name: a.name, pss: a.pss,
      change: Number.isFinite(snapshot[id]) ? a.pss - snapshot[id] : null,
    }))
    .sort((x, y) => y.pss - x.pss);
  return { count: over.length, top: over.slice(0, limit) };
}

function pssSnapshot(appsState) {
  return Object.fromEntries(Object.entries(appsState || {})
    .filter(([, a]) => Number.isFinite(a.pss))
    .map(([id, a]) => [id, a.pss]));
}

// system.getMemoryInfo() → { [appId]: pss bytes }
function pssFromMemoryInfo(info) {
  const out = {};
  for (const [key, v] of Object.entries((info && info.types) || {})) {
    if (key.startsWith('homey:app:') && v && Number.isFinite(v.size)) out[key.slice(10)] = v.size;
  }
  return out;
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
  HOUR, DAY, MB, PSS_GUIDELINE,
  checkSystem, checkFirmware, checkApps, checkSensors, suspects,
  isUnplanned, systemMemory, memoryReport, pssSnapshot, pssFromMemoryInfo,
};
