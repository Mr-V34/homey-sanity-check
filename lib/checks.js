'use strict';

// ── Pure check logic ──────────────────────────────────────────────────────────
// No Homey dependencies: everything here takes plain data in and returns
// { state, events } out, so it can be unit-tested locally (see test/).
//
// Verified API facts this relies on (FINDINGS.md, 2026-10-13):
//   system.getInfo()  → bootId, bootDate, rebootReason, uptime, homeyVersion
//   apps.getApps()    → per app: version, state, enabled, crashed, crashedCount,
//                       crashedMessage, updateAvailable ({version} | null)
//   crashedCount resets when an app is (re)installed; whether it resets on a
//   Homey reboot is unverified, so a decreasing counter is treated as a reset.
//   apps usage.mem is RSS (incl. memory shared between apps); system memory
//   info types['homey:app:<id>'].size is PSS, the app's own share. 30 MB PSS
//   is an often quoted target; it is not in Athom's current docs (2026-10-14).

const { PLANNED_REASONS } = require('./constants');

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;
const MB   = 1e6;
const PSS_GUIDELINE = 30 * MB;
// A process change between two hourly snapshots worth reporting. First guess
// (2026-10-14), not calibrated.
const PROC_STEP = 20 * MB;

// ── System ────────────────────────────────────────────────────────────────────

