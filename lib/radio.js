'use strict';

// ── Radio traffic ─────────────────────────────────────────────────────────────
// Zigbee and Z-Wave. ManagerZigbee.getState (GET /api/manager/zigbee/state,
// homey.system.readonly) is read once a day. Its answer holds the network key
// and every device's MAC address, so it is never stored or logged: only the
// message counters and device names below are kept.
//
// A device that talks much more than others of the same make and model may be
// badly placed, faulty, or polled too often by its app (the Tuya TS011F plug,
// 2026-10-14). A device that doesn't answer is NOT a finding: lamps switched
// off at the wall on purpose look the same (user decision 2026-10-17).

const HOUR = 60 * 60 * 1000;
const FAMILY_MIN = 3;       // devices of one make and model before we compare
const CHATTY_RATIO = 3;     // times the family median (first guess)
const CHATTY_MIN = 200;     // messages per hour, so quiet families stay quiet (first guess)
const MIN_SPAN = 12 * HOUR; // shorter gaps between readings say too little

// getState() → { t, nodes: { [network address]: { f: family, m: model, n: name, c: tx + rx } } }
// Counters are cumulative (they survive Homey restarts), so only differences count.
function zigbeeCounts(state, now) {
  const nodes = {};
  for (const node of Object.values((state && state.nodes) || {})) {
    if (!node || node.type === 'coordinator' || !node.stats || !Number.isFinite(node.nwkAddr)) continue;
    const c = (Number(node.stats.tx) || 0) + (Number(node.stats.rx) || 0);
    nodes[node.nwkAddr] = {
      f: `${node.manufacturerName || ''}|${node.modelId || ''}`,
      m: String(node.modelId || ''),
      n: String(node.name || node.modelId || node.nwkAddr),
      c,
    };
  }
  return { t: now, nodes };
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Messages per hour per device between two readings, grouped by family; the
// devices far above their family's median, most first.
function chattyDevices(prev, cur, limit = 3) {
  if (!prev || !cur || !prev.nodes || !(cur.t - prev.t >= MIN_SPAN)) return [];
  const hours = (cur.t - prev.t) / HOUR;
  const families = {};
  for (const [addr, d] of Object.entries(cur.nodes || {})) {
    const p = prev.nodes[addr];
    if (!p || p.f !== d.f || d.c < p.c || d.f === '|') continue; // new, re-joined or reset
    (families[d.f] = families[d.f] || []).push({ id: addr, name: d.n, model: d.m, perHour: (d.c - p.c) / hours });
  }
  const out = [];
  for (const list of Object.values(families)) {
    if (list.length < FAMILY_MIN) continue;
    const med = median(list.map(x => x.perHour));
    for (const x of list) {
      if (x.perHour >= CHATTY_MIN && x.perHour >= CHATTY_RATIO * med) out.push({ ...x, median: med });
    }
  }
  return out.sort((a, b) => b.perHour - a.perHour).slice(0, limit);
}

// ── Z-Wave ────────────────────────────────────────────────────────────────────
// ManagerZwave.getState (GET /api/manager/zwave/state, homey.system.readonly),
// read once a day. Its answer holds the home id and the network keys, so only
// the counters below are kept. Counters count since Homey started, so only
// differences count; a lower counter means a restart or a re-included node.
// Limits: notes/PLAN-0.7.0.md "Z-Wave, step 2" (first guesses, 2026-10-18).
const ZW_TX_MIN = 50;      // sends in the period before the failure share means anything
const ZW_FAIL_SHARE = 0.2; // failed sends / sends

// getState() → { t, nodes: { [node id]: { f, m, n, tx, err, rx, c, bad } } }.
// Node 1 is Homey itself. Names come later, and only when there is a finding:
// the device list costs Sanity Check about 7 MB (measured 2026-10-18).
function zwaveCounts(state, now) {
  const z = (state && state.zw_state) || {};
  const stats = z.stats || {};
  const nodes = {};
  for (const [key, net] of Object.entries(stats)) {
    const m = key.match(/^node_(\d+)_network$/);
    if (!m || !net || m[1] === '1') continue;
    const s = (z.nodeSettings && z.nodeSettings[m[1]]) || {};
    const part = v => (v && typeof v === 'object' ? (v.value ?? JSON.stringify(v)) : v ?? '');
    const tx = Number(net.tx) || 0, err = Number(net.tx_err) || 0, rx = Number(net.rx) || 0;
    const f = `${part(s.manufacturerId)}|${part(s.productTypeId)}|${part(s.productId)}`;
    // No make or model: '|' is skipped by chattyDevices, as for Zigbee.
    nodes[m[1]] = { f: f === '||' ? '|' : f, m: '', n: m[1], tx, err, rx, c: tx + rx };
  }
  return { t: now, nodes };
}

// Devices whose sends often fail although they answer, on two readings in a
// row. Marks `bad` on the current reading for the next comparison.
function failingZwave(prev, cur, limit = 3) {
  if (!prev || !cur || !prev.nodes || !(cur.t - prev.t >= MIN_SPAN)) return [];
  const out = [];
  for (const [id, d] of Object.entries(cur.nodes || {})) {
    const p = prev.nodes[id];
    if (!p || d.tx < p.tx || d.err < p.err || d.rx < p.rx) continue; // new, restarted or re-included
    const tx = d.tx - p.tx, err = d.err - p.err, rx = d.rx - p.rx;
    // A device that answers nothing is off or asleep: never a finding.
    d.bad = tx >= ZW_TX_MIN && rx > 0 && err / tx >= ZW_FAIL_SHARE;
    if (d.bad && p.bad) out.push({ id, name: d.n, share: err / tx, tx });
  }
  return out.sort((a, b) => b.share - a.share).slice(0, limit);
}

// Device names for Z-Wave node ids, from the devices' zw_node_id setting.
function zwaveNames(devices) {
  const names = {};
  for (const d of Object.values(devices || {})) {
    const id = d && d.settings && d.settings.zw_node_id;
    if (id != null && d.name) names[String(id)] = String(d.name);
  }
  return names;
}

module.exports = {
  FAMILY_MIN, CHATTY_RATIO, CHATTY_MIN, ZW_TX_MIN, ZW_FAIL_SHARE,
  zigbeeCounts, chattyDevices, zwaveCounts, failingZwave, zwaveNames,
};
