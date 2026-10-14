'use strict';

const Homey = require('homey');
const { ReadOnlyApi } = require('./lib/web-api');
const {
  checkSystem, checkFirmware, checkApps, checkSensors, suspects, DAY,
  memoryReport, pssSnapshot, pssFromMemoryInfo, isUnplanned, systemMemory,
} = require('./lib/checks');
const { WINDOW, resolutionFor, analyze } = require('./lib/postmortem');
const {
  crashMinutes, scheduledNear, addHistory, recurringTimes, crashesBeforeBoots,
} = require('./lib/patterns');
const { eventText, dailySummary } = require('./lib/report');
const {
  DEFAULT_THRESHOLDS, DEFAULT_SUMMARY_HOUR, CHECK_INTERVAL, FIRST_CHECK_DELAY,
  SILENT_REPORT_MODES, DEFAULT_SILENT_REPORT,
} = require('./lib/constants');

const SENSOR_EVENTS = ['sensor_silent', 'sensor_back'];

// ── Sanity Check ──────────────────────────────────────────────────────────────
// Read-only: every Web API call below is a GET with a *.readonly scope.
// One full check per hour (5 GET calls: system, memory, apps, updates,
// devices; zones only when a device report goes out), no realtime
// subscriptions, small state in homey.settings, no growing logs.
// After an unplanned Homey restart, once: 2 Insights reads per app (RAM, CPU)
// plus system memory, for the 30 minutes before the restart, and the Flows
// (2 calls) to find time triggers near it. After an app crash: 2 Insights
// reads for that app to find the minute it crashed.

class SanityCheckApp extends Homey.App {

  async onInit() {
    this.log('Sanity Check started');
    this.log(`Homey:    ${this.homey.version}`);

    this._api = new ReadOnlyApi(this.homey);
    this._running = false;

    this._triggerRestarted = this.homey.flow.getTriggerCard('homey_restarted');
    this._triggerCrashed   = this.homey.flow.getTriggerCard('app_crashed');
    this._triggerReport    = this.homey.flow.getTriggerCard('report');
    this.homey.flow.getActionCard('run_check').registerRunListener(() => this.runCheck({ force: true }));

    this._firstTimeout = this.homey.setTimeout(() => this.runCheck(), FIRST_CHECK_DELAY);
    this._interval     = this.homey.setInterval(() => this.runCheck(), CHECK_INTERVAL);
  }

  async onUninit() {
    this.homey.clearTimeout(this._firstTimeout);
    this.homey.clearInterval(this._interval);
    this.log('Sanity Check stopped');
  }

  // ── Check ───────────────────────────────────────────────────────────────────

  async runCheck({ force = false } = {}) {
    if (this._running) return false;
    this._running = true;
    const t0 = Date.now();
    try {
      const now   = Date.now();
      const prev  = this.homey.settings.get('state') || {};
      // 0.1.0 flagged devices whose lastSeenAt was lost in a reboot; start the
      // silent list over once so those false positives don't get a "back" report.
      if (prev.schema !== 2) prev.silent = [];
      const next  = { ...prev, schema: 2 };
      const events = [];
      const firstRun = !prev.bootId; // baseline only: show a summary so the user sees it works

      const info = await this._get('system.getInfo', () => this._api.getInfo());
      if (info) {
        const r = checkSystem(info, prev, now);
        for (const e of r.events) {
          // The indication: which apps crashed most in the 24 h before this boot.
          if (e.type === 'homey_restarted') e.suspects = suspects(prev.apps, e.bootDate);
        }
        Object.assign(next, r.state);
        events.push(...r.events);
      }

      const memory = await this._get('system.getMemoryInfo', () => this._api.getMemoryInfo());
      const pssById = pssFromMemoryInfo(memory);
      next.sys = systemMemory(info, memory);

      const apps = await this._get('apps.getApps', () => this._api.getApps());
      if (apps) {
        const selfId = this.homey.manifest.id;
        const r = checkApps(Object.values(apps), prev, now, selfId, pssById);
        Object.assign(next, r.state);
        events.push(...r.events);
        const me = apps[selfId];
        next.self = { pss: pssById[selfId] ?? null, rss: me && me.usage ? me.usage.mem : null };
      }

      const updates = await this._get('updates.getUpdates', () => this._api.getUpdates());
      if (updates) {
        const r = checkFirmware(updates, prev);
        Object.assign(next, r.state);
        events.push(...r.events);
      }

      let silentNow = [];
      const devices = await this._get('devices.getDevices', () => this._api.getDevices());
      if (devices) {
        const r = checkSensors(Object.values(devices), prev, this._thresholds(), now, next.bootDate);
        Object.assign(next, r.state);
        events.push(...r.events);
        silentNow = r.current;
      }

      // History of unplanned restarts and crashes, with the best time we have.
      const seen = [];
      const since = prev.lastCheck ? new Date(prev.lastCheck.at).getTime() : now - 60 * 60 * 1000;
      for (const e of events) {
        if (e.type !== 'app_crashed') continue;
        e.times = await this._crashTimes(e.id, since, now);
        if (e.times.length) e.times.forEach(t => seen.push({ kind: 'crash', t, id: e.id, name: e.name }));
        else seen.push({ kind: 'crash', t: now, id: e.id, name: e.name, exact: false });
      }
      for (const e of events) {
        if (e.type !== 'homey_restarted' || !isUnplanned(e)) continue;
        e.postmortem = await this._postmortem(e.bootDate, prev.apps, now);
        const at = (e.postmortem && e.postmortem.quietAt) || new Date(e.bootDate).getTime();
        e.scheduled = await this._scheduledNear(at);
        seen.push({ kind: 'boot', t: at });
        const boot = (next.boots || []).find(b => b.bootDate === e.bootDate);
        if (boot) Object.assign(boot, { postmortem: e.postmortem, scheduled: e.scheduled });
      }
      next.history = addHistory(prev.history, seen, now);
      for (const e of events) {
        if (e.type !== 'homey_restarted' || !isUnplanned(e)) continue;
        e.recurring = recurringTimes(next.history, 'boot', t => this._local(t));
        e.crashLinks = crashesBeforeBoots(next.history);
      }

      next.lastCheck = { at: new Date(now).toISOString(), ms: Date.now() - t0 };
      this.homey.settings.set('state', next);
      await this._emit(events);
      await this._maybeDailySummary(next, silentNow, now, force || firstRun);

      this.log(`Check done in ${next.lastCheck.ms} ms, ${events.length} event(s), heap ${this._heapMb()} MB`);
      return true;
    } catch (err) {
      this.error('Check failed:', err.message);
      return false;
    } finally {
      this._running = false;
    }
  }

