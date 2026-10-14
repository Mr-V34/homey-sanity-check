'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolutionFor, windowValues, analyzeApp, analyze } = require('../lib/postmortem');
const { checkSystem, isUnplanned, systemMemory } = require('../lib/checks');
const { eventText } = require('../lib/report');

const BOOT = '2026-10-14T07:50:50.643Z';
const BOOT_MS = Date.parse(BOOT);
const MIN = 60 * 1000;

// One entry per minute from 40 min before boot to 5 min after, like Insights last6Hours.
const series = fn => Array.from({ length: 46 }, (_, i) => {
  const t = Math.floor((BOOT_MS - 40 * MIN) / MIN) * MIN + i * MIN;
  return { t: new Date(t).toISOString(), v: fn(t) };
});
const flat = v => series(() => v);

// ── Window ────────────────────────────────────────────────────────────────────

test('postmortem: resolution covers the window or gives up', () => {
  assert.equal(resolutionFor(BOOT_MS - 30 * MIN, BOOT_MS + 3 * MIN), 'last6Hours');
  assert.equal(resolutionFor(BOOT_MS - 30 * MIN, BOOT_MS + 10 * 60 * MIN), 'last24Hours');
  assert.equal(resolutionFor(BOOT_MS - 30 * MIN, BOOT_MS + 30 * 60 * MIN), null);
});

test('postmortem: window excludes the boot minute and everything after it', () => {
  const v = windowValues(flat(1), BOOT_MS);
  assert.ok(v.length >= 28 && v.length <= 30);
  assert.ok(v.every(e => e.t < BOOT_MS - MIN && e.t >= BOOT_MS - 30 * MIN));
});

// ── Analysis ──────────────────────────────────────────────────────────────────

test('postmortem: steady app → no flags', () => {
  const r = analyzeApp(flat(96), flat(1.7), BOOT_MS);
  assert.deepEqual(r.flags, []);
});

test('postmortem: YAHEMS 2026-10-14 (93 → 75 MB in the last minutes) → ram_dropped', () => {
  const mem = series(t => (t < BOOT_MS - 5 * MIN ? 93 : t < BOOT_MS - 2 * MIN ? 81.6 : 74.8));
  const r = analyzeApp(mem, flat(0), BOOT_MS);
  assert.deepEqual(r.flags, ['ram_dropped']);
  assert.ok(r.ramChange <= -10);
});

test('postmortem: steady growth → ram_grew; busy CPU → cpu', () => {
  const r = analyzeApp(series(t => 50 + (t - (BOOT_MS - 40 * MIN)) / MIN), flat(30), BOOT_MS);
  assert.deepEqual(r.flags, ['ram_grew', 'cpu']);
});

test('postmortem: up and back down → ram_jump, not a change', () => {
  const r = analyzeApp(series(t => (Math.abs(t - (BOOT_MS - 15 * MIN)) < MIN ? 120 : 90)), flat(0), BOOT_MS);
  assert.deepEqual(r.flags, ['ram_jump']);
});

test('postmortem: ranks findings, skips apps without data, counts checked apps', () => {
  const r = analyze({
    a: { name: 'Calm', mem: flat(60), cpu: flat(0) },
    b: { name: 'Busy', mem: flat(60), cpu: flat(80) },
    c: { name: 'Leak', mem: series(t => 50 + (t - (BOOT_MS - 40 * MIN)) / MIN), cpu: flat(0) },
    d: { name: 'No log', mem: null, cpu: null },
  }, BOOT);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.findings.map(f => f.name), ['Busy', 'Leak']);
});

// ── Boot record and texts ─────────────────────────────────────────────────────

test('system: boot record keeps the last check, system memory and top PSS from before', () => {
  const prev = {
    bootId: 'a', bootDate: '2026-10-13T19:06:51Z', homeyVersion: '13.5.1',
    lastCheck: { at: '2026-10-14T07:09:00Z' }, sys: { free: 4e8, swap: 2e8, core: 3e8 },
    apps: { x: { name: 'X', pss: 5e7 }, y: { name: 'Y', pss: 3e7 }, z: { name: 'Z', pss: null } },
    boots: [{ bootDate: '2026-10-11T20:24:48Z', rebootReason: 'unexpected' }],
  };
  const r = checkSystem({ bootId: 'b', bootDate: BOOT, rebootReason: 'unexpected', homeyVersion: '13.5.1' }, prev, BOOT_MS + 3 * MIN);
  const b = r.state.boots[r.state.boots.length - 1];
  assert.equal(b.before.lastCheck, '2026-10-14T07:09:00Z');
  assert.deepEqual(b.before.topPss.map(a => a.id), ['x', 'y']);
  assert.equal(b.before.sys.swap, 2e8);
  assert.equal(r.events[0].unplanned7d, 2);
});

