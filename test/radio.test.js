'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zigbeeCounts, chattyDevices, zwaveCounts, failingZwave, zwaveNames } = require('../lib/radio');
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

// ── Z-Wave ────────────────────────────────────────────────────────────────────
// Shape of ManagerZwave.getState (CLI read 2026-10-18, FINDINGS 1.22), keys made up.
const zwState = nodes => ({
  zw_state: {
    homeId: 123, networkKeys: { s0: 'secret' },
    stats: Object.fromEntries(Object.entries(nodes).flatMap(([id, [tx, err, rx]]) =>
      [[`node_${id}_network`, { tx_queued: tx, tx, tx_err: err, tx_ok: tx - err, rx }]])),
    nodeSettings: Object.fromEntries(Object.keys(nodes).map(id => [id, {
      manufacturerId: { value: 271 }, productTypeId: { value: 258 }, productId: { value: id === '9' ? 4096 : 4097 },
    }])),
  },
  zw_ready: true,
});
const zwDevices = { a: { name: 'Entretaket', settings: { zw_node_id: 8 } }, b: { name: 'Manooolan', settings: { zw_node_id: 7 } } };

test('zwave: counters per node, never the keys; Homey itself skipped; names from zw_node_id', () => {
  const r = zwaveCounts(zwState({ 1: [5, 0, 5], 7: [190, 0, 456], 8: [385, 0, 872], 9: [10, 0, 10] }), T0);
  assert.deepEqual(Object.keys(r.nodes), ['7', '8', '9']);
  assert.deepEqual(r.nodes['8'], { f: '271|258|4097', m: '', n: '8', tx: 385, err: 0, rx: 872, c: 1257 });
  assert.doesNotMatch(JSON.stringify(r), /secret|homeId/);
  assert.deepEqual(zwaveNames(zwDevices), { 8: 'Entretaket', 7: 'Manooolan' });
});

test('zwave: failed sends only on two readings in a row, and only if the device answers', () => {
  const read = (h, tx, err, rx) => zwaveCounts(zwState({ 8: [tx, err, rx] }), T0 + h * HOUR);
  const d0 = read(0, 100, 0, 100);
  const d1 = read(24, 200, 30, 150); // 100 sends, 30 % failed, answered
  assert.deepEqual(failingZwave(d0, d1), []); // first bad day: not yet
  assert.equal(d1.nodes['8'].bad, true);
  const d2 = read(48, 300, 60, 200);
  assert.deepEqual(failingZwave(d1, d2), [{ id: '8', name: '8', share: 0.3, tx: 100 }]);
  // Switched off at the wall: nothing comes back, never a finding.
  const off = read(72, 400, 100, 200);
  assert.deepEqual(failingZwave(d2, off), []);
  assert.equal(off.nodes['8'].bad, false);
  // Too few sends, or under 20 %: not bad.
  const few = read(96, 440, 140, 210);
  failingZwave(off, few);
  assert.equal(few.nodes['8'].bad, false);
});

test('zwave: a lower counter (restart) gives a new baseline, no finding', () => {
  const a = zwaveCounts(zwState({ 8: [300, 60, 200] }), T0);
  a.nodes['8'].bad = true;
  const b = zwaveCounts(zwState({ 8: [100, 30, 50] }), T0 + 24 * HOUR);
  assert.deepEqual(failingZwave(a, b), []);
  assert.equal(b.nodes['8'].bad, undefined);
});

test('zwave: report lines with advice', () => {
  const s = {
    homeyVersion: '13.5.2', bootDate: 0, rebootReason: 'reboot-ota', topCrashers: [], updates: [],
    zwFailing: [{ name: 'Entretaket', share: 0.3, tx: 100 }],
    zwChatty: [{ name: 'Brandvarnare', perHour: 800.2, median: 20 }],
  };
  const text = dailySummary(s, t, String);
  assert.match(text, /^⚠ daily_zw_failing\(list=zw_failing_item\(name=Entretaket,pct=30,n=100\)\) adv_zw_failing\(\)$/m);
  assert.match(text, /^⚠ daily_zw_chatty\(list=zw_chatty_item\(name=Brandvarnare,n=800,median=20\)\) adv_zw_chatty\(\)$/m);
});
