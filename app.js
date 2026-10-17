'use strict';

const Homey = require('homey');
const { ReadOnlyApi } = require('./lib/web-api');
const {
  checkSystem, checkFirmware, checkApps, suspects, DAY,
  memoryGrowth, largestApps, pssSnapshot, pssFromMemoryInfo, isUnplanned, systemMemory, unplannedWithin,
  backupStatus, firmwareSettings, storageStatus, swapDue, swapApps,
} = require('./lib/checks');
const { WINDOW, resolutionFor, trimToWindow, analyze } = require('./lib/postmortem');
const { BASE, analyzeSignals } = require('./lib/verdict');
const {
  crashMinutes, scheduledNear, addHistory, changeEntries, dropPlannedBoots, recurringTimes, crashesBeforeBoots,
  changeLink,
} = require('./lib/patterns');
const { eventText, dailySummary } = require('./lib/report');
const {
  DEFAULT_SUMMARY_HOUR, SUMMARY_DETAILS, CHECK_INTERVAL, FIRST_CHECK_DELAY,
} = require('./lib/constants');

// Settings and state of the silent-device check, removed in 0.5.0.
const OBSOLETE_SETTINGS = ['thresholds', 'silentReport'];

// ── Sanity Check ──────────────────────────────────────────────────────────────
// Read-only: every Web API call below is a GET with a *.readonly scope.
// One full check per hour (4 GET calls: system, memory, apps, updates), no
// realtime subscriptions, small state in homey.settings, no growing logs.
// Once a day, for the summary: backup, firmware channel and storage (5 calls).
// When swap is high, at most every 6 hours: memory per running app (1 call
// per app) to see whose memory is in swap.
// After an unplanned Homey restart, once: 2 Insights reads per app (RAM, CPU),
// Sanity Check itself included, plus system memory, undervoltage, CPU
// temperature and load, for the 30 minutes before the restart, and the Flows
// (2 calls) to find time triggers near it. After an app crash: 2 Insights
// reads for that app to find the minute it crashed.

class SanityCheckApp extends Homey.App {

