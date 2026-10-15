'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSignals, verdict } = require('../lib/verdict');
const { eventText } = require('../lib/report');

const BOOT = '2026-10-14T13:00:26.340Z';
const BOOT_MS = Date.parse(BOOT);
const MIN = 60 * 1000;
const QUIET = Date.parse('2026-10-14T12:56:00Z');

// One entry per minute from 4 h before boot, like Insights last6Hours.
const series = fn => Array.from({ length: 240 }, (_, i) => {
  const t = Math.floor((BOOT_MS - 240 * MIN) / MIN) * MIN + i * MIN;
  return { t: new Date(t).toISOString(), v: fn(t) };
});

const t = (k, tk = {}) => `${k.split('.').pop()}(${Object.entries(tk).map(([a, b]) => `${a}=${b}`).join(',')})`;
const fmt = d => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

// 2026-10-14 15:00 as measured: no undervoltage, 56–57 °C, load 7–15 with
// spikes up to 46 earlier, core +73 MB at 14:56 while the apps fell, swap 93 MB.
const calm = { undervoltage: series(() => 0), temperature: series(() => 56.5), loadavg: series(t2 => (t2 % (20 * MIN) === 0 ? 40 : 9)) };
const restart = (pm, extra = {}) => ({
  type: 'homey_restarted', bootDate: BOOT, rebootReason: 'unexpected', suspects: [],
  before: { lastCheck: '2026-10-14T12:47:00.509Z', sys: { swap: 93241344 } },
  postmortem: { checked: 32, windowMin: 30, findings: [], quietAt: QUIET, sysJump: { mb: 73, at: QUIET, apps: -34 }, ...pm },
  ...extra,
});

test('signals: calm Homey → power, heat and load all fine', () => {
  const s = analyzeSignals(calm, BOOT, QUIET);
  assert.equal(s.power.bad, false);
  assert.equal(s.heat.bad, false);
  assert.equal(s.load.bad, false);
  assert.equal(s.heat.max, 56.5);
});

test('verdict: 2026-10-14 15:00 → Homey itself, with core jump and swap as support', () => {
  const v = verdict(restart({ signals: analyzeSignals(calm, BOOT, QUIET) }));
  assert.equal(v.cause, 'homey');
  assert.equal(v.core.bad, true);
  assert.equal(v.core.swapMb, 93);
});

test('verdict: crashes before the boot → app, named', () => {
  const v = verdict(restart({ signals: analyzeSignals(calm, BOOT, QUIET) }, {
    suspects: [{ id: 'x', name: 'Leaky', crashes: 5 }],
  }));
  assert.equal(v.cause, 'app');
  assert.equal(v.app, 'Leaky');
});

test('verdict: an app that grew counts, Sanity Check itself never does', () => {
  const grew = { id: 'g', name: 'Grower', flags: ['ram_grew'] };
  const self = { id: 's', name: 'Sanity Check', self: true, flags: ['ram_grew'] };
  const sig = analyzeSignals(calm, BOOT, QUIET);
  assert.equal(verdict(restart({ signals: sig, findings: [self] })).cause, 'homey');
  assert.equal(verdict(restart({ signals: sig, findings: [self, grew] })).app, 'Grower');
  assert.equal(verdict(restart({ signals: sig, findings: [{ id: 'd', name: 'Dropper', flags: ['ram_dropped'] }] })).cause, 'homey');
});

test('verdict: undervoltage → power, before heat and load', () => {
  const s = analyzeSignals({ ...calm, undervoltage: series(t2 => (t2 > BOOT_MS - 10 * MIN ? 0.2 : 0)), temperature: series(() => 80) }, BOOT, QUIET);
  assert.equal(verdict(restart({ signals: s })).cause, 'power');
});

test('verdict: hot or 10 °C above normal → heat', () => {
  const hot = analyzeSignals({ ...calm, temperature: series(() => 76) }, BOOT, QUIET);
  assert.equal(verdict(restart({ signals: hot })).cause, 'heat');
  const rising = analyzeSignals({ ...calm, temperature: series(t2 => (t2 > BOOT_MS - 20 * MIN ? 68 : 55)) }, BOOT, QUIET);
  assert.equal(verdict(restart({ signals: rising })).cause, 'heat');
});

test('verdict: load twice the normal of this Homey → overload', () => {
  const s = analyzeSignals({ ...calm, loadavg: series(t2 => (t2 > BOOT_MS - 31 * MIN ? 30 : 9)) }, BOOT, QUIET);
  assert.equal(s.load.bad, true);
  assert.equal(verdict(restart({ signals: s })).cause, 'load');
});

test('verdict: missing data → unknown, never a guess at Homey', () => {
  assert.equal(verdict(restart({ signals: {} })).cause, 'unknown');
  assert.equal(verdict(restart({ unavailable: true, checked: 0, signals: analyzeSignals(calm, BOOT, QUIET) })).cause, 'unknown');
});

test('report: verdict block comes first, one line per check, then details', () => {
  const text = eventText(restart({ signals: analyzeSignals(calm, BOOT, QUIET) }), t, fmt);
  const lines = text.split('\n');
  assert.match(lines[1], /^v_cause_homey/);
  assert.match(lines[2], /^✓ v_crashes_ok/);
  assert.match(lines[3], /^✓ v_apps_ok/);
  assert.match(lines[4], /^✓ v_power_ok/);
  assert.match(lines[5], /^✓ v_heat\(max=57,normal=57\)/);
  assert.match(lines[6], /^✓ v_load/);
  assert.match(lines[7], /^⚠ v_core\(list=v_core_jump\(mb=73,time=12:56:00\), v_core_swap\(mb=93\)\)/);
  assert.match(lines[8], /^v_advice_homey/);
  assert.match(lines[9], /^v_details/);
});

test('report: a planned reboot gets no verdict', () => {
  const text = eventText(restart({ signals: analyzeSignals(calm, BOOT, QUIET) }, { rebootReason: 'reboot' }), t, fmt);
  assert.doesNotMatch(text, /v_cause/);
});

test('report: a firmware update (reboot-ota) gets no verdict and a readable reason', () => {
  const text = eventText(restart({ signals: analyzeSignals(calm, BOOT, QUIET) }, { rebootReason: 'reboot-ota' }), t, fmt);
  assert.match(text, /reason=reason_ota\(\)/);
  assert.doesNotMatch(text, /v_cause|v_advice|last_check/);
});

test('report: support advice only for "unexpected"; an unknown reason gets the cautious advice', () => {
  const sig = { signals: analyzeSignals(calm, BOOT, QUIET) };
  assert.match(eventText(restart(sig), t, fmt), /v_advice_homey\(/);
  const text = eventText(restart(sig, { rebootReason: 'something-new' }), t, fmt);
  assert.match(text, /v_cause_homey/); // still analysed
  assert.match(text, /v_advice_homey_reason\(app=,reason=something-new\)/);
  assert.match(text, /reason=something-new,/); // unknown value shown as it is
});
