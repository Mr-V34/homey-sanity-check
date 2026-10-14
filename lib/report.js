'use strict';

// ── Report texts ──────────────────────────────────────────────────────────────
// Turns check events into short timeline lines. `t(key, tokens)` is
// homey.__ and `fmt` formats dates in Homey's timezone. Wording is deliberately
// "indication, not proof": we report coincidence, never cause. A restart report
// puts each part on its own line so it reads well on the timeline.

const { HOUR, MB, processChanges } = require('./checks');

// What the apps must leave unexplained of a system jump before we say the rest
// came from outside them (MB).
const OUTSIDE_MIN = 10;
const { hhmm } = require('./patterns');

function duration(ms, t) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return t('report.unknown');
  const h = Math.floor(ms / HOUR);
  if (h >= 48) return t('report.days', { n: Math.floor(h / 24) });
  if (h >= 1) return t('report.hours', { n: h });
  return t('report.minutes', { n: Math.max(1, Math.round(ms / 60000)) });
}

function mb(bytes) {
  return `${Math.round(bytes / MB)} MB`;
}

function appLabel(a) {
  return `${a.name || a.id} v${a.version}`;
}

function suspectLine(list, t, noneKey = 'report.no_suspects') {
  if (!list.length) return t(noneKey);
  return t('report.suspects', {
    list: list.map(s => {
      const parts = [`${s.crashes}×`];
      if (Number.isFinite(s.pss)) parts.push(`PSS ${mb(s.pss)}`);
      if (s.noMessage) parts.push(t('report.no_message'));
      if (s.update) parts.push(`${s.update} ${t('report.exists')}`);
      return `${appLabel(s)} (${parts.join(', ')})`;
    }).join(', '),
  });
}

function clock(date, fmt) {
  return fmt(date).split(' ').pop();
}

// "When did we last look?" Crashes after that check are invisible to us.
function blindLine(e, t, fmt) {
  const at = e.before && e.before.lastCheck;
  if (!at) return null;
  return t('report.last_check', { time: clock(at, fmt), gap: duration(new Date(e.bootDate) - new Date(at), t) });
}

function findingText(f, t) {
  const parts = [];
  if (f.flags.includes('ram_grew') || f.flags.includes('ram_dropped')) {
    parts.push(t('report.pm_ram', { from: Math.round(f.ramStart), to: Math.round(f.ramEnd), change: signed(f.ramChange) }));
  } else if (f.flags.includes('ram_jump')) {
    parts.push(t('report.pm_ram_jump', { change: signed(f.ramStep) }));
  }
  if (f.flags.includes('cpu')) parts.push(t('report.pm_cpu', { avg: Math.round(f.cpuAvg), max: Math.round(f.cpuMax) }));
  const name = f.self ? t('report.self_label', { name: f.name || f.id }) : (f.name || f.id);
  return `${name} ${parts.join(', ')}`;
}

function sysJumpLines(j, t, fmt) {
  const lines = [t('report.pm_sys_jump', { mb: j.mb, time: clock(j.at, fmt) })];
  if (Number.isFinite(j.apps)) {
    // Apps falling while the system rises: we don't add the two up, because
    // app RAM (RSS) counts shared memory more than once.
    const rest = j.mb - j.apps;
    if (j.apps <= 0) lines.push(t('report.pm_sys_jump_not_apps', { apps: signed(j.apps) }));
    else if (rest >= OUTSIDE_MIN) lines.push(t('report.pm_sys_jump_outside', { apps: signed(j.apps), rest: Math.round(rest) }));
    else lines.push(t('report.pm_sys_jump_apps', { apps: signed(j.apps) }));
  }
  return lines;
}

// Processes outside the apps that changed between the last two hourly checks.
function processLine(before, t) {
  const list = processChanges(before && before.sys, before && before.sysPrev).slice(0, 3);
  if (!list.length) return null;
  return t('report.pm_procs', {
    list: list.map(p => `${p.id === 'homey' ? t('report.proc_homey') : p.name} ${signed(p.change / MB)} MB`).join(', '),
  });
}

function signed(n) {
  return `${n >= 0 ? '+' : '−'}${Math.round(Math.abs(n))}`;
}

function postmortemLine(pm, t, fmt) {
  if (!pm) return null;
  if (pm.unavailable) return t('report.pm_unavailable');
  const lines = [];
  if (pm.quietAt) lines.push(t('report.pm_quiet', { time: clock(pm.quietAt, fmt) }));
  if (pm.sysJump) lines.push(...sysJumpLines(pm.sysJump, t, fmt));
  if (!pm.findings.length) lines.push(t('report.pm_none', { n: pm.checked, min: pm.windowMin }));
  else lines.push(t('report.pm_findings', { min: pm.windowMin, list: pm.findings.map(f => `\n– ${findingText(f, t)}`).join('') }));
  if (pm.together) lines.push(t('report.pm_together', { n: pm.together.n, time: clock(pm.together.at, fmt) }));
  return lines.join('\n');
}

