'use strict';

// ── Post-mortem after a Homey restart ─────────────────────────────────────────
// Homey itself logs RAM (MB, = usage.mem / RSS) and CPU (%) per app in
// Insights, at 1-minute resolution for the last 6 hours, and keeps those
// entries across a reboot (verified 2026-10-14, FINDINGS 1.15). After an
// unplanned restart we read the minutes before bootDate and point out apps
// that behaved unusually. Pure functions: series in, findings out.
//
// When Homey stops logging, Insights repeats the last value until the new
// boot (verified 2026-10-14: 07:47–07:49 identical for the system and every
// app, boot at 07:50:50). The system memory log moves every minute, so a
// run of identical values at its end marks when Homey went quiet; app series
// are cut there so repeated values don't count as behaviour.
//
// The thresholds are a first guess (2026-10-14), not calibrated: on a quiet
// Homey apps sit at 0–2 % CPU and RAM moves by well under 2 MB per minute.

const MIN = 60 * 1000;
const WINDOW = 30 * MIN;

const LIMITS = {
  ramChange: 10,  // MB from start to end of the window
  ramStep:   10,  // MB between two consecutive minutes
  cpuAvg:    10,  // % average over the window
  cpuMax:    50,  // % in any minute
  sysStep:   30,  // MB rise of system memory in one minute (normal ≈ 4)
  together:   3,  // apps with their largest RAM step in the same minute
};

// Insights resolution that still covers `from`, or null when it is too old.
function resolutionFor(from, now) {
  const age = now - from;
  if (age < 6 * 60 * MIN) return 'last6Hours';
  if (age < 24 * 60 * MIN) return 'last24Hours';
  return null;
}

// Values strictly inside [boot − window, boot − 1 min): the minute bucket of
// the boot itself mixes the old and the new process.
function windowValues(entries, bootMs, windowMs = WINDOW, endMs = bootMs - MIN) {
  return (entries || [])
    .filter(e => e && Number.isFinite(e.v))
    .map(e => ({ t: new Date(e.t).getTime(), v: e.v }))
    .filter(e => e.t >= bootMs - windowMs && e.t < Math.min(endMs + 1, bootMs - MIN))
    .sort((a, b) => a.t - b.t);
}

// Last minute with a real system sample: the first of the identical values at
// the end (that bucket still holds the last sample). null = no repeat found.
function quietFrom(sysEntries, bootMs, windowMs = WINDOW) {
  const v = windowValues(sysEntries, bootMs, windowMs);
  let i = v.length - 1;
  while (i > 0 && v[i - 1].v === v[v.length - 1].v) i--;
  return v.length - 1 - i >= 1 ? v[i].t : null;
}

// Largest one-minute rise of system memory before Homey went quiet.
function systemJump(sysEntries, bootMs, windowMs, endMs) {
  const v = windowValues(sysEntries, bootMs, windowMs, endMs);
  let best = null;
  for (let i = 1; i < v.length; i++) {
    const d = v[i].v - v[i - 1].v;
    if (!best || d > best.mb) best = { mb: Math.round(d), at: v[i].t };
  }
  return best && best.mb >= LIMITS.sysStep ? best : null;
}

// How much the apps' RAM changed in the minute of the system jump, summed.
// What the apps don't explain was taken outside them: Homey itself or a system
// process. App RAM is RSS, so shared memory can blur this: an indication only.
function appsAt(series, at, bootMs, windowMs, endMs) {
  let sum = 0;
  let seen = 0;
  for (const s of Object.values(series || {})) {
    const mem = windowValues(s.mem, bootMs, windowMs, endMs);
    const i = mem.findIndex(e => e.t === at);
    if (i < 1) continue;
    sum += mem[i].v - mem[i - 1].v;
    seen++;
  }
  return seen ? Math.round(sum) : null;
}

// Only the entries that the window can use, so a post-mortem never holds hours
// of Insights for every app at once. One minute of margin on each side; the
// exact cut is still made by windowValues.
function trimToWindow(entries, bootDate, windowMs = WINDOW) {
  const bootMs = new Date(bootDate).getTime();
  return (entries || []).filter(e => {
    const t = e && new Date(e.t).getTime();
    return t >= bootMs - windowMs - MIN && t <= bootMs;
  });
}