test('system: planned reboot is not unplanned; systemMemory tolerates failed calls', () => {
  assert.equal(isUnplanned({ rebootReason: 'reboot' }), false);
  assert.equal(isUnplanned({ rebootReason: 'unexpected' }), true);
  assert.deepEqual(systemMemory(null, null), { free: null, swap: null, core: null });
  assert.deepEqual(systemMemory({ freemem: 4 }, { swap: 2, types: { homey: { size: 3 } } }), { free: 4, swap: 2, core: 3 });
});

const t = (k, tk = {}) => `${k.split('.').pop()}(${Object.entries(tk).map(([a, b]) => `${a}=${b}`).join(',')})`;
const fmt = d => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

test('report: unplanned restart shows blind window, crashes, Insights and 7-day count', () => {
  const text = eventText({
    type: 'homey_restarted', bootDate: BOOT, rebootReason: 'unexpected', prevUptimeMs: 12 * 3600e3,
    before: { lastCheck: '2026-10-14T07:09:00Z' }, suspects: [], unplanned7d: 2,
    postmortem: { checked: 33, windowMin: 30, findings: [{ id: 'y', name: 'YAHEMS', flags: ['ram_dropped'], ramStart: 93, ramEnd: 74.8, ramChange: -18.2 }] },
  }, t, fmt);
  assert.match(text, /last_check\(time=07:09:00,gap=minutes\(n=42\)\)/);
  assert.match(text, /no_suspects/);
  assert.match(text, /pm_findings\(min=30,list=YAHEMS pm_ram\(from=93,to=75,change=−18\)\)/);
  assert.match(text, /unplanned_7d\(n=2\)/);
});

test('report: planned reboot has no blind-window line; quiet Insights says so', () => {
  const text = eventText({
    type: 'homey_restarted', bootDate: BOOT, rebootReason: 'reboot', prevUptimeMs: 1,
    before: { lastCheck: '2026-10-14T07:09:00Z' }, suspects: [],
  }, t, fmt);
  assert.doesNotMatch(text, /last_check/);
  const quiet = eventText({
    type: 'homey_restarted', bootDate: BOOT, rebootReason: 'unexpected', suspects: [],
    postmortem: { checked: 33, windowMin: 30, findings: [] },
  }, t, fmt);
  assert.match(quiet, /pm_none\(n=33,min=30\)/);
});

test('postmortem: Homey goes quiet (repeated values), apps change together, system jumps', () => {
  const QUIET = Math.floor((BOOT_MS - 4 * MIN) / MIN) * MIN; // 07:47, as on 2026-10-14
  // System: climbs 4 MB/min, +48 at QUIET, then the same value repeated.
  const system = series(t => (t < QUIET ? 250 + (t - (BOOT_MS - 40 * MIN)) / MIN * 4 : 447.44));
  const app = (before, last) => ({ name: 'A', mem: series(t => (t < QUIET ? before : last)), cpu: flat(0) });
  const r = analyze({ a: app(70, 56), b: app(69, 56), c: app(93, 81), d: app(96, 96) }, BOOT, { system });
  assert.equal(r.quietAt, QUIET);
  assert.ok(r.sysJump && r.sysJump.mb >= 30 && r.sysJump.at === QUIET);
  assert.deepEqual(r.together, { at: QUIET, n: 3 });
  assert.equal(r.findings.length, 3);
});

test('postmortem: no repeat at the end → not quiet; repeats are not counted as behaviour', () => {
  const moving = series(t => (t / MIN) % 7);
  assert.equal(analyze({}, BOOT, { system: moving }).quietAt, null);
});

test('condition: unplanned restart within the window; planned and older ones do not count', () => {
  const { unplannedWithin } = require('../lib/checks');
  const boots = [
    { bootDate: '2026-10-14T07:50:50Z', rebootReason: 'unexpected' },
    { bootDate: '2026-10-14T09:00:00Z', rebootReason: 'reboot' },
  ];
  const now = Date.parse('2026-10-14T10:00:00Z');
  assert.equal(unplannedWithin(boots, 3 * 3600e3, now), true);
  assert.equal(unplannedWithin(boots, 2 * 3600e3, now), false);
  assert.equal(unplannedWithin(undefined, 3600e3, now), false);
});