function scheduledLine(list, t) {
  if (!list) return null;
  if (!list.length) return t('report.sched_none');
  const items = list.slice(0, 5).map(s => (s.when
    ? `${s.flow} (${s.when})`
    : `${s.flow} (${t(s.unit === 'hour' ? 'report.every_hours' : 'report.every_minutes', { n: s.every })})`));
  return t('report.sched_near', { list: items.join(', ') });
}

function recurringLine(groups, t) {
  const items = (groups || []).map(g => t(g.kind === 'boot' ? 'report.recurring_boot' : 'report.recurring_crash', {
    n: g.n,
    time: g.from === g.to ? hhmm(g.from) : `${hhmm(g.from)}–${hhmm(g.to)}`,
    apps: g.names.join(', '),
  }));
  return items.length ? items.join(' ') : null;
}

function linkLine(links, t) {
  const apps = ((links && links.apps) || []).filter(a => a.boots >= 2).slice(0, 3);
  if (!apps.length) return null;
  return apps.map(a => t('report.crash_link', { app: a.name || a.id, n: a.boots, total: links.total })).join(' ');
}

function eventText(e, t, fmt) {
  switch (e.type) {
    case 'homey_restarted': {
      const lines = [t('report.homey_restarted', {
        time:   fmt(e.bootDate),
        reason: e.rebootReason || t('report.unknown'),
        uptime: duration(e.prevUptimeMs, t),
      })];
      if (e.rebootReason !== 'reboot') lines.push(blindLine(e, t, fmt));
      lines.push(suspectLine(e.suspects || [], t));
      lines.push(postmortemLine(e.postmortem, t, fmt));
      if (e.rebootReason !== 'reboot') lines.push(processLine(e.before, t));
      lines.push(scheduledLine(e.scheduled, t));
      if (e.unplanned7d >= 2) lines.push(t('report.unplanned_7d', { n: e.unplanned7d }));
      lines.push(recurringLine(e.recurring, t));
      lines.push(linkLine(e.crashLinks, t));
      return lines.filter(Boolean).join('\n');
    }
    case 'homey_version_changed':
      return t('report.homey_version_changed', { from: e.from, to: e.to });
    case 'firmware_available':
      return t('report.firmware_available', { version: e.version });
    case 'app_crashed': {
      let text = t('report.app_crashed', { app: appLabel(e), n: e.delta, total: e.last24h });
      if (Number.isFinite(e.pss)) text += ' ' + t('report.memory_before', { pss: mb(e.pss) });
      if (e.noMessage) text += ' ' + t('report.killed_hint');
      if (e.times && e.times.length) {
        const shown = e.times.slice(-5).map(x => clock(x, fmt)).join(', ');
        text += ' ' + t('report.crash_times', { list: shown });
      }
      return text;
    }
    case 'app_disabled':
      return t('report.app_disabled', { app: appLabel(e) });
    case 'app_not_running':
      return t('report.app_not_running', { app: appLabel(e), state: e.state });
    case 'app_version_changed':
      return t('report.app_version_changed', { app: e.name || e.id, from: e.from, to: e.to });
    case 'app_update_available':
      return t('report.app_update_available', { app: appLabel(e), update: e.update });
    default:
      return null;
  }
}

function dailySummary(s, t, fmt) {
  const lines = [t('report.daily_title', { version: s.homeyVersion, since: fmt(s.bootDate), reason: s.rebootReason || t('report.unknown') })];
  if (s.restarts24h) lines.push(t('report.daily_restarts', { n: s.restarts24h }));
  lines.push(suspectLine(s.topCrashers, t, 'report.daily_no_crashes'));
  if (s.updates.length) lines.push(t('report.daily_updates', { list: s.updates.map(u => `${u.name} ${u.version}→${u.update}`).join(', ') }));
  if (s.firmware) lines.push(t('report.firmware_available', { version: s.firmware }));
  if (s.memory && s.memory.count) {
    const top = s.memory.top.map(m => {
      const change = Number.isFinite(m.change) && Math.abs(m.change) >= 2 * MB
        ? ` (${m.change > 0 ? '+' : '−'}${mb(Math.abs(m.change))})` : '';
      return `${m.name} ${mb(m.pss)}${change}`;
    });
    lines.push(t('report.daily_memory', { n: s.memory.count, list: top.join(', ') }));
  }
  if (s.sys && Number.isFinite(s.sys.free)) {
    lines.push(t('report.daily_system', {
      free: mb(s.sys.free),
      swap: Number.isFinite(s.sys.swap) ? mb(s.sys.swap) : '?',
      core: Number.isFinite(s.sys.core) ? mb(s.sys.core) : '?',
    }));
  }
  const rec = recurringLine(s.recurring, t);
  if (rec) lines.push(rec);
  if (s.self && Number.isFinite(s.self.pss)) lines.push(t('report.daily_self', { pss: mb(s.self.pss) }));
  return lines.join('\n');
}

module.exports = { eventText, dailySummary, duration, postmortemLine };
