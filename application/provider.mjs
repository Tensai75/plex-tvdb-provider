import { createServer } from 'node:http';
import { RequestError, tvdbClient } from './tvdb.mjs';

// Existing installations can retain their Plex GUID namespace when adopting this image.
const identifier = process.env.PLEX_PROVIDER_IDENTIFIER || 'tv.plex.agents.custom.plextvdbprovider.tvdb';
if (!/^tv\.plex\.agents\.custom\.[a-zA-Z0-9.]+$/.test(identifier)) {
  throw new Error('PLEX_PROVIDER_IDENTIFIER must be a valid Plex custom provider identifier');
}
const metadataPath = '/library/metadata';
const kinds = { 2: 'show', 3: 'season', 4: 'episode' };
const defaultOrder = 'official';
const orderLabels = new Map([[defaultOrder, 'Aired'], ['dvd', 'DVD'], ['absolute', 'Absolute']]);
const orderAliases = new Map([
  ['default', defaultOrder], ['aired', defaultOrder], ['tvdbairing', defaultOrder],
  ['tvdbdvd', 'dvd'], ['tvdbabsolute', 'absolute'],
]);

/** Validates a Plex season, episode, or paging number. */
const coordinates = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Validates a positive TheTVDB numeric ID. */
const numericId = (value) => /^[1-9][0-9]{0,14}$/.test(String(value));
/** Normalizes a title or alias for exact comparison after ignoring punctuation. */
const normalize = (name) => String(name || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Builds the key with an optional alternate season binding for an episode. */
const itemKey = (type, id, seasonId) => `${type}-${id}` + (seasonId ? `-${seasonId}` : '');
/** Builds a stable Plex GUID from the item's canonical key. */
const guid = (type, ratingKey) => `${identifier}://${type}/${ratingKey}`;

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
function describe(type, record, title, date, seasonId) {
  if (!numericId(record.id)) throw new RequestError(502, 'TVDB returned an invalid item ID');
  const ratingKey = itemKey(type, record.id, seasonId);
  return {
    ratingKey, key: `${metadataPath}/${ratingKey}`, guid: guid(type, ratingKey), type, title,
    ...(date ? { originallyAvailableAt: date, year: Number(date.slice(0, 4)) } : {}),
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
function ancestor(type, id, title, prefix) {
  if (!numericId(id)) throw new RequestError(502, 'TVDB returned an invalid parent ID');
  const ratingKey = itemKey(type, id);
  return {
    [`${prefix}Type`]: type,
    [`${prefix}RatingKey`]: ratingKey,
    [`${prefix}Key`]: `${metadataPath}/${ratingKey}`,
    [`${prefix}Guid`]: guid(type, ratingKey),
    [`${prefix}Title`]: title,
  };
}

/** Wraps a list of metadata items in Plex’s paginated response format. */
function envelope(items, offset = 0, totalSize = items.length) {
  return { MediaContainer: { identifier, offset, size: items.length, totalSize, Metadata: items } };
}

/** Identifies the Plex order for a TheTVDB season. Named orders use the season-type ID. */
function seasonOrder(season) {
  const type = season.type;
  if (orderLabels.has(type?.type)) return type.type;
  return numericId(type?.id) ? 'tvdbOrder' + type.id : undefined;
}

/** Normalizes Plex order aliases while preserving the distinction between default and explicit requests. */
function requestedOrder(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new RequestError(400, 'Invalid episode order');
  const normalized = value.toLowerCase();
  const known = orderAliases.get(normalized) ?? normalized;
  if (orderLabels.has(known)) return known;
  const custom = /^tvdborder([1-9][0-9]{0,14})$/i.exec(value);
  if (custom) return 'tvdbOrder' + custom[1];
  throw new RequestError(404, 'Unknown TheTVDB episode order');
}

/** Returns navigable seasons in the requested order, or across orders for an exact keyed lookup. */
function seriesSeasons(series, order) {
  return (series.seasons || []).filter((season) => {
    const id = seasonOrder(season);
    return id && numericId(season.id) && coordinates(season.number) && (!order || order === id);
  }).sort((a, b) => a.number - b.number);
}

/** Formats a show and advertises only the episode orders with season data for that show. */
function showItem(series) {
  const orders = new Map();
  for (const row of seriesSeasons(series)) {
    const id = seasonOrder(row);
    if (orders.has(id)) continue;
    const label = (id !== defaultOrder && row.type.alternateName) || orderLabels.get(id)
      || row.type.name || 'Order ' + row.type.id;
    orders.set(id, { id, source: 'tvdb', tag: label, title: `TheTVDB (${label})` });
  }
  const aired = orders.get(defaultOrder);
  orders.delete(defaultOrder);
  return {
    ...describe('show', series, series.name, series.firstAired),
    SeasonType: [...(aired ? [aired] : []), ...orders.values()],
  };
}

/** Uses the declared season name or the Plex label for a numbered season or specials. */
const seasonTitle = (season) => season.name || (season.number === 0 ? 'Specials' : `Season ${season.number}`);

/** Formats a season using the earliest dated episode in its selected order. */
function seasonItem(series, season, episodeRows = []) {
  const firstAired = episodeRows.map((episode) => episode.aired)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))).sort()[0];
  return {
    ...describe('season', season, seasonTitle(season), firstAired),
    ...ancestor('show', series.id, series.name, 'parent'),
    index: season.number,
  };
}

