'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crashMinutes, timeTriggers, scheduledNear, addHistory, dropPlannedBoots, recurringTimes, crashesBeforeBoots,
} = require('../lib/patterns');
const { eventText } = require('../lib/report');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// UTC as "local" keeps the tests independent of the machine's timezone.
const local = t => ({ h: new Date(t).getUTCHours(), m: new Date(t).getUTCMinutes() });
const at = s => Date.parse(`2026-10-14T${s}Z`);

// ── Crash minutes ─────────────────────────────────────────────────────────────

test('crash minutes: RAM falling to 0 (crash probe 2026-10-14, 5 s steps) is a crash', () => {
  const e = [['09:25:00', 61], ['09:25:05', 61], ['09:25:10', 0], ['09:25:15', 0], ['09:25:30', 40], ['09:25:35', 0]]
    .map(([t, v]) => ({ t: `2026-10-14T${t}.000Z`, v }));
  assert.deepEqual(crashMinutes(e, at('09:00:00'), at('09:30:00')), [at('09:25:10'), at('09:25:35')]);
});

test('crash minutes: null after a value counts, slow changes and times outside the range do not', () => {
  const e = [['09:00', 60], ['09:01', null], ['09:02', 58], ['09:03', 50], ['09:04', 49]]
    .map(([t, v]) => ({ t: `2026-10-14T${t}:00.000Z`, v }));
  assert.deepEqual(crashMinutes(e, at('09:00:00'), at('09:10:00')), [at('09:01:00')]);
  assert.deepEqual(crashMinutes(e, at('09:01:00'), at('09:10:00')), []);
});

// ── Scheduled Flows (card shapes from the user's Homey 2026-10-14) ───────────

const timers = {
  name: 'Timers', enabled: true,
  cards: {
    a: { type: 'trigger', id: 'homey:manager:cron:time_exactly', args: { time: '07:00' } },
    b: { type: 'trigger', id: 'homey:manager:cron:every_nth', args: { n: 15, type: 'minute' } },
    c: { type: 'action', id: 'homey:manager:apps:restart_app' },
  },
};

test('flows: time triggers are read from Advanced and basic Flows', () => {
  assert.equal(timeTriggers(timers).length, 2);
  assert.deepEqual(timeTriggers({ trigger: { id: 'homey:manager:cron:time_exactly', args: { time: '7:30' } } }),
    [{ kind: 'time', minuteOfDay: 450, label: '07:30' }]);
});

test('flows: every 15 min matches 2 min after :45; 07:00 matches 07:10 but not 07:47', () => {
  assert.deepEqual(scheduledNear([timers], at('07:47:00'), local), [{ flow: 'Timers', every: 15, unit: 'minute' }]);
  const hits = scheduledNear([timers], at('07:10:00'), local).map(h => h.when || h.every);
  assert.deepEqual(hits, ['07:00']);
  assert.deepEqual(scheduledNear([{ ...timers, enabled: false }], at('07:47:00'), local), []);
});

test('flows: a trigger just after midnight matches a restart just before it', () => {
  const f = { name: 'Night', cards: { a: { type: 'trigger', id: 'homey:manager:cron:time_exactly', args: { time: '00:01' } } } };
  assert.equal(scheduledNear([f], at('23:59:00'), local).length, 1);
});

// ── History and recurring times ───────────────────────────────────────────────

test('history: keeps 30 days and at most 60 events, sorted', () => {
  const now = at('12:00:00');
  const h = addHistory([{ kind: 'boot', t: now - 31 * DAY }], Array.from({ length: 70 }, (_, i) => ({ kind: 'crash', t: now - i * MIN })), now);
  assert.equal(h.length, 60);
  assert.ok(h.every((e, i) => i === 0 || h[i - 1].t <= e.t));
});

test('recurring: two restarts around 09:47 on different days; same day does not count', () => {
  const h = [
    { kind: 'boot', t: at('07:47:00') },
    { kind: 'boot', t: at('07:40:00') - 3 * DAY },
    { kind: 'boot', t: at('20:20:00') - DAY },
  ];
  const g = recurringTimes(h, 'boot', local);
  assert.equal(g.length, 1);
  assert.equal(g[0].n, 2);
  assert.equal(recurringTimes([{ kind: 'boot', t: at('07:47:00') }, { kind: 'boot', t: at('07:50:00') }], 'boot', local).length, 0);
});

test('recurring: crashes with only the check time are left out', () => {
  const h = [{ kind: 'crash', t: at('03:00:00'), exact: false }, { kind: 'crash', t: at('03:00:00') - DAY, exact: false }];
  assert.equal(recurringTimes(h, 'crash', local).length, 0);
});

test('links: app that crashed before 2 of 3 restarts', () => {
  const b1 = at('07:47:00');
  const h = [
    { kind: 'crash', id: 'r', name: 'Roborock', t: b1 - 10 * MIN },
    { kind: 'crash', id: 'r', name: 'Roborock', t: b1 - 5 * MIN },
    { kind: 'boot', t: b1 },
    { kind: 'crash', id: 'r', name: 'Roborock', t: b1 - 2 * DAY - 30 * MIN },
    { kind: 'boot', t: b1 - 2 * DAY },
    { kind: 'boot', t: b1 - 5 * DAY },
  ];
  assert.deepEqual(crashesBeforeBoots(h), { total: 3, apps: [{ id: 'r', name: 'Roborock', boots: 2 }] });
});

// ── Texts ─────────────────────────────────────────────────────────────────────

const t = (k, tk = {}) => `${k.split('.').pop()}(${Object.entries(tk).map(([a, b]) => `${a}=${b}`).join(',')})`;
const fmt = d => new Date(d).toISOString().replace('T', ' ').slice(0, 19);

test('report: restart lists scheduled Flows, recurring time and crash link', () => {
  const text = eventText({
    type: 'homey_restarted', bootDate: '2026-10-14T07:50:50Z', rebootReason: 'unexpected', suspects: [],
    scheduled: [{ flow: 'Timers', every: 15, unit: 'minute' }],
    recurring: [{ kind: 'boot', n: 2, from: 460, to: 467, names: [] }],
    crashLinks: { total: 3, apps: [{ id: 'r', name: 'Roborock', boots: 2 }] },
  }, t, fmt);
  assert.match(text, /sched_near\(list=Timers \(every_minutes\(n=15\)\)\)/);
  assert.match(text, /recurring_boot\(n=2,time=07:40–07:47,apps=\)/);
  assert.match(text, /crash_link\(app=Roborock,n=2,total=3\)/);
});

test('report: crash with Insights times', () => {
  const text = eventText({ type: 'app_crashed', name: 'X', version: '1', delta: 2, last24h: 2, times: [at('09:25:10'), at('09:25:35')] }, t, fmt);
  assert.match(text, /crash_times\(list=09:25:10, 09:25:35\)/);
});

test('history: boots at planned times are dropped, crashes and other boots stay', () => {
  const ota = Date.parse('2026-10-15T18:20:39.026Z'); // the real entry from 2026-10-15
  const h = [
    { kind: 'crash', t: ota, id: 'x' },
    { kind: 'boot', t: 1791982560000 },
    { kind: 'boot', t: ota },
    { kind: 'boot', t: 1000 }, // went quiet at 1000
  ];
  assert.deepEqual(dropPlannedBoots(h, [ota, null, 1000]), h.slice(0, 2));
  assert.deepEqual(dropPlannedBoots(undefined, [ota]), []);
  assert.deepEqual(dropPlannedBoots(h, []), h);
});