function checkSystem(info, prev, now) {
  const events = [];
  const state = {
    bootId:       info.bootId,
    bootDate:     info.bootDate,
    rebootReason: info.rebootReason ?? null,
    homeyVersion: info.homeyVersion,
    boots:        Array.isArray(prev.boots) ? prev.boots.slice() : [],
    hw:           hwFlags(info),
  };

  // A flag that turned true since we last looked, within this boot.
  const seen = prev.bootId === info.bootId ? prev.hw || {} : {};
  for (const flag of HW_FLAGS) {
    if (state.hw[flag] && !seen[flag]) events.push({ type: 'hw_flag', flag });
  }

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
// system memory then and an hour before that, Sanity Check itself, and the
// five largest apps (PSS).
function beforeBoot(prev) {
  const top = Object.entries(prev.apps || {})
    .filter(([, a]) => Number.isFinite(a.pss))
    .sort(([, x], [, y]) => y.pss - x.pss)
    .slice(0, 5)
    .map(([id, a]) => ({ id, name: a.name, pss: a.pss }));
  return {
    lastCheck: (prev.lastCheck && prev.lastCheck.at) || null,
    sys:       prev.sys || null,
    sysPrev:   prev.sysPrev || null,
    self:      prev.self || null,
    hw:        prev.hw || null,
    swapApps:  prev.swapApps || null,
    topPss:    top,
  };
}

// A restart the user asked for, or a firmware update, is planned (see
// PLANNED_REASONS). Anything else, unknown values included, gets the analysis.
function isUnplanned(boot) {
  return !!boot && !PLANNED_REASONS.includes(boot.rebootReason);
}

// For the condition card: an unplanned restart within `ms` before `now`.
function unplannedWithin(boots, ms, now) {
  return (boots || []).some(b => isUnplanned(b) && now - new Date(b.bootDate).getTime() <= ms);
}

// getInfo() has four flags from the Raspberry Pi firmware (Homey Pro 2023 is
// a Compute Module 4). Their names say "occurred": like `vcgencmd
// get_throttled`, they stay set from the moment it happened until the next
// boot (that part is inferred from the names, not verified). Field names
// confirmed on a real Homey 13.5.2 (2026-10-15), all false then.
const HW_FLAGS = ['undervoltage', 'throttled', 'softTempLimit', 'freqCapped'];

function hwFlags(info) {
  return {
    undervoltage:  info.videoCoreUndervoltageOccured === true,
    throttled:     info.videoCoreThrottleOccured === true,
    softTempLimit: info.videoCoreSoftTemperatureLimitActiveOccured === true,
    freqCapped:    info.videoCoreArmFrequencyCappedOccured === true,
  };
}

// ── Once a day ────────────────────────────────────────────────────────────────
// Backup, firmware channel and storage change slowly, so the daily summary
// reads them (5 GET calls a day). Values come in as the API returns them.

const BACKUP_DAYS = 7; // automatic backups on, but none for this many days

// Homey's options answer { value } (or the bare value; both are accepted).
function optionValue(r) {
  return r && typeof r === 'object' && !Array.isArray(r) && 'value' in r ? r.value : r;
}

// lastSuccessfulBackup is a date string (seen: "Tue Sep 22 2026 23:46:30 GMT+0000").
function backupStatus(last, auto, now) {
  const t = Date.parse(optionValue(last));
  const on = optionValue(auto);
  if (on == null && !Number.isFinite(t)) return null;
  const days = Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
  return {
    last: Number.isFinite(t) ? t : null,
    auto: on === true ? true : on === false ? false : null,
    days,
    overdue: on === true && (days == null || days >= BACKUP_DAYS),
  };
}

function firmwareSettings(channel, auto) {
  const c = optionValue(channel);
  const a = optionValue(auto);
  if (c == null && a == null) return null;
  return { channel: typeof c === 'string' ? c : null, auto: typeof a === 'boolean' ? a : null };
}

const STORAGE_LOW = 0.1; // share of the total that is still free

function storageStatus(info) {
  if (!info || !Number.isFinite(info.total) || !Number.isFinite(info.free) || info.total <= 0) return null;
  return { free: info.free, total: info.total, low: info.free / info.total < STORAGE_LOW };
}

// ── Swap per app ──────────────────────────────────────────────────────────────
// Only apps.getAppUsage tells how much of an app is in swap (usage.mem.pssSwap),
// one call per app. Deviation from "one call per check", argued: swap of
// 93–232 MB was seen before restarts (2026-10-14/15) and nothing else says
// whose memory it is. So only when swap is high, and at most every 6 hours.
const SWAP_HIGH = 64 * 1e6;
// One app with this much in swap is a finding in the daily summary: it can
// free it by restarting. Total swap alone is not (2026-10-15: 74 MB swap with
// 400 MB free RAM, apps only 8 MB of it, nothing to act on). First guess,
// not calibrated.
const SWAP_APP_HIGH = 32 * 1e6;
const SWAP_EVERY = 6 * 60 * 60 * 1000;

function swapDue(sys, prevSwapApps, now) {
  return !!sys && Number.isFinite(sys.swap) && sys.swap >= SWAP_HIGH
    && (!prevSwapApps || now - prevSwapApps.t >= SWAP_EVERY);
}

// usage: { [appId]: getAppUsage() answer } → the three apps with most in swap.
function swapApps(usage, appsState, swap, now, limit = 3) {
  const top = Object.entries(usage || {})
    .map(([id, u]) => {
      const mem = u && (u.usage || u).mem;
      return { id, name: (appsState && appsState[id] && appsState[id].name) || id, swap: mem && mem.pssSwap };
    })
    .filter(a => Number.isFinite(a.swap) && a.swap >= 1e6)
    .sort((x, y) => y.swap - x.swap)
    .slice(0, limit);
  return { t: now, swap, top };
}

// getInfo().freemem, getMemoryInfo().swap and types.homey.size (Homey's own
// process). Bytes, or null when a call failed. `procs` holds every process
// that is not an app (Homey itself, Zigbee, Matter, video, "other"): Insights
// keeps no history for them, so the hourly snapshot is all we have.
function systemMemory(info, memory) {
  const num = v => (Number.isFinite(v) ? v : null);
  const procs = {};
  for (const [key, v] of Object.entries((memory && memory.types) || {})) {
    if (!key.startsWith('homey:app:') && v && Number.isFinite(v.size)) procs[key] = { name: v.name || key, size: v.size };
  }
  return {
    free: num(info && info.freemem),
    swap: num(memory && memory.swap),
    core: num(memory && memory.types && memory.types.homey && memory.types.homey.size),
    procs,
  };
}

// Processes that grew (or shrank) by at least `minBytes` between two hourly
// snapshots, largest change first.
function processChanges(sys, sysPrev, minBytes = PROC_STEP) {
  const now = (sys && sys.procs) || {};
  const before = (sysPrev && sysPrev.procs) || {};
  return Object.entries(now)
    .filter(([key]) => before[key] && Number.isFinite(before[key].size))
    .map(([key, p]) => ({ id: key, name: p.name, change: p.size - before[key].size }))
    .filter(p => Math.abs(p.change) >= minBytes)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
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

// Apps whose PSS grew at least `min` since the previous snapshot (taken at
// each daily summary), most growth first. Size alone is no finding: many
// healthy apps sit above 30 MB; growth day after day is what points at a leak.
const GROWTH_MIN = 10 * MB;

function memoryGrowth(appsState, snapshot = {}, min = GROWTH_MIN, limit = 3) {
  return Object.entries(appsState || {})
    .filter(([id, a]) => Number.isFinite(a.pss) && Number.isFinite(snapshot[id]) && a.pss - snapshot[id] >= min)
    .map(([id, a]) => ({ id, name: a.name, pss: a.pss, change: a.pss - snapshot[id] }))
    .sort((x, y) => y.change - x.change)
    .slice(0, limit);
}

// The largest apps by PSS with their change since the snapshot (full summary).
function largestApps(appsState, snapshot = {}, limit = 3) {
  return Object.entries(appsState || {})
    .filter(([, a]) => Number.isFinite(a.pss))
    .map(([id, a]) => ({ id, name: a.name, pss: a.pss, change: Number.isFinite(snapshot[id]) ? a.pss - snapshot[id] : null }))
    .sort((x, y) => y.pss - x.pss)
    .slice(0, limit);
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

function sum(list) {
  return list.reduce((acc, c) => acc + (c.n || 0), 0);
}

module.exports = {
  HOUR, DAY, MB, PSS_GUIDELINE, PROC_STEP, HW_FLAGS, BACKUP_DAYS, SWAP_HIGH, SWAP_APP_HIGH, GROWTH_MIN,
  hwFlags, optionValue, backupStatus, firmwareSettings, storageStatus, swapDue, swapApps,
  checkSystem, checkFirmware, checkApps, suspects,
  isUnplanned, unplannedWithin, systemMemory, processChanges, memoryGrowth, largestApps, pssSnapshot, pssFromMemoryInfo,
};
