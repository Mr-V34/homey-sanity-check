'use strict';

// ── Patterns over time ────────────────────────────────────────────────────────
// Links restarts and crashes to the clock: exact crash minutes from Insights,
// scheduled Flows near a restart, times of day that keep coming back, and
// apps that crash before several restarts. Pure functions; times are epoch ms.
// `local(t)` returns { h, m } in Homey's timezone (supplied by the app).

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const HISTORY_DAYS = 30;
const HISTORY_MAX = 60;

// ── Crash minutes ─────────────────────────────────────────────────────────────
// A crashed app's RAM in Insights falls to 0 (or far below the minute before)
// and then starts over. Returns the minutes where that happened in (from, to].

function crashMinutes(memEntries, from, to) {
  const v = (memEntries || [])
    .map(e => ({ t: new Date(e.t).getTime(), v: Number.isFinite(e.v) ? e.v : 0 }))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (v[i].t <= from || v[i].t > to) continue;
    const prev = v[i - 1].v;
    if (prev > 0 && v[i].v < prev * 0.5) out.push(v[i].t);
  }
  return out;
}

// ── Scheduled Flows ───────────────────────────────────────────────────────────
// Time triggers in basic and Advanced Flows (card ids verified 2026-10-14):
//   homey:manager:cron:time_exactly  args.time "HH:MM"
//   homey:manager:cron:every_nth     args.n, args.type "minute" | "hour"
// every_nth is assumed to run on the clock (:00, :15, …): not verified.

function timeTriggers(flow) {
  const cards = [];
  if (flow.trigger) cards.push(flow.trigger);                       // basic Flow
  for (const c of Object.values(flow.cards || {})) {               // Advanced Flow
    if (c && c.type === 'trigger') cards.push(c);
  }
  const out = [];
  for (const c of cards) {
    const id = String(c.id || '');
    const args = c.args || {};
    if (id.endsWith('cron:time_exactly') && /^\d{1,2}:\d{2}$/.test(args.time || '')) {
      const [h, m] = args.time.split(':').map(Number);
      out.push({ kind: 'time', minuteOfDay: h * 60 + m, label: args.time.padStart(5, '0') });
    } else if (id.endsWith('cron:every_nth') && Number(args.n) > 0) {
      out.push({ kind: 'every', n: Number(args.n), unit: args.type === 'hour' ? 'hour' : 'minute' });
    }
  }
  return out;
}

// Flows with a time trigger in the minutes before `at` (default 15 min before
// to 2 min after). Periodic triggers only count when they fire every 5 min or
// less often, otherwise every restart would match.
function scheduledNear(flows, at, local, { before = 15, after = 2 } = {}) {
  const { h, m } = local(at);
  const now = h * 60 + m;
  const hits = [];
  for (const f of flows || []) {
    if (!f || f.enabled === false) continue;
    for (const tr of timeTriggers(f)) {
      if (tr.kind === 'time') {
        const d = ((now - tr.minuteOfDay) + 1440) % 1440;           // minutes since trigger
        if (d <= before || 1440 - d <= after) hits.push({ flow: f.name, when: tr.label });
      } else if (tr.unit === 'minute' && tr.n >= 5) {
        const since = m % tr.n;
        if (since <= Math.min(before, 5)) hits.push({ flow: f.name, every: tr.n, unit: 'minute' });
      } else if (tr.unit === 'hour' && h % tr.n === 0 && m <= before) {
        hits.push({ flow: f.name, every: tr.n, unit: 'hour' });
      }
    }
  }
  return hits;
}

// ── History ───────────────────────────────────────────────────────────────────
// Small and bounded: unplanned restarts, crashes and changes, 30 days, at most
// 60 of each kind, so many changes never push out the restarts.

function addHistory(history, items, now) {
  const count = {};
  return [...(history || []), ...items]
    .filter(e => e && now - e.t < HISTORY_DAYS * DAY)
    .sort((a, b) => b.t - a.t)
    .filter(e => (count[e.kind] = (count[e.kind] || 0) + 1) <= HISTORY_MAX)
    .reverse();
}

// Changes the user made (apps and firmware), as history entries. Kept so a
// later change in restarts can be linked to them.
const CHANGES = {
  app_added:             'app_added',
  app_removed:           'app_removed',
  app_disabled:          'app_disabled',
  app_enabled:           'app_enabled',
  app_version_changed:   'app_version',
  homey_version_changed: 'firmware',
};

function changeEntries(events, now) {
  return (events || []).filter(e => CHANGES[e.type]).map(e => {
    const c = { kind: 'change', what: CHANGES[e.type], t: Number.isFinite(e.at) ? e.at : now };
    if (e.id) Object.assign(c, { id: e.id, name: e.name });
    if (e.from != null) Object.assign(c, { from: e.from, to: e.to });
    return c;
  });
}

