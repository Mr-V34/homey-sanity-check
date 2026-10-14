'use strict';

// ── Report texts ──────────────────────────────────────────────────────────────
// Turns check events into short timeline lines. `t(key, tokens)` is
// homey.__ and `fmt` formats dates in Homey's timezone. Wording is deliberately
// "indication, not proof": we report coincidence, never cause.

const { HOUR, MB } = require('./checks');

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
  return `${f.name || f.id} ${parts.join(', ')}`;
}

function signed(n) {
  return `${n >= 0 ? '+' : '−'}${Math.round(Math.abs(n))}`;
}

function postmortemLine(pm, t, fmt) {
  if (!pm) return null;
  if (pm.unavailable) return t('report.pm_unavailable');
  const lines = [];
  if (pm.quietAt) lines.push(t('report.pm_quiet', { time: clock(pm.quietAt, fmt) }));
  if (pm.sysJump) lines.push(t('report.pm_sys_jump', { mb: pm.sysJump.mb, time: clock(pm.sysJump.at, fmt) }));
  if (!pm.findings.length) lines.push(t('report.pm_none', { n: pm.checked, min: pm.windowMin }));
  else lines.push(t('report.pm_findings', { min: pm.windowMin, list: pm.findings.map(f => findingText(f, t)).join('; ') }));
  if (pm.together) lines.push(t('report.pm_together', { n: pm.together.n, time: clock(pm.together.at, fmt) }));
  return lines.join(' ');
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
      if (e.unplanned7d >= 2) lines.push(t('report.unplanned_7d', { n: e.unplanned7d }));
      return lines.filter(Boolean).join(' ');
    }
    case 'homey_version_changed':
      return t('report.homey_version_changed', { from: e.from, to: e.to });
    case 'firmware_available':
      return t('report.firmware_available', { version: e.version });
    case 'app_crashed': {
      let text = t('report.app_crashed', { app: appLabel(e), n: e.delta, total: e.last24h });
      if (Number.isFinite(e.pss)) text += ' ' + t('report.memory_before', { pss: mb(e.pss) });
      if (e.noMessage) text += ' ' + t('report.killed_hint');
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
    case 'sensor_silent':
      return t('report.sensor_silent', { name: e.name, zone: e.zoneName || '-', age: duration(e.ageMs, t) });
    case 'sensor_back':
      return t('report.sensor_back', { name: e.name, zone: e.zoneName || '-' });
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
  if (s.silent && s.silent.length) {
    const shown = s.silent.slice(0, 10).map(d => `${d.name} (${d.zoneName || '-'}, ${duration(d.ageMs, t)})`);
    const more = s.silent.length > 10 ? ` ${t('report.and_more', { n: s.silent.length - 10 })}` : '';
    lines.push(t('report.daily_silent_list', { n: s.silent.length, list: shown.join(', ') }) + more);
  } else {
    lines.push(t('report.daily_silent', { n: 0 }));
  }
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
  if (s.self && Number.isFinite(s.self.pss)) lines.push(t('report.daily_self', { pss: mb(s.self.pss) }));
  return lines.join('\n');
}

module.exports = { eventText, dailySummary, duration, postmortemLine };
