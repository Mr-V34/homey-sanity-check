'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zigbeeCounts, chattyDevices } = require('../lib/radio');
const { dailySummary } = require('../lib/report');

const t = (k, tk = {}) => `${k.split('.').pop()}(${Object.entries(tk).map(([a, b]) => `${a}=${b}`).join(',')})`;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-17T06:00:00Z');

// Shape of a node in ManagerZigbee.getState (bridge, 2026-10-17), with made-up addresses.
const node = (nwkAddr, name, tx, rx, model = 'TS011F', manufacturerName = '_TZ3000_w0qqde0g') => ({
  networkAddress: nwkAddr, nwkAddr, ieeeAddr: '00:00:00:00:00:00:00:01', modelId: model, manufacturerName,
  type: 'router', name, stats: { tx, txSuccess: tx, txError: 0, rx },
});
const state = nodes => ({
  controllerState: { networkKey: 'secret', panId: 1 },
  nodes: Object.fromEntries([...nodes, { type: 'coordinator', nwkAddr: 0, name: 'Homey Pro' }].map((n, i) => [`k${i}`, n])),
});

test('zigbee: keeps only family, model, name and tx+rx; never the key or MAC addresses', () => {
  const c = zigbeeCounts(state([node(10, 'Skrivbord', 50, 60)]), T0);
  assert.deepEqual(c, { t: T0, nodes: { 10: { f: '_TZ3000_w0qqde0g|TS011F', m: 'TS011F', n: 'Skrivbord', c: 110 } } });
  assert.ok(!JSON.stringify(c).includes('secret') && !JSON.stringify(c).includes('00:00'));
  assert.deepEqual(zigbeeCounts(null, T0), { t: T0, nodes: {} });
});

test('zigbee: one plug of four talks 4× the others over a day → chatty; sensors without a family are skipped', () => {
  const day = (k) => [
    node(1, 'Skrivbord', 1000 + k * 28000, 1000 + k * 28000),   // ~2 300 an hour
    node(2, 'Torktumlare', 500 + k * 7000, 500 + k * 7000),
    node(3, 'Diskmaskin', 500 + k * 7000, 500 + k * 7000),
    node(4, 'Tvättmaskin', 500 + k * 7500, 500 + k * 7500),
    node(5, 'Rörelsesensor', 0, k * 9000, 'lumi.sensor_motion', ''),
  ];
  const prev = zigbeeCounts(state(day(0)), T0);
  const cur = zigbeeCounts(state(day(1)), T0 + 24 * HOUR);
  const c = chattyDevices(prev, cur);
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'Skrivbord');
  assert.equal(Math.round(c[0].perHour), 2333);
  assert.equal(Math.round(c[0].median), 604);
  // Too short a gap, no previous reading, or a counter that went down → nothing.
  assert.deepEqual(chattyDevices(prev, { ...cur, t: T0 + 2 * HOUR }), []);
  assert.deepEqual(chattyDevices(null, cur), []);
  const reset = zigbeeCounts(state([node(1, 'Skrivbord', 0, 0), ...day(1).slice(1)]), T0 + 24 * HOUR);
  assert.deepEqual(chattyDevices(prev, reset), []);
});

test('zigbee: a quiet family stays quiet, even when one lamp is the only one switched on', () => {
  const lamps = k => [10, 11, 12].map(a => node(a, `Tak ${a}`, a === 10 ? k * 600 : 5, 0, 'TRADFRI bulb', 'IKEA'));
  const c = chattyDevices(zigbeeCounts(state(lamps(0)), T0), zigbeeCounts(state(lamps(1)), T0 + 24 * HOUR));
  assert.deepEqual(c, []); // 25 an hour is below the 200 floor
});

test('zigbee: report line with advice', () => {
  const s = {
    homeyVersion: '13.5.2', bootDate: 0, rebootReason: 'reboot-ota', topCrashers: [], updates: [],
    chatty: [{ name: 'Skrivbord', model: 'TS011F', perHour: 2333.4, median: 604 }],
  };
  assert.match(dailySummary(s, t, String),
    /daily_attention\(\)\n⚠ daily_chatty\(list=chatty_item\(name=Skrivbord,model=TS011F,n=2333,median=604\)\) adv_chatty\(\)$/);
});
