'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOUR, checkSystem, checkFirmware, checkApps, checkSensors, suspects,
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

// ── Sensors ───────────────────────────────────────────────────────────────────

test('sensors: silent once, then back; virtual (no lastSeenAt) and unmonitored skipped', () => {
  const th = { sensor: 24, light: 0 };
  const devs = [
    { id: '1', name: 'Dörr', class: 'sensor', zone: 'z', lastSeenAt: new Date(T0 - 30 * HOUR).toISOString() },
    { id: '2', name: 'Knapp', class: 'sensor', lastSeenAt: null },
    { id: '3', name: 'Lampa', class: 'light', lastSeenAt: new Date(T0 - 99 * HOUR).toISOString() },
  ];
  const r1 = checkSensors(devs, {}, th, T0);
  assert.deepEqual(r1.events.map(e => [e.type, e.id]), [['sensor_silent', '1']]);
  const r2 = checkSensors(devs, r1.state, th, T0 + HOUR);
  assert.equal(r2.events.length, 0);
  devs[0].lastSeenAt = new Date(T0).toISOString();
  const r3 = checkSensors(devs, r2.state, th, T0 + 2 * HOUR);
  assert.deepEqual(r3.events.map(e => e.type), ['sensor_back']);
});

test('sensors: no lastSeenAt → falls back to newest capability lastUpdated (Aqara case)', () => {
  const devs = [{
    id: 'aq', name: 'Temperatur', class: 'sensor', lastSeenAt: null,
    capabilitiesObj: {
      measure_temperature: { lastUpdated: new Date(T0 - 661 * HOUR).toISOString() },
      measure_battery:     { lastUpdated: new Date(T0 - 700 * HOUR).toISOString() },
      alarm_x:             { lastUpdated: null },
    },
  }];
  const r = checkSensors(devs, {}, { sensor: 24 }, T0);
  assert.equal(r.events[0].type, 'sensor_silent');
  assert.equal(r.events[0].ageMs, 661 * HOUR);
});

test('sensors: right after a reboot, lastSeenAt is gone → no false alarm (real case: "Tak 3")', () => {
  const boot = new Date(T0 - 5 * 60000).toISOString(); // Homey up 5 min
  const lamp = {
    id: 'tak3', name: 'Tak 3', class: 'light', lastSeenAt: null,
    capabilitiesObj: { onoff: { lastUpdated: new Date(T0 - 27 * HOUR).toISOString() } },
  };
  const r = checkSensors([lamp], {}, { light: 12 }, T0, boot);
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.state.silent, []);
});

test('sensors: after a reboot an already-silent Aqara stays silent without a new report', () => {
  const boot = new Date(T0 - 5 * 60000).toISOString();
  const aqara = {
    id: 'aq', name: 'Temperatur', class: 'sensor', lastSeenAt: null,
    capabilitiesObj: { measure_temperature: { lastUpdated: new Date(T0 - 661 * HOUR).toISOString() } },
  };
  const r = checkSensors([aqara], { silent: ['aq'] }, { sensor: 24 }, T0, boot);
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.state.silent, ['aq']);
});

test('sensors: once uptime passes the threshold, a device without lastSeenAt is judged again', () => {
  const boot = new Date(T0 - 25 * HOUR).toISOString();
  const aqara = {
    id: 'aq', name: 'Temperatur', class: 'sensor', lastSeenAt: null,
    capabilitiesObj: { measure_temperature: { lastUpdated: new Date(T0 - 661 * HOUR).toISOString() } },
  };
  const r = checkSensors([aqara], {}, { sensor: 24 }, T0, boot);
  assert.deepEqual(r.events.map(e => e.type), ['sensor_silent']);
});

test('sensors: lamp with fresh lastSeenAt after a reboot is fine immediately', () => {
  const boot = new Date(T0 - 5 * 60000).toISOString();
  const lamp = { id: 'tak3', name: 'Tak 3', class: 'light', lastSeenAt: new Date(T0 - 60000).toISOString() };
  const r = checkSensors([lamp], {}, { light: 12 }, T0, boot);
  assert.equal(r.events.length, 0);
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
  assert.match(text, /Tuya v0\.3\.4 \(34×, 0\.3\.5/);
});

test('report: durations', () => {
  const t = (k, tk) => `${k}:${tk ? tk.n : ''}`;
  assert.equal(duration(30 * 60000, t), 'report.minutes:30');
  assert.equal(duration(5 * HOUR, t), 'report.hours:5');
  assert.equal(duration(72 * HOUR, t), 'report.days:3');
  assert.equal(duration(null, t), 'report.unknown:');
});

test('report: daily summary lists silent devices with zone and age, capped at 10', () => {
  const { dailySummary } = require('../lib/report');
  const t = (k, tk = {}) => `${k}${JSON.stringify(tk)}`;
  const base = { homeyVersion: '13.5.1', bootDate: 'x', rebootReason: 'reboot', restarts24h: 0, topCrashers: [], updates: [], firmware: null };
  const one = dailySummary({ ...base, silent: [{ name: 'Vattenläckagedetektor', zoneName: 'Badrum', ageMs: 121 * 24 * HOUR }] }, t, () => 'x');
  assert.match(one, /report\.daily_silent_list\{"n":1,"list":"Vattenläckagedetektor \(Badrum, report\.days/);
  const many = dailySummary({ ...base, silent: Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, ageMs: HOUR })) }, t, () => 'x');
  assert.match(many, /report\.and_more\{"n":2\}/);
  const none = dailySummary({ ...base, silent: [] }, t, () => 'x');
  assert.match(none, /report\.daily_silent\{"n":0\}/);
});

// ── Memory (RSS/PSS) ──────────────────────────────────────────────────────────

const { memoryReport, pssSnapshot, pssFromMemoryInfo, MB } = require('../lib/checks');

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

test('memory: report lists apps over 30 MB PSS with change since snapshot', () => {
  const apps = {
    big: { name: 'Big', pss: 52 * MB }, mid: { name: 'Mid', pss: 31 * MB },
    ok: { name: 'Ok', pss: 20 * MB }, none: { name: 'None', pss: null },
  };
  const m = memoryReport(apps, { big: 44 * MB });
  assert.equal(m.count, 2);
  assert.deepEqual(m.top.map(x => [x.id, x.change]), [['big', 8 * MB], ['mid', null]]);
  assert.deepEqual(pssSnapshot(apps), { big: 52 * MB, mid: 31 * MB, ok: 20 * MB });
});

test('report: crash text adds memory and the "stopped by Homey" hint', () => {
  const t = (k, tk = {}) => `${k}${JSON.stringify(tk)}`;
  const text = eventText({ type: 'app_crashed', name: 'X', version: '1', delta: 3, last24h: 3, pss: 120e6, noMessage: true }, t, () => '');
  assert.match(text, /report\.memory_before\{"pss":"120 MB"\}/);
  assert.match(text, /report\.killed_hint/);
});
