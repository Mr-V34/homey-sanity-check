'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const {
  checkSystem, checkFirmware, checkApps, checkSensors, suspects, DAY,
} = require('./lib/checks');
const { eventText, dailySummary } = require('./lib/report');
const {
  DEFAULT_THRESHOLDS, DEFAULT_SUMMARY_HOUR, CHECK_INTERVAL, FIRST_CHECK_DELAY,
  SILENT_REPORT_MODES, DEFAULT_SILENT_REPORT,
} = require('./lib/constants');

const SENSOR_EVENTS = ['sensor_silent', 'sensor_back'];

// ── Sanity Check ──────────────────────────────────────────────────────────────
// Read-only: every Web API call below is a GET with a *.readonly scope.
// One full check per hour (4 calls: system, apps, updates, devices), no
// realtime subscriptions, small state in homey.settings, no growing logs.

class SanityCheckApp extends Homey.App {

  async onInit() {
    this.log('Sanity Check started');
    this.log(`Homey:    ${this.homey.version}`);

    this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
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

      const info = await this._get('system.getInfo', () => this._api.system.getInfo());
      if (info) {
        const r = checkSystem(info, prev, now);
        for (const e of r.events) {
          // The indication: which apps crashed most in the 24 h before this boot.
          if (e.type === 'homey_restarted') e.suspects = suspects(prev.apps, e.bootDate);
        }
        Object.assign(next, r.state);
        events.push(...r.events);
      }

      const apps = await this._get('apps.getApps', () => this._api.apps.getApps());
      if (apps) {
        const r = checkApps(Object.values(apps), prev, now, this.homey.manifest.id);
        Object.assign(next, r.state);
        events.push(...r.events);
      }

      const updates = await this._get('updates.getUpdates', () => this._api.updates.getUpdates());
      if (updates) {
        const r = checkFirmware(updates, prev);
        Object.assign(next, r.state);
        events.push(...r.events);
      }

      let silentNow = [];
      const devices = await this._get('devices.getDevices', () => this._api.devices.getDevices());
      if (devices) {
        const r = checkSensors(Object.values(devices), prev, this._thresholds(), now, next.bootDate);
        Object.assign(next, r.state);
        events.push(...r.events);
        silentNow = r.current;
      }

      this.homey.settings.set('state', next);
      await this._emit(events);
      await this._maybeDailySummary(next, silentNow, now, force || firstRun);

      this.log(`Check done in ${Date.now() - t0} ms, ${events.length} event(s), heap ${this._heapMb()} MB`);
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

  // Zones are only fetched when a device report is actually going out.
  async _addZoneNames(items) {
    const withZone = items.filter(e => e.zone);
    if (!withZone.length) return;
    const zones = await this._get('zones.getZones', () => this._api.zones.getZones());
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
    };
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