/** Formats an episode with its season number, ancestry, and runtime in milliseconds. */
function episodeItem(series, season, episode) {
  const alternateSeasonId = seasonOrder(season) === defaultOrder ? undefined : season.id;
  return {
    ...describe('episode', episode, episode.name || `Episode ${episode.number}`, episode.aired, alternateSeasonId),
    ...ancestor('season', season.id, seasonTitle(season), 'parent'),
    ...ancestor('show', series.id, series.name, 'grandparent'),
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

  /** Returns episode members of a listed season, even if its cached listing outlives the record. */
  async function seasonEpisodes(id) {
    try {
      return episodes(await season(id));
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error;
      return [];
    }
  }

  /** Formats requested seasons, retaining the series summary if a season record is missing. */
  async function seasonItems(show, rows) {
    return Promise.all(rows.map(async (row) => seasonItem(show, row, await seasonEpisodes(row.id))));
  }

  /** Loads a known TheTVDB item and its Plex hierarchy. */
  async function load(kind, id, language, order, seasonId) {
    if (kind === 'show') {
      const s = await series(id, language);
      return { item: showItem(s), children: seriesSeasons(s, order ?? defaultOrder), series: s };
    }
    if (kind === 'season') {
      const seasonData = await season(id);
      if (!numericId(seasonData.seriesId)) throw new RequestError(502, 'TVDB season has no series');
      const s = await series(seasonData.seriesId, language);
      const row = seriesSeasons(s, order).find((part) => String(part.id) === id);
      if (!row) throw new RequestError(404, 'TVDB season not found in the requested order');
      const episodeRows = episodes(seasonData);
      return { item: seasonItem(s, row, episodeRows), children: episodeRows.map((e) => episodeItem(s, row, e)) };
    }
    const e = await tvdb(`/episodes/${id}/extended`);
    if (!numericId(e.seriesId) || String(e.id) !== id) throw new RequestError(502, 'TVDB returned an invalid episode');
    const s = await series(e.seriesId, language);
    // Use the episode coordinates from the selected season, since the extended record uses the series default.
    const seasons = seasonId
      ? seriesSeasons(s, order).filter((row) => String(row.id) === seasonId && seasonOrder(row) !== defaultOrder)
      : seriesSeasons(s, order ?? defaultOrder);
    const candidates = seasonId || !Array.isArray(e.seasons)
      ? seasons.sort((a, b) => (b.number === e.seasonNumber) - (a.number === e.seasonNumber))
      : seasons.filter((row) => e.seasons.some((part) => String(part.id) === String(row.id)));
    for (const row of candidates) {
      const member = (await seasonEpisodes(row.id)).find((part) => String(part.id) === id && coordinates(part.number));
      if (member) return { item: episodeItem(s, row, { ...e, number: member.number }), children: [] };
    }
    throw new RequestError(404, 'TVDB episode not found in the requested order');
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
      const translations = typeof row.translations === 'object' ? Object.values(row.translations || {}) : [];
      if (![row.name, ...(row.aliases || []), ...translations]
        .some((name) => typeof name === 'string' && normalize(name) === wanted)) continue;
      if (year && row.year && String(year) !== String(row.year)) continue;
      matching.set(String(row.tvdb_id), row);
    }
    if (!manual) {
      let chosen;
      for (const [id, row] of matching) {
        const record = year && !row.year ? await series(id, language) : undefined;
        const premiereYear = record?.firstAired?.slice(0, 4) || record?.year;
        if (premiereYear && String(premiereYear) !== String(year)) continue;
        if (chosen) return [];
        chosen = { id, record };
      }
      return chosen ? [chosen.record ?? await series(chosen.id, language)] : [];
    }
    const picks = matching.size ? matching.keys() : results
      .filter((row) => numericId(row.tvdb_id)).map((row) => String(row.tvdb_id));
    return Promise.all([...new Set(picks)].slice(0, 8).map((id) => series(id, language)));
  }

  /** Translates a Plex match request into candidates for a show, season, or episode. */
  async function match(body, language) {
    const kind = Number.isInteger(body.type) ? kinds[body.type] : undefined;
    if (!kind) throw new RequestError(400, 'Unsupported metadata type');
    const order = requestedOrder(body.episodeOrder ?? body.episodeOrdering);
    const external = typeof body.guid === 'string' ? body.guid.match(/^tvdb:\/\/([1-9][0-9]{0,14})$/)?.[1] : null;
    if (external) {
      try {
        const { item, children, series: show } = await load(kind, external, language, order);
        return envelope([include(body.includeChildren) && kind !== 'episode'
          ? withChildren(item, show ? await seasonItems(show, children) : children) : item]);
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) return envelope([]);
        throw error;
      }
    }
    const manual = include(body.manual);
    const name = { show: body.title, season: body.parentTitle, episode: body.grandparentTitle }[kind];
    const matches = [];
    for (const show of await findSeries(name, kind === 'show' ? body.year : null, manual, body.filename, language)) {
      const seasons = seriesSeasons(show, order ?? defaultOrder);
      if (kind === 'show') {
        const item = showItem(show);
        matches.push(include(body.includeChildren) ? withChildren(item, await seasonItems(show, seasons)) : item);
      } else if (kind === 'season') {
        const row = seasons.find((item) => item.number === body.index);
        if (!row) continue;
        const episodeRows = episodes(await season(row.id));
        const item = seasonItem(show, row, episodeRows);
        matches.push(include(body.includeChildren)
          ? withChildren(item, episodeRows.map((e) => episodeItem(show, row, e))) : item);
      } else {
        for (const row of seasons.filter((item) => !coordinates(body.parentIndex) || item.number === body.parentIndex)) {
          for (const episode of await seasonEpisodes(row.id)) {
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
  async function page(request, url, rows, show) {
    const param = (key) => url.searchParams.get(key) ?? request.headers[key.toLowerCase()];
    const start = Number(param('X-Plex-Container-Start') ?? 0);
    const size = Number(param('X-Plex-Container-Size') ?? 20);
    if (!coordinates(start) || !coordinates(size)) throw new RequestError(400, 'Invalid paging parameters');
    const selected = rows.slice(start, start + size);
    return envelope(show ? await seasonItems(show, selected) : selected, start, rows.length);
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
          identifier, title: 'TheTVDB', version: '1.0.0',
          Types: Object.keys(kinds).map((type) => ({ type: Number(type), Scheme: [{ scheme: identifier }] })),
          Feature: [{ type: 'metadata', key: metadataPath }, { type: 'match', key: metadataPath + '/matches' }],
        } };
      } else if (request.method === 'POST' && url.pathname === metadataPath + '/matches') {
        body = await match(await readBody(request), language);
      } else {
        const parsed = url.pathname.match(/^\/library\/metadata\/(show|season|episode)-([1-9][0-9]{0,14})(?:-([1-9][0-9]{0,14}))?(?:\/(children|grandchildren|images))?$/);
        if (request.method !== 'GET' || !parsed) throw new RequestError(404, 'Unknown endpoint');
        const order = requestedOrder(url.searchParams.get('episodeOrder') || url.searchParams.get('episodeOrdering'));
        const [, kind, id, seasonId, part] = parsed;
        if (seasonId && kind !== 'episode') throw new RequestError(404, 'Unknown endpoint');
        const { item, children, series: show } = await load(kind, id, language, order, seasonId);
        if (part === 'children') {
          body = await page(request, url, children, show);
        } else if (part === 'grandchildren') {
          const rows = [];
          for (const row of show ? children : []) {
            rows.push(...(await seasonEpisodes(row.id)).map((e) => episodeItem(show, row, e)));
          }
          body = await page(request, url, rows);
        } else if (part === 'images') {
          const images = item.Image || [];
          body = { MediaContainer: { identifier, offset: 0, size: images.length, totalSize: images.length, Image: images } };
        } else {
          body = envelope([include(url.searchParams.get('includeChildren')) && kind !== 'episode'
            ? withChildren(item, show ? await seasonItems(show, children) : children) : item]);
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