  async onInit() {
    this.log('Sanity Check started');
    this.log(`Homey:    ${this.homey.version}`);

    this._api = new ReadOnlyApi(this.homey);
    for (const key of OBSOLETE_SETTINGS) {
      if (this.homey.settings.get(key) != null) this.homey.settings.unset(key);
    }
    this._running = false;

    this._triggerRestarted = this.homey.flow.getTriggerCard('homey_restarted');
    this._triggerCrashed   = this.homey.flow.getTriggerCard('app_crashed');
    this._triggerReport    = this.homey.flow.getTriggerCard('report');
    this.homey.flow.getActionCard('run_check').registerRunListener(() => this.runCheck({ force: true }));
    this.homey.flow.getConditionCard('unplanned_restart').registerRunListener(({ hours }) => {
      const boots = (this.homey.settings.get('state') || {}).boots;
      return unplannedWithin(boots, hours * 60 * 60 * 1000, Date.now());
    });

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
      const next  = { ...prev, schema: 3 };
      delete next.silent; // silent-device list, removed in 0.5.0
      const events = [];
      const firstRun = !prev.bootId; // baseline only: show a summary so the user sees it works
      next.since = prev.since || now; // when watching began, for changeLink

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
      next.sysPrev = prev.sys || null; // one hour back, to see which process grew
      next.sys = systemMemory(info, memory);

      const apps = await this._get('apps.getApps', () => this._api.getApps());
      if (apps) {
        const selfId = this.homey.manifest.id;
        const r = checkApps(Object.values(apps), prev, now, selfId, pssById);
        Object.assign(next, r.state);
        events.push(...r.events);
        const me = apps[selfId];
        next.self = { pss: pssById[selfId] ?? null, rss: me && me.usage ? me.usage.mem : null };
        if (swapDue(next.sys, prev.swapApps, now)) next.swapApps = await this._swapApps(next, now);
      }

      const updates = await this._get('updates.getUpdates', () => this._api.getUpdates());
      if (updates) {
        const r = checkFirmware(updates, prev);
        Object.assign(next, r.state);
        events.push(...r.events);
      }

      // History of unplanned restarts, crashes and changes, with the best time we have.
      const seen = changeEntries(events, now);
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
      const plannedAt = (next.boots || []).filter(b => !isUnplanned(b))
        .flatMap(b => [new Date(b.bootDate).getTime(), b.postmortem && b.postmortem.quietAt]);
      next.history = addHistory(dropPlannedBoots(prev.history, plannedAt), seen, now);
      for (const e of events) {
        if (e.type !== 'homey_restarted' || !isUnplanned(e)) continue;
        e.recurring = recurringTimes(next.history, 'boot', t => this._local(t));
        e.crashLinks = crashesBeforeBoots(next.history);
      }

      next.lastCheck = { at: new Date(now).toISOString(), ms: Date.now() - t0 };
      this.homey.settings.set('state', next);
      await this._emit(events);
      await this._maybeDailySummary(next, now, force || firstRun);

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
  // Sanity Check is in the list too: its RAM peaked before both restarts on
  // 2026-10-14, and without its own series it could never point at itself.
  async _postmortem(bootDate, appsState, now) {
    const t0 = Date.now();
    const res = resolutionFor(new Date(bootDate).getTime() - WINDOW, now);
    if (!res) return { unavailable: true };
    const entries = async (id, kind) => {
      try {
        const r = await this._api.getLogEntries('homey:manager:apps', `homey:manager:apps:${id}-${kind}`, res);
        return r && r.values ? trimToWindow(r.values, bootDate) : null;
      } catch (err) {
        return null; // no log for this app (e.g. never ran): nothing to judge
      }
    };
    const series = {};
    for (const [id, a] of Object.entries(appsState || {})) {
      if (a.enabled === false) continue;
      series[id] = { name: a.name, mem: await entries(id, 'mem'), cpu: await entries(id, 'cpu') };
    }
    const selfId = this.homey.manifest.id;
    series[selfId] = {
      name: this.homey.manifest.name.en, self: true,
      mem: await entries(selfId, 'mem'), cpu: await entries(selfId, 'cpu'),
    };
    let system = null;
    try {
      const r = await this._api.getLogEntries('homey:manager:system', 'homey:manager:system:memory', res);
      system = r && r.values ? trimToWindow(r.values, bootDate) : null;
    } catch (err) {
      this.error('Insights system memory failed:', err.message);
    }
    const result = analyze(series, bootDate, { system });
    if (!result.checked) return { unavailable: true };
    result.signals = analyzeSignals(await this._systemSignals(bootDate, now), bootDate, result.quietAt ?? undefined);
    this.log(`Post-mortem: ${result.checked} app(s), ${result.findings.length} finding(s) in ${Date.now() - t0} ms`);
    return result;
  }

  // Undervoltage, CPU temperature and load before the restart, plus 3 hours
  // before that as this Homey's normal. 3 Insights reads, once per restart.
  async _systemSignals(bootDate, now) {
    const bootMs = new Date(bootDate).getTime();
    const res = resolutionFor(bootMs - WINDOW - BASE, now) || resolutionFor(bootMs - WINDOW, now);
    const out = {};
    for (const [key, id] of [['undervoltage', 'undervoltageratio'], ['temperature', 'temperature'], ['loadavg', 'loadavg']]) {
      try {
        const r = await this._api.getLogEntries('homey:manager:system', `homey:manager:system:${id}`, res);
        out[key] = r && r.values ? trimToWindow(r.values, bootDate, WINDOW + BASE) : null;
      } catch (err) {
        this.error(`Insights system ${id} failed:`, err.message);
      }
    }
    return out;
  }

  // getAppUsage for every running app, one after the other.
  async _swapApps(state, now) {
    const usage = {};
    for (const [id, a] of Object.entries(state.apps || {})) {
      if (a.state !== 'running') continue;
      usage[id] = await this._api.getAppUsage(id).catch(() => null);
    }
    const r = swapApps(usage, state.apps, state.sys.swap, now);
    this.log(`Swap ${Math.round(state.sys.swap / 1e6)} MB: read ${Object.keys(usage).length} app(s), top ${r.top.map(x => `${x.id} ${Math.round(x.swap / 1e6)} MB`).join(', ') || 'none ≥ 1 MB'}`);
    return r;
  }

  // Backup, firmware channel and storage for the daily summary.
  async _daily(now) {
    const get = (label, fn) => this._get(label, fn);
    const backup = backupStatus(
      await get('backup.lastSuccessfulBackup', () => this._api.getBackupLast()),
      await get('backup.automaticBackupsEnabled', () => this._api.getBackupAuto()),
      now,
    );
    const firmwareCfg = firmwareSettings(
      await get('updates.channel', () => this._api.getUpdateChannel()),
      await get('updates.autoupdate', () => this._api.getUpdateAuto()),
    );
    const storage = storageStatus(await get('system.getStorageInfo', () => this._api.getStorageInfo()));
    this.log(`Daily: backup ${backup ? `${backup.days} d, auto ${backup.auto}` : '?'}, channel ${firmwareCfg ? `${firmwareCfg.channel}, auto ${firmwareCfg.auto}` : '?'}, storage ${storage ? `${Math.round(storage.free / 1e6)} MB free` : '?'}`);
    return { backup, firmwareCfg, storage };
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

  // ── Output ──────────────────────────────────────────────────────────────────

  async _emit(allEvents) {
    const t = (key, tokens) => this.homey.__(key, tokens);
    for (const e of allEvents) {
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

  async _maybeDailySummary(state, now, force) {
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
      unplanned24h: (state.boots || []).filter(b => isUnplanned(b) && now - new Date(b.bootDate).getTime() < DAY).length,
      topCrashers:  suspects(apps, now),
      updates:      Object.entries(apps).filter(([, a]) => a.update)
        .map(([id, a]) => ({ id, name: a.name, version: a.version, update: a.update, auto: a.auto })),
      firmware:     state.firmwareAvailable,
      grew:         memoryGrowth(apps, state.pssAtSummary),
      largest:      largestApps(apps, state.pssAtSummary),
      self:         state.self,
      sys:          state.sys,
      recurring:    [
        ...recurringTimes(state.history, 'boot', t => this._local(t)),
        ...recurringTimes(state.history, 'crash', t => this._local(t)),
      ],
      swapApps:     state.swapApps && now - state.swapApps.t < DAY ? state.swapApps : null,
      link:         changeLink(state.history, now, state.since),
      ...(await this._daily(now)),
    };
    // "Restarts stopped" is said once per quiet spell (keyed by the last restart).
    const l = summary.link;
    if (l && l.kind === 'stopped') {
      const key = String(l.last);
      l.said = this.homey.settings.get('linkSaid') === key;
      if (!force) this.homey.settings.set('linkSaid', key);
    }
    // A late backup is said once per last backup, not every morning: not
    // backing up can be the user's own choice.
    const b = summary.backup;
    if (b && b.overdue) {
      const key = String(b.last);
      b.repeat = this.homey.settings.get('backupWarned') === key;
      this.homey.settings.set('backupWarned', key);
    }
    // Snapshot for the "+N MB since yesterday" in the next summary.
    if (!force) this.homey.settings.set('state', { ...state, pssAtSummary: pssSnapshot(apps) });
    const detail = this.homey.settings.get('summaryDetail');
    const text = dailySummary(summary, (k, tk) => this.homey.__(k, tk), d => this._fmt(d),
      SUMMARY_DETAILS.includes(detail) ? detail : SUMMARY_DETAILS[0]);
    this.log('Daily summary:', text);
    await this.homey.notifications.createNotification({ excerpt: text }).catch(this.error);
    await this._triggerReport.trigger({ text, type: 'daily_summary' }).catch(this.error);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

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
