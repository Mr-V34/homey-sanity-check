'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOUR, checkSystem, checkFirmware, checkApps, suspects,
} = require('../lib/checks');
const { eventText, duration } = require('../lib/report');

const T0 = Date.parse('2026-10-13T12:00:00Z');
const app = (over = {}) => ({
  id: 'com.x', name: 'X', version: '1.0.0', state: 'running', enabled: true,
  crashedCount: 0, crashedMessage: null, updateAvailable: null, ...over,
});

// ── System ────────────────────────────────────────────────────────────────────

test('system: first run is a baseline, no restart event', () => {
  const r = checkSystem({ bootId: 'a', bootDate: '2026-10-11T20:24:48Z', homeyVersion: '13.5.1' }, {}, T0);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.bootId, 'a');
});

test('system: new bootId → restart with reason and previous uptime', () => {
  const prev = { bootId: 'a', bootDate: '2026-10-11T20:00:00Z', homeyVersion: '13.5.1' };
  const r = checkSystem({ bootId: 'b', bootDate: '2026-10-13T08:00:00Z', rebootReason: 'unexpected', homeyVersion: '13.5.1' }, prev, T0);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'homey_restarted');
  assert.equal(r.events[0].rebootReason, 'unexpected');
  assert.equal(r.events[0].prevUptimeMs, 36 * HOUR);
  assert.equal(r.state.boots.length, 1);
});

test('system: version change is reported', () => {
  const r = checkSystem({ bootId: 'a', bootDate: 'x', homeyVersion: '13.6.0' }, { bootId: 'a', homeyVersion: '13.5.1' }, T0);
  assert.deepEqual(r.events.map(e => e.type), ['homey_version_changed']);
});

test('system: boot history is capped at 10', () => {
  const prev = { bootId: 'a', boots: Array.from({ length: 10 }, (_, i) => ({ bootDate: String(i) })) };
  const r = checkSystem({ bootId: 'b', bootDate: '2026-10-13T08:00:00Z' }, prev, T0);
  assert.equal(r.state.boots.length, 10);
});

// ── Firmware ──────────────────────────────────────────────────────────────────

test('firmware: empty list (verified real response) → nothing', () => {
  const r = checkFirmware([], {});
  assert.equal(r.events.length, 0);
  assert.equal(r.state.firmwareAvailable, null);
});

test('firmware: reported once per new version', () => {
  const r1 = checkFirmware([{ version: '13.6.0' }], {});
  assert.equal(r1.events.length, 1);
  const r2 = checkFirmware([{ version: '13.6.0' }], r1.state);
  assert.equal(r2.events.length, 0);
});

// ── Apps ──────────────────────────────────────────────────────────────────────

test('apps: uninstalled, installed and re-enabled apps are changes; first run and self are not', () => {
  const s1 = checkApps([app(), app({ id: 'com.y', name: 'Y', enabled: false }), app({ id: 'me' })], {}, T0, 'me').state;
  assert.equal(checkApps([app()], {}, T0).events.length, 0);
  const r = checkApps([app({ id: 'com.y', name: 'Y', enabled: true }), app({ id: 'com.z', name: 'Z' })], s1, T0 + HOUR, 'me');
  assert.deepEqual(r.events.map(e => [e.type, e.id]).sort(),
    [['app_added', 'com.z'], ['app_enabled', 'com.y'], ['app_removed', 'com.x']]);
  assert.equal(r.events.find(e => e.type === 'app_removed').name, 'X');
});

test('apps: first sighting is a baseline even with old crashes', () => {
  const r = checkApps([app({ crashedCount: 7 })], {}, T0);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.apps['com.x'].count, 7);
});

test('apps: counter increase → app_crashed with 24 h total', () => {
  const s1 = checkApps([app({ crashedCount: 2 })], {}, T0).state;
  const r2 = checkApps([app({ crashedCount: 5 })], s1, T0 + HOUR);
  assert.equal(r2.events[0].type, 'app_crashed');
  assert.equal(r2.events[0].delta, 3);
  assert.equal(r2.events[0].last24h, 3);
  const r3 = checkApps([app({ crashedCount: 9 })], r2.state, T0 + 2 * HOUR);
  assert.equal(r3.events[0].last24h, 7);
});

test('apps: decreasing counter = reset (e.g. reboot), counts the new value', () => {
  const s1 = checkApps([app({ crashedCount: 5 })], {}, T0).state;
  const r = checkApps([app({ crashedCount: 2 })], s1, T0 + HOUR);
  assert.equal(r.events[0].delta, 2);
});

test('apps: crashes older than 24 h drop out', () => {
  const s1 = checkApps([app({ crashedCount: 0 })], {}, T0).state;
  const s2 = checkApps([app({ crashedCount: 4 })], s1, T0 + HOUR).state;
  const r = checkApps([app({ crashedCount: 5 })], s2, T0 + 26 * HOUR);
  assert.equal(r.events[0].last24h, 1);
});