function analyzeApp(memEntries, cpuEntries, bootMs, windowMs = WINDOW, endMs = bootMs - MIN) {
  const mem = windowValues(memEntries, bootMs, windowMs, endMs);
  const cpu = windowValues(cpuEntries, bootMs, windowMs, endMs);
  if (!mem.length && !cpu.length) return null;

  const out = { flags: [] };
  if (mem.length) {
    out.ramStart = mem[0].v;
    out.ramEnd   = mem[mem.length - 1].v;
    out.ramMax   = Math.max(...mem.map(e => e.v));
    out.ramChange = out.ramEnd - out.ramStart;
    out.ramStep = 0;
    for (let i = 1; i < mem.length; i++) {
      const d = mem[i].v - mem[i - 1].v;
      if (Math.abs(d) > Math.abs(out.ramStep)) { out.ramStep = d; out.ramStepAt = mem[i].t; }
    }
    if (out.ramChange >= LIMITS.ramChange) out.flags.push('ram_grew');
    else if (out.ramChange <= -LIMITS.ramChange) out.flags.push('ram_dropped');
    else if (Math.abs(out.ramStep) >= LIMITS.ramStep) out.flags.push('ram_jump');
  }
  if (cpu.length) {
    out.cpuAvg = cpu.reduce((s, e) => s + e.v, 0) / cpu.length;
    out.cpuMax = Math.max(...cpu.map(e => e.v));
    if (out.cpuAvg >= LIMITS.cpuAvg || out.cpuMax >= LIMITS.cpuMax) out.flags.push('cpu');
  }
  out.score = Math.max(Math.abs(out.ramChange || 0), Math.abs(out.ramStep || 0)) / LIMITS.ramChange
    + (out.cpuAvg || 0) / LIMITS.cpuAvg + (out.cpuMax || 0) / LIMITS.cpuMax;
  return out;
}

// series: { [appId]: { name, self?, mem: entries, cpu: entries } }, system: entries
// → { checked, quietAt, sysJump: { mb, at, apps }, together, findings: top `limit` apps }
// `self: true` marks Sanity Check's own series, so the report can say so.
function analyze(series, bootDate, { limit = 3, windowMs = WINDOW, system = null } = {}) {
  const bootMs = new Date(bootDate).getTime();
  const quietAt = quietFrom(system, bootMs, windowMs);
  const endMs = quietAt ?? bootMs - MIN;
  let checked = 0;
  const findings = [];
  for (const [id, s] of Object.entries(series || {})) {
    const r = analyzeApp(s.mem, s.cpu, bootMs, windowMs, endMs);
    if (!r) continue;
    checked++;
    if (r.flags.length) findings.push({ id, name: s.name, ...(s.self ? { self: true } : {}), ...round(r) });
  }
  findings.sort((a, b) => b.score - a.score);

  // Many apps changing in the same minute points at the system, not one app.
  const byMinute = {};
  for (const f of findings) {
    if (f.ramStepAt && Math.abs(f.ramStep) >= LIMITS.ramStep) byMinute[f.ramStepAt] = (byMinute[f.ramStepAt] || 0) + 1;
  }
  const [at, n] = Object.entries(byMinute).sort((a, b) => b[1] - a[1])[0] || [];
  const together = n >= LIMITS.together ? { at: Number(at), n } : null;

  const sysJump = systemJump(system, bootMs, windowMs, endMs);
  if (sysJump) sysJump.apps = appsAt(series, sysJump.at, bootMs, windowMs, endMs);

  return {
    checked,
    windowMin: Math.round(windowMs / MIN),
    quietAt,
    sysJump,
    together,
    findings: findings.slice(0, limit),
  };
}

function round(r) {
  const o = { ...r };
  for (const k of ['ramStart', 'ramEnd', 'ramMax', 'ramChange', 'ramStep', 'cpuAvg', 'cpuMax', 'score']) {
    if (Number.isFinite(o[k])) o[k] = Math.round(o[k] * 10) / 10;
  }
  return o;
}

module.exports = { WINDOW, LIMITS, resolutionFor, windowValues, trimToWindow, quietFrom, analyzeApp, analyze };