  async _get(label, fn) {
    try {
      return await fn();
    } catch (err) {
      this.error(`${label} failed:`, err.message);
      return null;
    }
  }

  // Homey's own Insights (RAM and CPU per app) for the minutes before bootDate.
  // Apps that were disabled before the restart have no data and are skipped.
  async _postmortem(bootDate, appsState, now) {
    const t0 = Date.now();
    const res = resolutionFor(new Date(bootDate).getTime() - WINDOW, now);
    if (!res) return { unavailable: true };
    const series = {};
    for (const [id, a] of Object.entries(appsState || {})) {
      if (a.enabled === false) continue;
      const entries = async kind => {
        try {
          const r = await this._api.getLogEntries('homey:manager:apps', `homey:manager:apps:${id}-${kind}`, res);
          return (r && r.values) || null;
        } catch (err) {
          return null; // no log for this app (e.g. never ran): nothing to judge
        }
      };
      series[id] = { name: a.name, mem: await entries('mem'), cpu: await entries('cpu') };
    }
    let system = null;
    try {
      const r = await this._api.getLogEntries('homey:manager:system', 'homey:manager:system:memory', res);
      system = (r && r.values) || null;
    } catch (err) {
      this.error('Insights system memory failed:', err.message);
    }
    const result = analyze(series, bootDate, { system });
    if (!result.checked) return { unavailable: true };
    this.log(`Post-mortem: ${result.checked} app(s), ${result.findings.length} finding(s) in ${Date.now() - t0} ms`);
    return result;
  }

  // Exact crash minutes from the app's RAM in Insights: lastHour (5 s steps)
  // for the newest part, last6Hours (1 min) for the rest. A crash shows as RAM
  // falling to 0 (verified 2026-10-14 with the crash probe, FINDINGS 1.19).
  async _crashTimes(id, from, to) {
    const times = [];
    for (const res of ['lastHour', 'last6Hours']) {
      try {
        const r = await this._api.getLogEntries('homey:manager:apps', `homey:manager:apps:${id}-mem`, res);
        for (const t of crashMinutes(r && r.values, from, to)) {
          if (!times.some(x => Math.abs(x - t) < 60 * 1000)) times.push(t);
        }
      } catch (err) {
        // no Insights for this app: the crash keeps the check time
      }
    }
    return times.sort((a, b) => a - b);
  }

  // Enabled Flows with a time trigger shortly before `at`.
  async _scheduledNear(at) {
    const adv   = await this._get('flow.getAdvancedFlows', () => this._api.getAdvancedFlows());
    const basic = await this._get('flow.getFlows', () => this._api.getFlows());
    if (!adv && !basic) return null;
    return scheduledNear([...Object.values(adv || {}), ...Object.values(basic || {})], at, t => this._local(t));
  }

