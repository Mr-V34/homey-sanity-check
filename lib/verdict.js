'use strict';

// ── Advisory verdict after an unplanned restart ───────────────────────────────
// Goes through the causes we can see from outside, in a fixed order, and says
// which one the data points at: an app, power, heat, overload, or — when none
// of them shows — Homey itself. It is advice, not proof: every check reports
// what was measured, and the verdict only names the first check that failed.
//
// Inputs are plain data. Homey logs these system values in Insights at
// 1-minute resolution for 6 hours, kept across a reboot (checked 2026-10-14):
//   homey:manager:system:undervoltageratio  (0 = no undervoltage)
//   homey:manager:system:temperature        (CPU, °C)
//   homey:manager:system:loadavg            (%, per the log's own units; still
//                                             only compared with this Homey's
//                                             own baseline)
// The thresholds are a first guess (2026-10-14), not calibrated.

const MIN = 60 * 1000;
const WINDOW = 30 * MIN;  // the minutes before the restart that we judge
const BASE = 3 * 60 * MIN; // history before the window, for "normal" on this Homey

const LIMITS = {
  heatMax:    75,  // °C in any minute of the window
  heatAbove:  10,  // °C above this Homey's normal
  loadFactor:  2,  // window average at least this many times the normal average
  swapMb:     64,  // MB swap at the last check before the restart
};

function values(entries, from, to) {
  return (entries || [])
    .filter(e => e && Number.isFinite(e.v))
    .map(e => ({ t: new Date(e.t).getTime(), v: e.v }))
    .filter(e => e.t >= from && e.t < to)
    .map(e => e.v);
}

const avg = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
const max = list => (list.length ? Math.max(...list) : null);
const round = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// One system series → { win: values in the window, base: values before it }.
// `endMs` is when Homey went quiet (or one minute before boot): later values
// are Insights repeating the last sample.
function split(entries, bootMs, endMs) {
  const start = bootMs - WINDOW;
  return {
    win:  values(entries, start, Math.min(endMs + 1, bootMs - MIN)),
    base: values(entries, start - BASE, start),
  };
}

// signals: { undervoltage, temperature, loadavg } as Insights entries.
// → { power, heat, load } with what was measured and whether it is a problem.
function analyzeSignals(signals, bootDate, endMs) {
  const bootMs = new Date(bootDate).getTime();
  const end = Number.isFinite(endMs) ? endMs : bootMs - MIN;
  const out = {};

  const uv = split(signals && signals.undervoltage, bootMs, end);
  if (uv.win.length) out.power = { max: round(max(uv.win)), bad: max(uv.win) > 0 };

  const temp = split(signals && signals.temperature, bootMs, end);
  if (temp.win.length) {
    const normal = avg(temp.base);
    const m = max(temp.win);
    out.heat = {
      max: round(m), normal: round(normal),
      bad: m >= LIMITS.heatMax || (normal != null && m - normal >= LIMITS.heatAbove),
    };
  }

  const load = split(signals && signals.loadavg, bootMs, end);
  if (load.win.length) {
    const normal = avg(load.base);
    const a = avg(load.win);
    out.load = {
      avg: round(a), normal: round(normal),
      bad: normal != null && normal > 0 && a >= LIMITS.loadFactor * normal,
    };
  }
  return out;
}

function withFlag(check, flag) {
  return flag ? { ...check, known: true, bad: true, flag: true } : check;
}

// The verdict. `e` is a homey_restarted event with suspects (crashes in the
// 24 h before the boot), postmortem (app findings, sysJump, signals) and
// before (last hourly snapshot). Sanity Check's own finding never counts as a
// cause: the code runs nothing between checks.
function verdict(e) {
  const pm = e.postmortem || {};
  const sig = pm.signals || {};
  const crashed = (e.suspects || []).filter(s => s.crashes > 0);
  const grew = (pm.findings || []).filter(f => !f.self && (f.flags.includes('ram_grew') || f.flags.includes('cpu')));
  const swap = e.before && e.before.sys && Number.isFinite(e.before.sys.swap) ? e.before.sys.swap : null;
  // Firmware flags at the last check before the restart (see hwFlags): they
  // count even when Insights has no undervoltage or temperature data.
  const hw = (e.before && e.before.hw) || {};
  const hwHeat = hw.softTempLimit || ((hw.throttled || hw.freqCapped) && !hw.undervoltage);
  const coreJump = pm.sysJump && Number.isFinite(pm.sysJump.apps) && pm.sysJump.apps <= 0 ? pm.sysJump : null;

  const checks = [
    { key: 'crashes', bad: crashed.length > 0, n: crashed.reduce((s, c) => s + c.crashes, 0), app: crashed[0] && (crashed[0].name || crashed[0].id) },
    { key: 'apps',    bad: grew.length > 0, app: grew[0] && (grew[0].name || grew[0].id), known: !pm.unavailable && pm.checked > 0 },
    withFlag({ key: 'power', ...(sig.power || {}), known: !!sig.power }, hw.undervoltage),
    withFlag({ key: 'heat', ...(sig.heat || {}), known: !!sig.heat }, hwHeat),
    { key: 'load',    ...(sig.load || {}), known: !!sig.load },
  ];
  // Facts about Homey itself. They don't decide the verdict, they support it.
  const core = { jump: coreJump, swapMb: swap != null ? Math.round(swap / 1e6) : null };
  core.bad = !!coreJump || (core.swapMb != null && core.swapMb >= LIMITS.swapMb);

  let cause = null;
  if (checks[0].bad || checks[1].bad) cause = 'app';
  else if (checks[2].bad) cause = 'power';
  else if (checks[3].bad) cause = 'heat';
  else if (checks[4].bad) cause = 'load';
  else if (checks.slice(1).every(c => c.known)) cause = 'homey';
  else cause = 'unknown';

  return { cause, app: checks[0].app || checks[1].app || null, checks, core };
}

module.exports = { WINDOW, BASE, LIMITS, analyzeSignals, verdict };