test('apps: new version = new app, statistics start over', () => {
  const s1 = checkApps([app({ crashedCount: 0 })], {}, T0).state;
  const s2 = checkApps([app({ crashedCount: 30 })], s1, T0 + HOUR).state;
  const r = checkApps([app({ version: '1.1.0', crashedCount: 0 })], s2, T0 + 2 * HOUR);
  assert.deepEqual(r.events.map(e => e.type), ['app_version_changed']);
  assert.deepEqual(r.state.apps['com.x'].crashes, []);
});

test('apps: disabled and not running are reported once', () => {
  const s1 = checkApps([app()], {}, T0).state;
  const r = checkApps([app({ enabled: false, state: 'stopped' })], s1, T0 + HOUR);
  assert.deepEqual(r.events.map(e => e.type), ['app_disabled']);
  const s2 = checkApps([app()], {}, T0).state;
  const r2 = checkApps([app({ state: 'crashed' })], s2, T0 + HOUR);
  assert.deepEqual(r2.events.map(e => e.type), ['app_not_running']);
  const r3 = checkApps([app({ state: 'crashed' })], r2.state, T0 + 2 * HOUR);
  assert.equal(r3.events.length, 0);
});

test('apps: update available (verified shape {version}) reported once', () => {
  const s1 = checkApps([app()], {}, T0).state;
  const r = checkApps([app({ updateAvailable: { version: '1.2.0', permissions: [] } })], s1, T0 + HOUR);
  assert.equal(r.events[0].type, 'app_update_available');
  assert.equal(r.events[0].update, '1.2.0');
  const r2 = checkApps([app({ updateAvailable: { version: '1.2.0' } })], r.state, T0 + 2 * HOUR);
  assert.equal(r2.events.length, 0);
});

test('apps: own app is ignored', () => {
  const r = checkApps([app({ id: 'me' })], {}, T0, 'me');
  assert.deepEqual(r.state.apps, {});
});

// ── Suspects (the indication) ─────────────────────────────────────────────────

test('suspects: ranks apps by crashes in the 24 h before the boot', () => {
  const state = {
    'a': { name: 'A', version: '1', crashes: [{ t: T0 - HOUR, n: 34 }] },
    'b': { name: 'B', version: '2', crashes: [{ t: T0 - 2 * HOUR, n: 3 }] },
    'c': { name: 'C', version: '3', crashes: [{ t: T0 - 30 * HOUR, n: 99 }] }, // too old
    'd': { name: 'D', version: '4', crashes: [{ t: T0 + HOUR, n: 50 }] },      // after boot
  };
  const s = suspects(state, new Date(T0).toISOString());
  assert.deepEqual(s.map(x => [x.id, x.crashes]), [['a', 34], ['b', 3]]);
});

// ── Report wording ────────────────────────────────────────────────────────────

test('report: restart text names the suspect as a possibility, with update', () => {
  const t = (k, tk = {}) => `${k}${JSON.stringify(tk)}`;
  const text = eventText({
    type: 'homey_restarted', bootDate: 'x', rebootReason: 'unexpected', prevUptimeMs: 46 * HOUR,
    suspects: [{ name: 'Tuya', version: '0.3.4', crashes: 34, update: '0.3.5' }],
  }, t, () => '22:24:48');
  assert.match(text, /report\.homey_restarted/);
  assert.match(text, /report\.suspects/);
  assert.match(text, /report\.crash_item.*Tuya v0\.3\.4.*34.*report\.crash_update.*0\.3\.5/);
});

test('report: durations', () => {
  const t = (k, tk) => `${k}:${tk ? tk.n : ''}`;
  assert.equal(duration(30 * 60000, t), 'report.minutes:30');
  assert.equal(duration(5 * HOUR, t), 'report.hours:5');
  assert.equal(duration(72 * HOUR, t), 'report.days:3');
  assert.equal(duration(null, t), 'report.unknown:');
});

// ── Memory (RSS/PSS) ──────────────────────────────────────────────────────────

const { updateFloors, risingFloors, pssSnapshot, pssFromMemoryInfo, MB } = require('../lib/checks');

test('memory: PSS parsed from real getMemoryInfo shape', () => {
  const info = { total: 1, types: {
    homey: { name: 'Homey', size: 380e6 },
    'homey:app:com.netatmo': { name: 'Netatmo', size: 52e6 },
    video: { name: 'Video', size: 19e6 },
  } };
  assert.deepEqual(pssFromMemoryInfo(info), { 'com.netatmo': 52e6 });
  assert.deepEqual(pssFromMemoryInfo(null), {});
});