  // Zones are only fetched when a device report is actually going out.
  async _addZoneNames(items) {
    const withZone = items.filter(e => e.zone);
    if (!withZone.length) return;
    const zones = await this._get('zones.getZones', () => this._api.getZones());
    for (const e of withZone) e.zoneName = zones && zones[e.zone] ? zones[e.zone].name : null;
  }

  _silentMode() {
    const mode = this.homey.settings.get('silentReport');
    return SILENT_REPORT_MODES.includes(mode) ? mode : DEFAULT_SILENT_REPORT;
  }

  // ── Output ──────────────────────────────────────────────────────────────────

  async _emit(allEvents) {
    const t = (key, tokens) => this.homey.__(key, tokens);
    const mode = this._silentMode();
    const sensorEvents = allEvents.filter(e => SENSOR_EVENTS.includes(e.type));
    // 'daily': device changes only appear in the daily summary.
    const events = mode === 'each' ? allEvents : allEvents.filter(e => !SENSOR_EVENTS.includes(e.type));
    if (mode !== 'daily') await this._addZoneNames(sensorEvents);

    if (mode === 'grouped' && sensorEvents.length) {
      const text = sensorEvents.map(e => eventText(e, t, d => this._fmt(d))).filter(Boolean).join('\n');
      this.log('Report:', text);
      await this.homey.notifications.createNotification({ excerpt: text }).catch(this.error);
      await this._triggerReport.trigger({ text, type: 'sensors' }).catch(this.error);
    }

    for (const e of events) {
      const text = eventText(e, t, d => this._fmt(d));
      if (!text) continue;
      this.log('Report:', text);
      await this.homey.notifications.createNotification({ excerpt: text }).catch(this.error);
      await this._triggerReport.trigger({ text, type: e.type }).catch(this.error);

      if (e.type === 'homey_restarted') {
        const top = (e.suspects || [])[0];
        await this._triggerRestarted.trigger({
          time:            this._fmt(e.bootDate),
          reason:          e.rebootReason || '',
          uptime_hours:    e.prevUptimeMs != null ? Math.round(e.prevUptimeMs / 36e5) : -1,
          suspect:         top ? `${top.name} v${top.version}` : '',
          suspect_crashes: top ? top.crashes : 0,
        }).catch(this.error);
      }
      if (e.type === 'app_crashed') {
        await this._triggerCrashed.trigger({
          app: e.name || e.id, version: e.version, count: e.delta, last24h: e.last24h,
        }).catch(this.error);
      }
    }
  }

  async _maybeDailySummary(state, silentNow, now, force) {
    const tz = this.homey.clock.getTimezone();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const hour  = Number(parts.hour);
    const want  = Number(this.homey.settings.get('summaryHour') ?? DEFAULT_SUMMARY_HOUR);

    if (!force && (hour !== want || this.homey.settings.get('lastSummary') === today)) return;
    if (!force) this.homey.settings.set('lastSummary', today);

    const apps = state.apps || {};
    const summary = {
      homeyVersion: state.homeyVersion,
      bootDate:     state.bootDate,
      rebootReason: state.rebootReason,
      restarts24h:  (state.boots || []).filter(b => now - new Date(b.bootDate).getTime() < DAY).length,
      topCrashers:  suspects(apps, now),
      updates:      Object.values(apps).filter(a => a.update).map(a => ({ name: a.name, version: a.version, update: a.update })),
      firmware:     state.firmwareAvailable,
      silent:       silentNow,
      memory:       memoryReport(apps, state.pssAtSummary),
      self:         state.self,
      sys:          state.sys,
      recurring:    [
        ...recurringTimes(state.history, 'boot', t => this._local(t)),
        ...recurringTimes(state.history, 'crash', t => this._local(t)),
      ],
    };
    // Snapshot for the "+N MB since yesterday" in the next summary.
    if (!force) this.homey.settings.set('state', { ...state, pssAtSummary: pssSnapshot(apps) });
    await this._addZoneNames(silentNow);
    const text = dailySummary(summary, (k, tk) => this.homey.__(k, tk), d => this._fmt(d));
    this.log('Daily summary:', text);
    await this.homey.notifications.createNotification({ excerpt: text }).catch(this.error);
    await this._triggerReport.trigger({ text, type: 'daily_summary' }).catch(this.error);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _thresholds() {
    return { ...DEFAULT_THRESHOLDS, ...(this.homey.settings.get('thresholds') || {}) };
  }

  _local(t) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return { h: Number(p.hour), m: Number(p.minute) };
  }

  _fmt(date) {
    return new Date(date).toLocaleString('sv-SE', { timeZone: this.homey.clock.getTimezone() });
  }

  // process.memoryUsage() throws ENOENT in the Homey sandbox (FINDINGS 1.8).
  _heapMb() {
    try {
      return Math.round(require('v8').getHeapStatistics().used_heap_size / 1e6);
    } catch (err) {
      return '?';
    }
  }

}

module.exports = SanityCheckApp;
