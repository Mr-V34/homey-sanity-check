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

function suspectLine(list, t) {
  if (!list.length) return t('report.no_suspects');
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

function eventText(e, t, fmt) {
  switch (e.type) {
    case 'homey_restarted':
      return t('report.homey_restarted', {
        time:   fmt(e.bootDate),
        reason: e.rebootReason || t('report.unknown'),
        uptime: duration(e.prevUptimeMs, t),
      }) + ' ' + suspectLine(e.suspects || [], t);
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
  lines.push(suspectLine(s.topCrashers, t));
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
  if (s.self && Number.isFinite(s.self.pss)) lines.push(t('report.daily_self', { pss: mb(s.self.pss) }));
  return lines.join('\n');
}

module.exports = { eventText, dailySummary, duration };
