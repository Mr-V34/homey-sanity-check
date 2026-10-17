'use strict';

// ── Radio traffic ─────────────────────────────────────────────────────────────
// Zigbee only for now. ManagerZigbee.getState (GET /api/manager/zigbee/state,
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
    (families[d.f] = families[d.f] || []).push({ name: d.n, model: d.m, perHour: (d.c - p.c) / hours });
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

module.exports = { FAMILY_MIN, CHATTY_RATIO, CHATTY_MIN, zigbeeCounts, chattyDevices };
