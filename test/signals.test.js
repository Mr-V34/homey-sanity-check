'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkSystem, hwFlags, optionValue, backupStatus, firmwareSettings, storageStatus, swapDue, swapApps, DAY,
} = require('../lib/checks');
const { verdict } = require('../lib/verdict');
const { eventText, dailySummary, backupLine } = require('../lib/report');

const t = (k, tk = {}) => `${k.split('.').pop()}(${Object.entries(tk).map(([a, b]) => `${a}=${b}`).join(',')})`;
const fmt = d => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
const NOW = Date.parse('2026-10-15T20:00:00Z');

// getInfo as seen on Homey 13.5.2 (2026-10-15), all flags false.
const info = (extra = {}) => ({
  bootId: 'b1', bootDate: '2026-10-15T18:20:39.026Z', rebootReason: 'reboot-ota', homeyVersion: '13.5.2',
  videoCoreUndervoltageOccured: false, videoCoreThrottleOccured: false,
  videoCoreSoftTemperatureLimitActiveOccured: false, videoCoreArmFrequencyCappedOccured: false,
  ...extra,
});

test('hw flags: read from getInfo, reported once per boot when they turn on', () => {
  assert.deepEqual(hwFlags(info()), { undervoltage: false, throttled: false, softTempLimit: false, freqCapped: false });
  const quiet = checkSystem(info(), { bootId: 'b1', hw: hwFlags(info()) }, NOW);
  assert.equal(quiet.events.length, 0);
  const on = checkSystem(info({ videoCoreUndervoltageOccured: true }), { bootId: 'b1', hw: hwFlags(info()) }, NOW);
  assert.deepEqual(on.events, [{ type: 'hw_flag', flag: 'undervoltage' }]);
  const again = checkSystem(info({ videoCoreUndervoltageOccured: true }), { bootId: 'b1', hw: on.state.hw }, NOW);
  assert.equal(again.events.length, 0);
  // After a reboot the flag counts as new again.
  const next = checkSystem(info({ bootId: 'b2', videoCoreUndervoltageOccured: true }), { bootId: 'b1', hw: on.state.hw }, NOW);
  assert.ok(next.events.some(e => e.type === 'hw_flag' && e.flag === 'undervoltage'));
  assert.deepEqual(next.events.find(e => e.type === 'homey_restarted').before.hw, on.state.hw);
  assert.match(eventText({ type: 'hw_flag', flag: 'undervoltage' }, t, fmt), /^hw_undervoltage/);
});

test('hw flags in the verdict: undervoltage → power, throttling without undervoltage → heat', () => {
  const restart = hw => ({
    type: 'homey_restarted', rebootReason: 'unexpected', suspects: [], before: { hw },
    postmortem: { checked: 30, findings: [], signals: { power: { max: 0, bad: false }, heat: { max: 57, normal: 57, bad: false }, load: { avg: 9, normal: 9, bad: false } } },
  });
  assert.equal(verdict(restart({ undervoltage: true, throttled: true })).cause, 'power');
  assert.equal(verdict(restart({ throttled: true })).cause, 'heat');
  assert.equal(verdict(restart({ softTempLimit: true })).cause, 'heat');
  assert.equal(verdict(restart({})).cause, 'homey');
  // No Insights at all, but the flag still counts.
  const noSig = { type: 'homey_restarted', rebootReason: 'unexpected', suspects: [], before: { hw: { undervoltage: true } }, postmortem: { checked: 30, findings: [] } };
  assert.equal(verdict(noSig).cause, 'power');
  const text = eventText({ ...restart({ throttled: true }), bootDate: '2026-10-15T18:20:39Z' }, t, fmt);
  assert.match(text, /⚠ v_heat_flag/);
});

test('backup: overdue when automatic backups are on and the last one is a week old', () => {
  const sep22 = 'Tue Sep 22 2026 23:46:30 GMT+0000 (Coordinated Universal Time)'; // as seen 2026-10-15
  const b = backupStatus({ value: sep22 }, { value: true }, NOW);
  assert.equal(b.days, 22);
  assert.equal(b.overdue, true);
  assert.equal(backupStatus(sep22, true, NOW).overdue, true); // bare values work too
  assert.equal(backupStatus({ value: sep22 }, { value: false }, NOW).overdue, false);
  assert.equal(backupStatus({ value: new Date(NOW - 2 * DAY).toISOString() }, { value: true }, NOW).overdue, false);
  assert.equal(backupStatus({ value: null }, { value: true }, NOW).overdue, true);
  assert.equal(backupStatus(null, null, NOW), null);
  assert.match(backupLine(b, t, fmt), /^backup_overdue\(date=2026-09-22,n=22\)/);
  assert.match(backupLine(backupStatus(null, true, NOW), t, fmt), /^backup_none/);
});

test('firmware settings, storage and option values', () => {
  assert.equal(optionValue({ value: 'stable' }), 'stable');
  assert.equal(optionValue('stable'), 'stable');
  assert.deepEqual(firmwareSettings({ value: 'stable' }, { value: true }), { channel: 'stable', auto: true });
  assert.equal(firmwareSettings(null, null), null);
  assert.deepEqual(storageStatus({ total: 2657828864, free: 1012297728 }), { free: 1012297728, total: 2657828864, low: false });
  assert.equal(storageStatus({ total: 1000, free: 50 }).low, true);
  assert.equal(storageStatus(null), null);
});

