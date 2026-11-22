import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const DAY_MS = 24 * 60 * 60 * 1000;

export class RequestError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function tvdbClient({
  api_key, pin, cachePath = ':memory:', baseUrl = 'https://api4.thetvdb.com/v4',
  now = Date.now, spacingMs = 250,
}) {
  const db = new DatabaseSync(cachePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS responses (
      path TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS response_expiry ON responses (expires_at);
  `);
  const read = db.prepare('SELECT payload FROM responses WHERE path = ? AND expires_at > ?');
  const write = db.prepare(`
    INSERT INTO responses (path, expires_at, payload) VALUES (?, ?, ?)
    ON CONFLICT (path) DO UPDATE SET expires_at = excluded.expires_at, payload = excluded.payload
  `);
  const expire = db.prepare('DELETE FROM responses WHERE expires_at <= ?');
  const cacheCounts = db.prepare(`
    WITH fresh AS (SELECT path, payload FROM responses WHERE expires_at > ?),
    episode_ids AS (
      SELECT json_extract(payload, '$.id') AS id
      FROM fresh WHERE path GLOB '/episodes/[0-9]*/extended'
      UNION
      SELECT json_extract(episode.value, '$.id') AS id
      FROM fresh, json_each(fresh.payload, '$.episodes') AS episode
      WHERE fresh.path GLOB '/seasons/[0-9]*/extended'
    )
    SELECT
      (SELECT COUNT(*) FROM fresh WHERE path GLOB '/series/[0-9]*/extended') AS cachedShows,
      (SELECT COUNT(id) FROM episode_ids) AS cachedEpisodes
  `);
  const inFlight = new Map();
  let nextPrune = 0;
  let authorization;
  let tokenExpires = 0;
  let login;
  let nextStart = Promise.resolve();
  let backoffUntil = 0;

  async function request(path, options) {
    const scheduled = nextStart;
    nextStart = scheduled.then(() => sleep(spacingMs));
    await scheduled;
    const remaining = () => Math.max(1, Math.ceil((backoffUntil - now()) / 1000));
    if (backoffUntil > now()) {
      throw new RequestError(503, 'TVDB rate limit reached', remaining());
    }
    const response = await fetch(baseUrl + path, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(12000),
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) : (Date.parse(retryAfter) - now()) / 1000;
      backoffUntil = Math.max(backoffUntil, now() + 1000 * Math.max(1, Math.min(3600,
        Number.isFinite(seconds) ? seconds : 30)));
      throw new RequestError(503, 'TVDB rate limit reached', remaining());
    }
    return response;
  }

  async function token() {
    if (authorization && now() < tokenExpires) return authorization;
    login ??= (async () => {
      const response = await request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: api_key, ...(pin ? { pin } : {}) }),
      });
      if (!response.ok) throw new RequestError(502, `TVDB authentication returned HTTP ${response.status}`);
      const value = (await response.json()).data?.token;
      if (typeof value !== 'string' || !value) {
        throw new RequestError(502, 'TVDB authentication returned no token');
      }
      authorization = value;
      tokenExpires = now() + DAY_MS;
      return value;
    })().finally(() => { login = undefined; });
    return login;
  }

  async function fetchMetadata(path) {
    let used = await token();
    let response = await request(path, { headers: { Authorization: 'Bearer ' + used } });
    if (response.status === 401) {
      if (authorization === used) authorization = undefined;
      used = await token();
      response = await request(path, { headers: { Authorization: 'Bearer ' + used } });
    }
    if (response.status === 404) throw new RequestError(404, 'TVDB item not found');
    if (!response.ok) throw new RequestError(502, `TVDB metadata returned HTTP ${response.status}`);
    const data = (await response.json()).data;
    if (!data || typeof data !== 'object') throw new RequestError(502, 'TVDB returned an invalid result');
    const fetchedAt = now();
    if (fetchedAt >= nextPrune) {
      expire.run(fetchedAt);
      nextPrune = fetchedAt + 60 * 60 * 1000;
    }
    write.run(path, fetchedAt + DAY_MS, JSON.stringify(data));
    return data;
  }

  async function get(path) {
    const cached = read.get(path, now());
    if (cached) return JSON.parse(cached.payload);
    if (!inFlight.has(path)) {
      inFlight.set(path, fetchMetadata(path).finally(() => inFlight.delete(path)));
    }
    return inFlight.get(path);
  }
  get.close = () => db.close();
  get.cacheCounts = () => cacheCounts.get(now());
  return get;
}