// Before 0.6.0 a firmware update ("reboot-ota") counted as unplanned and was
// added here. `plannedAt` holds the times of planned boots (bootDate and, when
// there was one, the minute Homey went quiet); boot entries at those times go.
function dropPlannedBoots(history, plannedAt) {
  const planned = new Set((plannedAt || []).filter(Number.isFinite));
  return (history || []).filter(e => e.kind !== 'boot' || !planned.has(e.t));
}

// ── Restarts before and after changes ─────────────────────────────────────────
// A link, never proof. Many apps update themselves, so "the last change" moves
// all the time; instead the restarts themselves set the window:
// - stopped: unexpected restarts came at a steady pace, then nothing for so
//   long that it's unlikely by chance (Poisson, P < 5 %). Every change since
//   the last restart may have helped.
// - started: ≥ 3 unexpected restarts within 7 days after ≥ 14 quiet days we
//   watched. The changes in the week before the first one may be the cause.
// Thresholds are first guesses. `since` = when Sanity Check started watching.
const LINK_MIN = 3;
const LINK_P = 0.05;
const STARTED_WITHIN = 7 * DAY;
const STARTED_QUIET = 14 * DAY;

function changeLink(history, now, since) {
  const boots = (history || []).filter(e => e.kind === 'boot').map(e => e.t).sort((a, b) => a - b);
  const changes = (history || []).filter(e => e.kind === 'change').sort((a, b) => a.t - b.t);
  if (boots.length >= LINK_MIN) {
    const first = boots[0];
    const last = boots[boots.length - 1];
    const perMs = (boots.length - 1) / (last - first);
    const quiet = now - last;
    const p = Math.exp(-perMs * quiet);
    const after = changes.filter(c => c.t > last);
    if (last > first && p < LINK_P && after.length) {
      return { kind: 'stopped', n: boots.length, from: first, last, quiet, changes: after };
    }
  }
  const recent = boots.filter(t => now - t <= STARTED_WITHIN);
  if (recent.length >= LINK_MIN) {
    const start = recent[0];
    const quietBefore = !boots.some(t => t < start && start - t <= STARTED_QUIET);
    const watched = Number.isFinite(since) && start - since >= STARTED_QUIET;
    const before = changes.filter(c => c.t <= start && start - c.t <= STARTED_WITHIN);
    if (quietBefore && watched && before.length) {
      return { kind: 'started', n: recent.length, from: start, changes: before };
    }
  }
  return null;
}

// Times of day that come back: events on at least `min` different days within
// ±tol minutes of each other. Only events with a known time count.
function recurringTimes(history, kind, local, { tol = 20, min = 2 } = {}) {
  const ev = (history || []).filter(e => e.kind === kind && e.exact !== false)
    .map(e => ({ ...e, mod: (({ h, m }) => h * 60 + m)(local(e.t)) }));
  const groups = [];
  const used = new Set();
  for (const a of ev) {
    if (used.has(a)) continue;
    const group = ev.filter(b => !used.has(b) && Math.min(Math.abs(a.mod - b.mod), 1440 - Math.abs(a.mod - b.mod)) <= tol);
    const days = new Set(group.map(e => Math.floor(e.t / DAY)));
    if (days.size >= min) {
      group.forEach(e => used.add(e));
      const mods = group.map(e => e.mod).sort((x, y) => x - y);
      groups.push({ kind, n: group.length, from: mods[0], to: mods[mods.length - 1], names: [...new Set(group.map(e => e.name).filter(Boolean))] });
    }
  }
  return groups;
}

// Apps that crashed within `within` before an unplanned restart, counted over
// all restarts in the history: "X crashed before 2 of 3 restarts".
function crashesBeforeBoots(history, within = 60 * MIN) {
  const boots = (history || []).filter(e => e.kind === 'boot');
  const crashes = (history || []).filter(e => e.kind === 'crash');
  const per = {};
  for (const b of boots) {
    const seen = new Set();
    for (const c of crashes) {
      if (c.t <= b.t && b.t - c.t <= within && !seen.has(c.id)) {
        seen.add(c.id);
        per[c.id] = per[c.id] || { id: c.id, name: c.name, boots: 0 };
        per[c.id].boots++;
      }
    }
  }
  return { total: boots.length, apps: Object.values(per).filter(a => a.boots >= 1).sort((x, y) => y.boots - x.boots) };
}

function hhmm(minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = {
  HISTORY_DAYS, HISTORY_MAX,
  crashMinutes, timeTriggers, scheduledNear, addHistory, changeEntries, dropPlannedBoots, recurringTimes,
  crashesBeforeBoots, changeLink, hhmm,
};