test('swap per app: only when swap is high, at most every 6 hours; top 3 by pssSwap', () => {
  assert.equal(swapDue({ swap: 2.6e6 }, null, NOW), false);
  assert.equal(swapDue({ swap: 232e6 }, null, NOW), true);
  assert.equal(swapDue({ swap: 232e6 }, { t: NOW - 3600e3 }, NOW), false);
  assert.equal(swapDue({ swap: 232e6 }, { t: NOW - 7 * 3600e3 }, NOW), true);
  const usage = {
    a: { mem: { pss: 5e7, pssSwap: 4e7 } },
    b: { usage: { mem: { pssSwap: 2e7 } } }, // wrapped answer works too
    c: { mem: { pssSwap: 0 } },
    d: null,
  };
  const r = swapApps(usage, { a: { name: 'Alpha' } }, 232e6, NOW);
  assert.deepEqual(r.top, [{ id: 'a', name: 'Alpha', swap: 4e7 }, { id: 'b', name: 'b', swap: 2e7 }]);
});

const day = extra => ({
  homeyVersion: '13.5.2', bootDate: '2026-10-15T18:20:39Z', rebootReason: 'reboot-ota',
  unplanned24h: 0, topCrashers: [], updates: [], grew: [], recurring: [],
  sys: { free: 467e6, swap: 2.6e6, core: 348e6 }, self: { pss: 20e6 },
  storage: { free: 1012297728, total: 2657828864, low: false },
  backup: { last: Date.parse('2026-10-14T23:46:30Z'), auto: true, days: 1, overdue: false },
  firmwareCfg: { channel: 'stable', auto: false },
  ...extra,
});

test('daily summary: one line when nothing stands out', () => {
  const text = dailySummary(day(), t, fmt);
  assert.equal(text.split('\n').length, 1);
  assert.match(text, /reason=reason_ota\(\)\) daily_ok\(\)$/);
});

test('daily summary: only findings, each with ⚠, then things to act on', () => {
  const text = dailySummary(day({
    unplanned24h: 2,
    grew: [{ id: 'd', name: 'Device Capabilities', pss: 53e6, change: 12e6 }],
    sys: { free: 467e6, swap: 74e6, core: 348e6 },
    swapApps: { t: NOW, swap: 74e6, top: [{ id: 'v', name: 'Virtuella enheter', swap: 4e6 }] },
    storage: { free: 50e6, total: 2657828864, low: true },
    backup: { last: Date.parse('2026-09-22T23:46:30Z'), auto: true, days: 22, overdue: true },
    self: { pss: 31e6 },
    updates: [{ name: 'Aqara', version: '1.16.3', update: '1.18.1' }],
    firmwareCfg: { channel: 'beta', auto: false },
  }), t, fmt);
  const lines = text.split('\n');
  assert.match(lines[0], /daily_attention\(\)$/);
  assert.match(lines[1], /^⚠ daily_unplanned\(n=2\)$/);
  assert.match(lines[2], /^⚠ daily_grew\(list=Device Capabilities \+12 MB \(53 MB\)\)$/);
  assert.match(lines[3], /^⚠ daily_swap\(swap=74 MB,core=348 MB\) daily_swap_apps\(list=Virtuella enheter 4 MB\)$/);
  assert.match(lines[4], /^⚠ daily_storage\(free=0\.1 GB,total=2\.7 GB\)$/);
  assert.match(lines[5], /^⚠ backup_overdue\(date=2026-09-22,n=22\)$/);
  assert.match(lines[6], /^⚠ daily_self\(pss=31 MB\)$/);
  assert.match(lines[7], /^daily_updates\(list=Aqara 1\.16\.3→1\.18\.1\)$/);
  assert.match(lines[8], /^daily_channel\(channel=beta\)$/);
  assert.equal(lines.length, 9);
});

test('daily summary: a late backup already reported is not repeated', () => {
  const backup = { last: Date.parse('2026-09-22T23:46:30Z'), auto: true, days: 22, overdue: true, repeat: true };
  assert.match(dailySummary(day({ backup }), t, fmt), /daily_ok\(\)$/);
});

test('daily summary, detailed: same head and findings, then everything measured', () => {
  const s = day({
    restarts24h: 1,
    largest: [{ id: 'd', name: 'Device Capabilities', pss: 53e6, change: 6e6 }, { id: 'r', name: 'Roborock Cloud', pss: 50e6, change: -8e6 }],
    swapApps: { t: NOW, swap: 74e6, top: [{ id: 'v', name: 'Virtuella enheter', swap: 4e6 }] },
  });
  assert.equal(dailySummary(s, t, fmt, 'short').split('\n').length, 1);
  const lines = dailySummary(s, t, fmt, 'full').split('\n');
  assert.match(lines[0], /daily_ok\(\)$/);
  assert.deepEqual(lines.slice(1).map(l => l.split('(')[0]), [
    'v_details', 'daily_restarts', 'daily_no_crashes', 'daily_largest', 'daily_system',
    'swap_apps', 'daily_storage', 'backup_ok', 'daily_firmware', 'daily_self',
  ]);
  assert.match(lines[2], /n=1,unplanned=0/);
  assert.match(lines[4], /Device Capabilities 53 MB \(\+6 MB\), Roborock Cloud 50 MB \(−8 MB\)/);
  assert.match(lines[9], /channel=stable,auto=off\(\)/);
});
