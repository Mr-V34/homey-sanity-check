'use strict';

// ── Report texts ──────────────────────────────────────────────────────────────
// Turns check events into short timeline lines. `t(key, tokens)` is
// homey.__ and `fmt` formats dates in Homey's timezone. Wording is deliberately
// "indication, not proof": we report coincidence, never cause. A restart report
// puts each part on its own line so it reads well on the timeline.

const {
  HOUR, MB, PSS_GUIDELINE, SWAP_APP_HIGH, processChanges, isUnplanned,
} = require('./checks');
const { UNEXPECTED_REASON } = require('./constants');

// What the apps must leave unexplained of a system jump before we say the rest
// came from outside them (MB).
const OUTSIDE_MIN = 10;
const { hhmm } = require('./patterns');
const { verdict } = require('./verdict');

function duration(ms, t) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return t('report.unknown');
  const h = Math.floor(ms / HOUR);
  if (h >= 48) return t('report.days', { n: Math.floor(h / 24) });
  if (h >= 1) return t('report.hours', { n: h });
  return t('report.minutes', { n: Math.max(1, Math.round(ms / 60000)) });
}

// Homey's rebootReason in plain words; an unknown value is shown as it is.
const REASON_KEYS = {
  reboot: 'report.reason_reboot',
  'reboot-ota': 'report.reason_ota',
  unexpected: 'report.reason_unexpected',
};

function reasonText(reason, t) {
  if (!reason) return t('report.unknown');
  return REASON_KEYS[reason] ? t(REASON_KEYS[reason]) : reason;
}

function mb(bytes) {
  return `${Math.round(bytes / MB)} MB`;
}

function appLabel(a) {
  return `${a.name || a.id} v${a.version}`;
}

function suspectLine(list, t, noneKey = 'report.no_suspects', listKey = 'report.suspects', showUpdate = true) {
  if (!list.length) return t(noneKey);
  return t(listKey, {
    list: list.map(s => {
      const parts = [t(s.crashes === 1 ? 'report.crash_once' : 'report.crash_item', { app: appLabel(s), n: s.crashes })];
      if (Number.isFinite(s.pss)) parts.push(t('report.crash_mem', { pss: mb(s.pss) }));
      if (s.noMessage) parts.push(t('report.no_message'));
      if (s.update && showUpdate) parts.push(t('report.crash_update', { update: s.update }));
      return parts.join(', ');
    }).join('; '),
  });
}

