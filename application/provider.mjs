import { createServer } from 'node:http';
import { RequestError, tvdbClient } from './tvdb.mjs';

const identifier = 'tv.plex.agents.custom.plextvdbprovider.tvdb';
const metadataPath = '/library/metadata';
const kinds = { 2: 'show', 3: 'season', 4: 'episode' };

/** Validates a Plex season, episode, or paging number. */
const coordinates = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Validates a positive TheTVDB numeric ID. */
const numericId = (value) => /^[1-9][0-9]{0,14}$/.test(String(value));
/** Normalizes a title or alias for exact comparison after ignoring punctuation. */
const normalize = (name) => String(name || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Builds the Plex rating key from the item type and TheTVDB ID. */
const itemKey = (type, id) => `${type}-${id}`;
/** Builds a stable Plex GUID within this provider’s namespace. */
const guid = (type, id) => `${identifier}://${type}/${itemKey(type, id)}`;

/** Extracts the base language requested by Plex, such as fr from fr-CA. */
function languageCode(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new Intl.Locale(value).language;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/** Builds the external GUID list that Plex and sync tools can use to identify an item. */
function externalIds(record) {
  const ids = new Set([`tvdb://${record.id}`]);
  for (const remote of record.remoteIds || []) {
    const provider = String(remote.sourceName).toLowerCase();
    if (provider === 'imdb' && /^tt\d+$/.test(remote.id)) ids.add(`imdb://${remote.id}`);
    if (['themoviedb.com', 'tmdb', 'themoviedb'].includes(provider) && numericId(remote.id)) {
      ids.add(`tmdb://${remote.id}`);
    }
  }
  return [...ids].map((id) => ({ id }));
}

/** Formats the metadata fields and artwork shared by shows, seasons, and episodes. */
function describe(type, record, title, date) {
  if (!numericId(record.id)) throw new RequestError(502, 'TVDB returned an invalid item ID');
  const ratingKey = itemKey(type, record.id);
  return {
    ratingKey, key: `${metadataPath}/${ratingKey}`, guid: guid(type, record.id), type, title,
    originallyAvailableAt: date || '',
    ...(date ? { year: Number(date.slice(0, 4)) } : {}),
    ...(record.originalTitle ? { originalTitle: record.originalTitle } : {}),
    summary: [record.overview, 'Metadata provided by TheTVDB\nhttps://thetvdb.com/'].filter(Boolean).join('\n\n'),
    ...(record.image ? {
      thumb: record.image,
      Image: [{ type: type === 'episode' ? 'snapshot' : 'coverPoster', url: record.image }],
    } : {}),
    Guid: externalIds(record),
  };
}

/** Formats the Plex parent or grandparent reference for an item. */
function ancestor(type, item, prefix) {
  return {
    [`${prefix}Type`]: type,
    [`${prefix}RatingKey`]: item.ratingKey,
    [`${prefix}Key`]: item.key,
    [`${prefix}Guid`]: item.guid,
    [`${prefix}Title`]: item.title,
  };
}

/** Wraps a list of metadata items in Plex’s paginated response format. */
function envelope(items, offset = 0, totalSize = items.length) {
  return { MediaContainer: { identifier, offset, size: items.length, totalSize, Metadata: items } };
}

/** Selects the official airing-order seasons, including season zero for specials. */
function airedSeasons(series) {
  return (series.seasons || []).filter((season) =>
    numericId(season.id) && coordinates(season.number) && ['official', 'default'].includes(season.type?.type)
  ).sort((a, b) => a.number - b.number);
}

/** Formats a show and advertises TheTVDB Aired ordering. */
function showItem(series) {
  return {
    ...describe('show', series, series.name, series.firstAired),
    SeasonType: [{ id: 'official', source: 'tvdb', tag: 'Airing Order', title: 'TheTVDB (Aired)' }],
  };
}

/** Formats a season with its number and parent show. */
function seasonItem(series, season) {
  return {
    ...describe('season', season, season.name || (season.number === 0 ? 'Specials' : `Season ${season.number}`), ''),
    ...ancestor('show', showItem(series), 'parent'),
    index: season.number,
  };
}

/** Formats an episode with its season number, ancestry, and runtime in milliseconds. */
function episodeItem(series, season, episode) {
  return {
    ...describe('episode', episode, episode.name || `Episode ${episode.number}`, episode.aired),
    ...ancestor('season', seasonItem(series, season), 'parent'),
    ...ancestor('show', showItem(series), 'grandparent'),
    index: episode.number,
    parentIndex: season.number,
    ...(episode.runtime ? { duration: episode.runtime * 60000 } : {}),
  };
}

/** Embeds child metadata in an item for Plex requests that ask for it. */
function withChildren(item, items) {
  return { ...item, Children: { size: items.length, Metadata: items } };
}

/** Parses a bounded Plex match request and reports malformed bodies as client errors. */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new RequestError(413, 'Match request too large');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch {
    throw new RequestError(400, 'Invalid match request');
  }
}

/** Creates an unstarted Plex HTTP provider using the supplied TheTVDB client settings. */
export function createProvider(config) {
  const tvdb = tvdbClient(config);
  /** Fetches a show and applies the requested translation when TheTVDB has it. */
  async function series(id, language) {
    const record = await tvdb(`/series/${id}/extended`);
    if (!language || languageCode(record.originalLanguage) === language) return record;
    const available = [...(record.nameTranslations || []), ...(record.overviewTranslations || [])];
    const code = available.find((value) => /^[a-z]{3}$/.test(value) && languageCode(value) === language);
    if (!code) return record;
    try {
      const translation = await tvdb(`/series/${id}/translations/${code}`);
      const name = translation.name || record.name;
      return { ...record, name, overview: translation.overview || record.overview,
        ...(name !== record.name ? { originalTitle: record.name } : {}) };
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      if (error.status !== 404) console.warn('TVDB series translation unavailable', id, code, error.status);
      return record;
    }
  }
  /** Fetches the extended season record, including its episodes. */
  const season = (id) => tvdb(`/seasons/${id}/extended`);
  /** Reads a season’s episode list, treating a missing list as empty. */
  const episodes = (s) => Array.isArray(s.episodes) ? s.episodes : [];
  /** Accepts either a JSON boolean or 1 for a Plex include flag. */
  const include = (value) => value === true || String(value) === '1';

  /** Rejects episode orders this provider does not implement. */
  function requireAired(order) {
    if (order && !['default', 'official', 'aired', 'tvdbAiring'].includes(order)) {
      throw new RequestError(404, 'Only TVDB Aired ordering is available');
    }
  }

  /** Loads a known TheTVDB item and its Plex hierarchy. */
  async function load(kind, id, language) {
    if (kind === 'show') {
      const s = await series(id, language);
      return { item: showItem(s), children: airedSeasons(s).map((row) => seasonItem(s, row)), series: s };
    }
    if (kind === 'season') {
      const seasonData = await season(id);
      if (!numericId(seasonData.seriesId)) throw new RequestError(502, 'TVDB season has no series');
      const s = await series(seasonData.seriesId, language);
      const row = airedSeasons(s).find((part) => String(part.id) === id);
      if (!row) throw new RequestError(404, 'TVDB aired season not found');
      return { item: seasonItem(s, row), children: episodes(seasonData).map((e) => episodeItem(s, row, e)) };
    }
    const e = await tvdb(`/episodes/${id}/extended`);
    if (!numericId(e.seriesId)) throw new RequestError(502, 'TVDB episode has no series');
    const s = await series(e.seriesId, language);
    const row = airedSeasons(s).find((part) => part.number === e.seasonNumber);
    if (!row) throw new RequestError(404, 'TVDB aired episode not found');
    return { item: episodeItem(s, row, e), children: [] };
  }

  /** Resolves the show by file ID first, then by title and year when no ID is present. */
  async function findSeries(title, year, manual, file, language) {
    const path = typeof file === 'string' ? file : '';
    const namedId = path.match(/\{tvdb-([1-9][0-9]{0,14})\}/i)?.[1];
    if (namedId) return [await series(namedId, language)];
    const imdbId = path.match(/(?<![\p{L}\p{N}])imdb-(tt[0-9]{1,15})(?![\p{L}\p{N}])/iu)?.[1].toLowerCase();
    if (imdbId) {
      let results;
      try {
        results = await tvdb(`/search/remoteid/${imdbId}`);
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) return [];
        throw error;
      }
      if (!Array.isArray(results)) throw new RequestError(502, 'TVDB external ID lookup has no results array');
      const matches = new Set(results.map((row) => row?.series?.id).filter(numericId).map(String));
      if (matches.size !== 1) return [];
      const [id] = matches;
      return [await series(id, language)];
    }
    title = typeof title === 'string' ? title.trim().slice(0, 220) : '';
    if (!title) return [];
    const query = new URLSearchParams({ query: title, type: 'series' });
    const results = await tvdb('/search?' + query);
    if (!Array.isArray(results)) throw new RequestError(502, 'TVDB search has no results array');
    const wanted = normalize(title);
    const matching = new Map();
    for (const row of results) {
      if (!numericId(row.tvdb_id)) continue;
      if (![row.name, ...(row.aliases || [])].some((name) => normalize(name) === wanted)) continue;
      if (year && row.year && String(year) !== String(row.year)) continue;
      matching.set(String(row.tvdb_id), row);
    }
    if (!manual && matching.size !== 1) return [];
    const picks = matching.size ? matching.keys() : results
      .filter((row) => numericId(row.tvdb_id)).map((row) => String(row.tvdb_id));
    return Promise.all([...new Set(picks)].slice(0, 8).map((id) => series(id, language)));
  }

  /** Translates a Plex match request into candidates for a show, season, or episode. */
  async function match(body, language) {
    const kind = Number.isInteger(body.type) ? kinds[body.type] : undefined;
    if (!kind) throw new RequestError(400, 'Unsupported metadata type');
    requireAired(body.episodeOrder);
    const external = typeof body.guid === 'string' ? body.guid.match(/^tvdb:\/\/([1-9][0-9]{0,14})$/)?.[1] : null;
    if (external) {
      try {
        const found = await load(kind, external, language);
        return envelope([include(body.includeChildren) && kind !== 'episode'
          ? withChildren(found.item, found.children) : found.item]);
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) return envelope([]);
        throw error;
      }
    }
    const manual = include(body.manual);
    const name = { show: body.title, season: body.parentTitle, episode: body.grandparentTitle }[kind];
    const matches = [];
    for (const show of await findSeries(name, kind === 'show' ? body.year : null, manual, body.filename, language)) {
      const seasons = airedSeasons(show);
      if (kind === 'show') {
        const item = showItem(show);
        matches.push(include(body.includeChildren) ? withChildren(item, seasons.map((s) => seasonItem(show, s))) : item);
      } else if (kind === 'season') {
        const row = seasons.find((item) => item.number === body.index);
        if (!row) continue;
        const item = seasonItem(show, row);
        const children = include(body.includeChildren) ? episodes(await season(row.id)).map((e) => episodeItem(show, row, e)) : null;
        matches.push(children ? withChildren(item, children) : item);
      } else {
        for (const row of seasons.filter((item) => !coordinates(body.parentIndex) || item.number === body.parentIndex)) {
          for (const episode of episodes(await season(row.id))) {
            const exact = coordinates(body.parentIndex) && coordinates(body.index)
              ? episode.number === body.index : Boolean(body.date && episode.aired === body.date);
            if (exact) matches.push(episodeItem(show, row, episode));
          }
        }
      }
    }
    return envelope(manual || matches.length === 1 ? matches : []);
  }

  /** Applies Plex’s header or query-string paging parameters to a result list. */
  function page(request, url, rows) {
    const param = (key) => url.searchParams.get(key) ?? request.headers[key.toLowerCase()];
    const start = Number(param('X-Plex-Container-Start') ?? 0);
    const size = Number(param('X-Plex-Container-Size') ?? 20);
    if (!coordinates(start) || !coordinates(size)) throw new RequestError(400, 'Invalid paging parameters');
    return envelope(rows.slice(start, start + size), start, rows.length);
  }

  /** Routes Plex discovery, matching, and metadata requests and formats errors. */
  const server = createServer(async (request, response) => {
    let path;
    let status = 200;
    let body;
    try {
      const url = new URL(request.url, 'http://localhost');
      path = url.pathname;
      const language = languageCode(request.headers['x-plex-language'] || url.searchParams.get('X-Plex-Language'));
      if (request.method === 'GET' && url.pathname === '/health') {
        body = { status: 'ok' };
      } else if (request.method === 'GET' && url.pathname === '/stats') {
        body = tvdb.cacheCounts();
      } else if (request.method === 'GET' && url.pathname === '/') {
        body = { MediaProvider: {
          identifier, title: 'TheTVDB Aired', version: '1.0.0',
          Types: Object.keys(kinds).map((type) => ({ type: Number(type), Scheme: [{ scheme: identifier }] })),
          Feature: [{ type: 'metadata', key: metadataPath }, { type: 'match', key: metadataPath + '/matches' }],
        } };
      } else if (request.method === 'POST' && url.pathname === metadataPath + '/matches') {
        body = await match(await readBody(request), language);
      } else {
        const parsed = url.pathname.match(/^\/library\/metadata\/(show|season|episode)-([1-9][0-9]{0,14})(?:\/(children|grandchildren|images))?$/);
        if (request.method !== 'GET' || !parsed) throw new RequestError(404, 'Unknown endpoint');
        requireAired(url.searchParams.get('episodeOrder') || url.searchParams.get('episodeOrdering'));
        const [, kind, id, part] = parsed;
        const { item, children, series: show } = await load(kind, id, language);
        if (part === 'children') {
          body = page(request, url, children);
        } else if (part === 'grandchildren') {
          const rows = [];
          for (const row of show ? airedSeasons(show) : []) {
            rows.push(...episodes(await season(row.id)).map((e) => episodeItem(show, row, e)));
          }
          body = page(request, url, rows);
        } else if (part === 'images') {
          const images = item.Image || [];
          body = { MediaContainer: { identifier, offset: 0, size: images.length, totalSize: images.length, Image: images } };
        } else {
          body = envelope([include(url.searchParams.get('includeChildren')) && kind !== 'episode'
            ? withChildren(item, children) : item]);
        }
      }
    } catch (error) {
      status = error instanceof RequestError ? error.status : 502;
      if (status >= 500) {
        console.warn('Plex metadata request failed', request.method, path, status,
          error instanceof RequestError ? error.message : error.name);
      }
      body = { error: error instanceof RequestError ? error.message : 'Metadata unavailable' };
      if (error.retryAfter) body.retryAfter = error.retryAfter;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (body.retryAfter) response.setHeader('Retry-After', body.retryAfter);
    response.writeHead(status);
    response.end(JSON.stringify(body));
  });
  server.once('close', tvdb.close);
  return server;
}
