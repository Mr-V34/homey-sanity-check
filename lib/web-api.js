'use strict';

// ── Read-only Web API client ──────────────────────────────────────────────────
// Replaces the homey-api module to keep the app's own memory (PSS) small.
// homey-api's createAppAPI only fetches an owner token and the local URL from
// the SDK and then does plain HTTP, so we do the same with Node's own http
// module. Only GET exists here: this client
// cannot change anything on Homey.

const PATHS = {
  getInfo:       '/api/manager/system/',
  getMemoryInfo: '/api/manager/system/memory',
  getApps:       '/api/manager/apps/app',
  getUpdates:    '/api/manager/updates/update',
  getFlows:         '/api/manager/flow/flow',
  getAdvancedFlows: '/api/manager/flow/advancedflow',
  // Once a day, for the daily summary.
  getBackupLast:    '/api/manager/backup/option/lastSuccessfulBackup',
  getBackupAuto:    '/api/manager/backup/option/automaticBackupsEnabled',
  getUpdateChannel: '/api/manager/updates/option/channel',
  getUpdateAuto:    '/api/manager/updates/option/autoupdate',
  getStorageInfo:   '/api/manager/system/storage',
};

const TIMEOUT = 30 * 1000;

// node:http instead of fetch: fetch loads undici, which kept PSS at 35 MB
// after a check; with node:http it stays at 24 MB (measured 2026-10-13).
function request(url, token) {
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class ReadOnlyApi {

  constructor(homey) {
    this._homey = homey;
    this._token = null;
    this._baseUrl = null;
    for (const [name, path] of Object.entries(PATHS)) this[name] = () => this._get(path);
  }

  // Memory of one app, including the part in swap (usage.mem.pssSwap).
  getAppUsage(id) {
    return this._get(`/api/manager/apps/app/${encodeURIComponent(id)}/usage`);
  }

  // Insights entries, e.g. ('homey:manager:apps', 'homey:manager:apps:<id>-mem', 'last6Hours').
  getLogEntries(uri, id, resolution) {
    const q = resolution ? `?resolution=${encodeURIComponent(resolution)}` : '';
    return this._get(`/api/manager/insights/log/${encodeURIComponent(uri)}/${encodeURIComponent(id)}/entry${q}`);
  }

  async _auth(refresh = false) {
    if (refresh || !this._token) {
      this._token = await this._homey.api.getOwnerApiToken();
      this._baseUrl = (await this._homey.api.getLocalUrl()).replace(/\/$/, '');
    }
  }

  async _get(path, retried = false) {
    await this._auth();
    const { status, body } = await request(`${this._baseUrl}${path}`, this._token);
    if (status === 401 && !retried) {
      await this._auth(true);
      return this._get(path, true);
    }
    if (status < 200 || status >= 300) throw new Error(`GET ${path}: HTTP ${status}`);
    return JSON.parse(body);
  }

}

module.exports = { ReadOnlyApi };