test('memory: RSS and PSS stored per app', () => {
  const r = checkApps([app({ usage: { mem: 89e6 } })], {}, T0, null, { 'com.x': 35e6 });
  assert.equal(r.state.apps['com.x'].rss, 89e6);
  assert.equal(r.state.apps['com.x'].pss, 35e6);
  const r2 = checkApps([app({ usage: { mem: 0 } })], {}, T0, null, {});
  assert.equal(r2.state.apps['com.x'].rss, null);
  assert.equal(r2.state.apps['com.x'].pss, null);
});

test('memory: crash records PSS from the check before and whether a message exists', () => {
  const s1 = checkApps([app()], {}, T0, null, { 'com.x': 120e6 }).state;
  const r = checkApps([app({ crashedCount: 3, crashedMessage: null })], s1, T0 + HOUR, null, { 'com.x': 20e6 });
  assert.equal(r.events[0].pss, 120e6);
  assert.equal(r.events[0].noMessage, true);
  const r2 = checkApps([app({ crashedCount: 3, crashedMessage: 'Error: x\n at y' })], s1, T0 + HOUR, null, {});
  assert.equal(r2.events[0].noMessage, false);
});

test('memory: suspects carry max PSS and "no message" only when every crash lacked one', () => {
  const state = {
    a: { name: 'A', version: '1', crashes: [{ t: T0 - HOUR, n: 3, pss: 90e6, noMessage: true }, { t: T0 - 2 * HOUR, n: 1, pss: 140e6, noMessage: true }] },
    b: { name: 'B', version: '1', crashes: [{ t: T0 - HOUR, n: 1, pss: null, noMessage: true }, { t: T0 - 2 * HOUR, n: 1, noMessage: false }] },
  };
  const s = suspects(state, T0);
  assert.deepEqual(s.map(x => [x.id, x.pss, x.noMessage]), [['a', 140e6, true], ['b', null, false]]);
});

test('memory floor: lowest PSS per day; a new version starts over; removed apps drop out', () => {
  let f = updateFloors({}, { a: { version: '1', pss: 40 * MB } }, 'd1');
  f = updateFloors(f, { a: { version: '1', pss: 55 * MB } }, 'd1');   // sawtooth peak: floor stays
  f = updateFloors(f, { a: { version: '1', pss: 38 * MB } }, 'd1');
  f = updateFloors(f, { a: { version: '1', pss: 50 * MB } }, 'd2');
  assert.deepEqual(f.a, { v: '1', d: [['d1', 38 * MB], ['d2', 50 * MB]] });
  assert.deepEqual(updateFloors(f, { a: { version: '2', pss: 30 * MB } }, 'd2').a.d, [['d2', 30 * MB]]);
  assert.deepEqual(updateFloors(f, {}, 'd3'), {});
  const many = Array.from({ length: 12 }, (_, i) => `d${i}`).reduce((acc, d) => updateFloors(acc, { a: { version: '1', pss: 1 } }, d), {});
  assert.equal(many.a.d.length, 8); // 7 whole days + today
});

test('memory floor: rising 3 whole days in a row by ≥ 10 MB is a finding; sawtooth and today are not', () => {
  const apps = { leak: { name: 'Leak' }, saw: { name: 'Saw' }, slow: { name: 'Slow' } };
  const floors = {
    leak: { v: '1', d: [['d1', 30 * MB], ['d2', 33 * MB], ['d3', 37 * MB], ['d4', 42 * MB], ['d5', 20 * MB]] },
    saw:  { v: '1', d: [['d1', 30 * MB], ['d2', 45 * MB], ['d3', 31 * MB], ['d4', 46 * MB]] },
    slow: { v: '1', d: [['d1', 30 * MB], ['d2', 31 * MB], ['d3', 32 * MB], ['d4', 33 * MB]] },
  };
  assert.deepEqual(risingFloors(floors, apps, 'd5'), [{ id: 'leak', name: 'Leak', days: 3, change: 12 * MB, pss: 42 * MB }]);
  // Seen on day 6, the restart on day 5 (floor 20 MB) has broken the rise.
  assert.deepEqual(risingFloors(floors, apps, 'd6'), []);
});

test('report: crash text adds memory and the "stopped by Homey" hint', () => {
  const t = (k, tk = {}) => `${k}${JSON.stringify(tk)}`;
  const text = eventText({ type: 'app_crashed', name: 'X', version: '1', delta: 3, last24h: 3, pss: 120e6, noMessage: true }, t, () => '');
  assert.match(text, /report\.memory_before\{"pss":"120 MB"\}/);
  assert.match(text, /report\.killed_hint/);
});

test('apps: autoupdate is kept as true/false, anything else as unknown', () => {
  const apps = [
    { id: 'on', name: 'On', version: '1', autoupdate: true },
    { id: 'off', name: 'Off', version: '1', autoupdate: false },
    { id: 'old', name: 'Old', version: '1' },
  ];
  const { state } = checkApps(apps, {}, T0);
  assert.deepEqual([state.apps.on.auto, state.apps.off.auto, state.apps.old.auto], [true, false, null]);
});