// "Try updating first", and a gentle note for apps updated by hand: manual
// updates can be the user's own choice.
function updateAdvice(up, t) {
  if (!up.length) return '';
  const parts = [t('report.adv_update', { list: up.map(u => `${u.name} ${u.update}`).join(', ') })];
  const manual = up.filter(u => u.auto === false);
  if (manual.length) parts.push(t('report.adv_auto_off', { list: manual.map(u => u.name).join(', ') }));
  return parts.join(' ');
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

// Sanity Check is ranked like any other app. Its own line adds the facts a
// reader needs to judge it: when it last ran a check and its CPU in the window.
function findingText(f, t, fmt, lastCheck) {
  const parts = [];
  if (f.flags.includes('ram_grew') || f.flags.includes('ram_dropped')) {
    parts.push(t('report.pm_ram', { from: Math.round(f.ramStart), to: Math.round(f.ramEnd), change: signed(f.ramChange) }));
  } else if (f.flags.includes('ram_jump')) {
    parts.push(t('report.pm_ram_jump', { change: signed(f.ramStep) }));
  }
  if (f.flags.includes('cpu')) parts.push(t('report.pm_cpu', { avg: Math.round(f.cpuAvg), max: Math.round(f.cpuMax) }));
  let name = f.name || f.id;
  if (f.self && lastCheck && Number.isFinite(f.cpuAvg)) {
    name = t('report.self_label_ctx', { name, time: clock(lastCheck, fmt), cpu: Math.round(f.cpuAvg) });
  } else if (f.self) {
    name = t('report.self_label', { name });
  }
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

// Apps with the most memory in swap, read when swap was high (see swapApps).
function swapLine(sw, t, fmt) {
  if (!sw || !sw.top || !sw.top.length) return null;
  return t('report.swap_apps', {
    time: fmt(sw.t),
    swap: mb(sw.swap),
    list: sw.top.map(a => `${a.name} ${mb(a.swap)}`).join(', '),
  });
}

function gb(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function backupLine(b, t, fmt) {
  if (!b) return null;
  const date = b.last != null ? fmt(b.last).split(' ')[0] : null;
  if (date == null) return t('report.backup_none');
  if (b.overdue) return t('report.backup_overdue', { date, n: b.days });
  if (b.auto === false) return t('report.backup_off', { date });
  return t('report.backup_ok', { date });
}

function signed(n) {
  return `${n >= 0 ? '+' : '−'}${Math.round(Math.abs(n))}`;
}

function postmortemLine(pm, t, fmt, lastCheck) {
  if (!pm) return null;
  if (pm.unavailable) return t('report.pm_unavailable');
  const lines = [];
  if (pm.quietAt) lines.push(t('report.pm_quiet', { time: clock(pm.quietAt, fmt) }));
  if (pm.sysJump) lines.push(...sysJumpLines(pm.sysJump, t, fmt));
  if (!pm.findings.length) lines.push(t('report.pm_none', { n: pm.checked, min: pm.windowMin }));
  else lines.push(t('report.pm_findings', { min: pm.windowMin, list: pm.findings.map(f => `\n– ${findingText(f, t, fmt, lastCheck)}`).join('') }));
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

// Restarts that stopped or started around changes (patterns.changeLink).
const CHANGES_SHOWN = 5;

function changeList(changes, t) {
  const items = changes.slice(0, CHANGES_SHOWN).map(c => t(`report.change_${c.what}`, { name: c.name || c.id, to: c.to }));
  if (changes.length > CHANGES_SHOWN) items.push(t('report.change_more', { n: changes.length - CHANGES_SHOWN }));
  return items.join(', ');
}

function changeLinkLine(link, t, fmt) {
  if (!link) return null;
  if (link.kind === 'stopped') {
    return t('report.link_stopped', {
      quiet: duration(link.quiet, t), n: link.n, span: duration(link.last - link.from, t), list: changeList(link.changes, t),
    });
  }
  return t('report.link_started', { when: fmt(link.from), n: link.n, list: changeList(link.changes, t) });
}

function linkLine(links, t) {
  const apps = ((links && links.apps) || []).filter(a => a.boots >= 2).slice(0, 3);
  if (!apps.length) return null;
  return apps.map(a => t('report.crash_link', { app: a.name || a.id, n: a.boots, total: links.total })).join(' ');
}

// The advisory verdict as a short checklist: one bold conclusion, one line per
// check (✓ fine, ⚠ points at a cause, – no data) and one piece of advice.
// The timeline shows plain text; **double asterisks** highlight (SDK docs).
function verdictLines(e, t, fmt) {
  const v = verdict(e);
  const mark = c => (c.known === false ? '–' : c.bad ? '⚠' : '✓');
  const [crashes, apps, power, heat, load] = v.checks;
  const lines = [t(`report.v_cause_${v.cause}`, { app: v.app || '' })];
  lines.push(`${mark(crashes)} ${crashes.bad
    ? t('report.v_crashes_bad', { n: crashes.n, app: crashes.app })
    : t('report.v_crashes_ok')}`);
  lines.push(`${mark(apps)} ${apps.known === false ? t('report.v_apps_none')
    : apps.bad ? t('report.v_apps_bad', { app: apps.app }) : t('report.v_apps_ok')}`);
  lines.push(`${mark(power)} ${!power.known ? t('report.v_power_none')
    : power.bad ? t('report.v_power_bad') : t('report.v_power_ok')}`);
  lines.push(`${mark(heat)} ${!heat.known ? t('report.v_heat_none')
    : heat.flag ? t('report.v_heat_flag')
    : t('report.v_heat', { max: Math.round(heat.max), normal: heat.normal != null ? Math.round(heat.normal) : '?' })}`);
  lines.push(`${mark(load)} ${!load.known ? t('report.v_load_none')
    : t('report.v_load', { avg: Math.round(load.avg), normal: load.normal != null ? Math.round(load.normal) : '?' })}`);
  const core = [];
  if (v.core.jump) core.push(t('report.v_core_jump', { mb: v.core.jump.mb, time: clock(v.core.jump.at, fmt) }));
  if (v.core.swapMb != null) core.push(t('report.v_core_swap', { mb: v.core.swapMb }));
  if (core.length) lines.push(`${v.core.bad ? '⚠' : '✓'} ${t('report.v_core', { list: core.join(', ') })}`);
  // Only a restart Homey itself calls unexpected is worth a support ticket.
  // An unknown reason may be something planned that we haven't seen yet.
  const advice = v.cause === 'homey' && e.rebootReason !== UNEXPECTED_REASON ? 'homey_reason' : v.cause;
  lines.push(t(`report.v_advice_${advice}`, { app: v.app || '', reason: e.rebootReason || t('report.unknown') }));
  return lines;
}

function eventText(e, t, fmt) {
  switch (e.type) {
    case 'homey_restarted': {
      const lines = [t('report.homey_restarted', {
        time:   fmt(e.bootDate),
        reason: reasonText(e.rebootReason, t),
        uptime: duration(e.prevUptimeMs, t),
      })];
      const unplanned = isUnplanned(e);
      if (unplanned && e.postmortem) {
        lines.push(...verdictLines(e, t, fmt), t('report.v_details'));
      }
      if (unplanned) lines.push(blindLine(e, t, fmt));
      // The verdict already says "no app crashes"; only list them when there are some.
      const withVerdict = unplanned && e.postmortem;
      if (!withVerdict || (e.suspects || []).length) lines.push(suspectLine(e.suspects || [], t));
      lines.push(postmortemLine(e.postmortem, t, fmt, e.before && e.before.lastCheck));
      if (unplanned) lines.push(processLine(e.before, t), swapLine(e.before && e.before.swapApps, t, fmt));
      lines.push(scheduledLine(e.scheduled, t));
      if (e.unplanned7d >= 2) lines.push(t('report.unplanned_7d', { n: e.unplanned7d }));
      lines.push(recurringLine(e.recurring, t));
      lines.push(linkLine(e.crashLinks, t));
      return lines.filter(Boolean).join('\n');
    }
    case 'hw_flag':
      return t(`report.hw_${e.flag}`);
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

// The daily summary only shows what needs attention: findings (⚠) first,
// then a few things to act on. When nothing stands out it is one line.
// Every finding ends with advice: a ⚠ the user can do nothing about is noise.
// detail 'full' adds everything that was measured, findings or not.
function dailySummary(s, t, fmt, detail = 'short') {
  const title = t('report.daily_title', { version: s.homeyVersion, since: fmt(s.bootDate), reason: reasonText(s.rebootReason, t) });
  // An app with a problem and a newer version: updating is the first thing to
  // try, so that app goes first in its list and its finding moves up.
  const updates = Object.fromEntries((s.updates || []).filter(u => u.id).map(u => [u.id, u]));
  const hasUpdate = a => Boolean(updates[a.id]);
  const updateFirst = list => [...list].sort((x, y) => hasUpdate(y) - hasUpdate(x));
  const advised = new Set();
  const warn = [];
  const add = (text, advice, apps = []) => {
    const up = apps.filter(hasUpdate).map(a => updates[a.id]);
    up.forEach(u => advised.add(u.id));
    warn.push({ up: up.length > 0, text: [text, updateAdvice(up, t), advice && t(advice)].filter(Boolean).join(' ') });
  };
  if (s.topCrashers.length) {
    const list = updateFirst(s.topCrashers);
    add(suspectLine(list, t, null, 'report.daily_crashes', false), 'report.adv_crashes', list); // update is in the advice
  }
  if (s.grew && s.grew.length) {
    const list = updateFirst(s.grew);
    add(t('report.daily_grew', {
      days: list[0].days,
      list: list.map(g => t('report.grew_item', { name: g.name, change: mb(g.change), pss: mb(g.pss) })).join('; '),
    }), 'report.adv_grew', list);
  }
  const swapped = updateFirst(((s.swapApps && s.swapApps.top) || []).filter(a => a.swap >= SWAP_APP_HIGH));
  if (swapped.length) add(t('report.daily_swap_app', { list: swapped.map(a => `${a.name} ${mb(a.swap)}`).join(', ') }), 'report.adv_swap', swapped);
  if (s.storage && s.storage.low) add(t('report.daily_storage', { free: gb(s.storage.free), total: gb(s.storage.total) }), 'report.adv_storage');
  if (s.backup && s.backup.overdue && !s.backup.repeat) add(backupLine(s.backup, t, fmt)); // advice is in the text
  const rec = recurringLine(s.recurring, t);
  if (rec) add(rec, 'report.adv_recurring');
  if (s.link && s.link.kind === 'started') add(changeLinkLine(s.link, t, fmt), 'report.adv_link_started');
  if (s.self && Number.isFinite(s.self.pss) && s.self.pss > PSS_GUIDELINE) add(t('report.daily_self', { pss: mb(s.self.pss) }), 'report.adv_self');

  const info = [];
  const rest = s.updates.filter(u => !advised.has(u.id)); // the rest were already advised above
  if (rest.length) {
    info.push(t('report.daily_updates', {
      list: rest.map(u => t(u.auto === false ? 'report.update_manual' : 'report.update_item',
        { name: u.name, from: u.version, to: u.update })).join(', '),
    }));
  }
  if (s.firmware) info.push(t('report.firmware_available', { version: s.firmware }));
  // Good news is said once per quiet spell, but always in the detailed view.
  if (s.link && s.link.kind === 'stopped' && (!s.link.said || detail === 'full')) {
    info.push(`${changeLinkLine(s.link, t, fmt)} ${t('report.adv_link_stopped')}`);
  }
  if (s.firmwareCfg && s.firmwareCfg.channel && s.firmwareCfg.channel !== 'stable') {
    info.push(t('report.daily_channel', { channel: s.firmwareCfg.channel }));
  }

  const head = `${title} ${warn.length || s.unplanned24h ? t('report.daily_attention') : t('report.daily_ok')}`;
  // Unexpected restarts stay on top; then findings with an update to try.
  const ordered = [...warn.filter(w => w.up), ...warn.filter(w => !w.up)];
  if (s.unplanned24h) ordered.unshift({ text: `${t('report.daily_unplanned', { n: s.unplanned24h })} ${t('report.adv_unplanned')}` });
  const lines = [head, ...ordered.map(w => `⚠ ${w.text}`), ...info];
  if (detail === 'full') lines.push(t('report.v_details'), ...fullLines(s, t, fmt));
  return lines.join('\n');
}

// Everything the summary measured, for those who want to see it all.
function fullLines(s, t, fmt) {
  const lines = [t('report.daily_restarts', { n: s.restarts24h || 0, unplanned: s.unplanned24h || 0 })];
  if (!s.topCrashers.length) lines.push(t('report.daily_no_crashes'));
  if (s.largest && s.largest.length) {
    lines.push(t('report.daily_largest', {
      list: s.largest.map(m => {
        if (!Number.isFinite(m.change) || Math.abs(m.change) < 2 * MB) return `${m.name} ${mb(m.pss)}`;
        return t(m.change > 0 ? 'report.largest_more' : 'report.largest_less',
          { name: m.name, pss: mb(m.pss), change: mb(Math.abs(m.change)) });
      }).join('; '),
    }));
  }
  if (s.sys && Number.isFinite(s.sys.free)) {
    lines.push(t('report.daily_system', {
      free: mb(s.sys.free),
      swap: Number.isFinite(s.sys.swap) ? mb(s.sys.swap) : '?',
      core: Number.isFinite(s.sys.core) ? mb(s.sys.core) : '?',
    }));
  }
  if (s.swapApps) lines.push(swapLine(s.swapApps, t, fmt));
  if (s.storage) lines.push(t('report.daily_storage', { free: gb(s.storage.free), total: gb(s.storage.total) }));
  if (s.backup) lines.push(backupLine(s.backup, t, fmt));
  if (s.firmwareCfg) {
    lines.push(t('report.daily_firmware', {
      channel: s.firmwareCfg.channel || t('report.unknown'),
      auto: t(s.firmwareCfg.auto === true ? 'report.on' : s.firmwareCfg.auto === false ? 'report.off' : 'report.unknown'),
    }));
  }
  if (s.self && Number.isFinite(s.self.pss)) lines.push(t('report.daily_self', { pss: mb(s.self.pss) }));
  return lines;
}

module.exports = { eventText, dailySummary, duration, postmortemLine, backupLine };
