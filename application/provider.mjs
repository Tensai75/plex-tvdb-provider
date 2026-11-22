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
const artworkTypes = {
  show: new Map([[2, 'coverPoster'], [3, 'background'], [23, 'clearLogo']]),
  season: new Map([[7, 'coverPoster'], [8, 'background']]),
  episode: new Map([[11, 'snapshot'], [12, 'snapshot']]),
};
const creditTypes = new Map([
  [1, 'Director'], [2, 'Writer'], [3, 'Role'], [4, 'Role'], [7, 'Producer'], [11, 'Producer'],
]);
// TheTVDB uses three-letter codes for content ratings. Plex uses two-letter regions.
const ratingRegions = {
  are: 'AE', arg: 'AR', arm: 'AM', aus: 'AU', aut: 'AT', bel: 'BE', bgr: 'BG', bra: 'BR',
  can: 'CA', chl: 'CL', col: 'CO', deu: 'DE', dnk: 'DK', ecu: 'EC', egy: 'EG', esp: 'ES',
  est: 'EE', fin: 'FI', fra: 'FR', gbr: 'GB', grc: 'GR', hkg: 'HK', hrv: 'HR', hun: 'HU',
  idn: 'ID', ind: 'IN', irl: 'IE', isl: 'IS', isr: 'IL', ita: 'IT', jam: 'JM', jpn: 'JP',
  kaz: 'KZ', khm: 'KH', kor: 'KR', ltu: 'LT', lva: 'LV', mar: 'MA', mdv: 'MV', mex: 'MX',
  mlt: 'MT', mys: 'MY', nga: 'NG', nld: 'NL', nor: 'NO', nzl: 'NZ', per: 'PE', phl: 'PH',
  pol: 'PL', prt: 'PT', rou: 'RO', rus: 'RU', sau: 'SA', sgp: 'SG', slv: 'SV', svk: 'SK',
  svn: 'SI', swe: 'SE', tha: 'TH', tur: 'TR', twn: 'TW', ukr: 'UA', usa: 'US', ven: 'VE',
  vnm: 'VN', zaf: 'ZA',
};
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** Validates a Plex season, episode, or paging number. */
const coordinates = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Validates a positive TheTVDB numeric ID. */
const numericId = (value) => /^[1-9][0-9]{0,14}$/.test(String(value));
/** Treats absent or non-list optional TVDB fields as empty. */
const list = (value) => Array.isArray(value) ? value : [];
/** Keeps nonblank string metadata and omits incomplete upstream fields. */
const label = (value) => typeof value === 'string' ? value.trim() : '';
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

/** Converts Plex and TVDB country hints into a two-letter rating region. */
function regionCode(value) {
  const code = label(value).toLowerCase();
  if (code === 'uk') return 'GB';
  if (/^[a-z]{2}$/.test(code)) return code.toUpperCase();
  return /^[a-z]{3}$/.test(code) && Object.hasOwn(ratingRegions, code) ? ratingRegions[code] : undefined;
}

/** Formats a Plex age rating for the requested country, defaulting to US when absent. */
function contentRating(record, country) {
  const region = country ? regionCode(country) : 'US';
  if (!region) return undefined;
  const rating = list(record.contentRatings).find((row) =>
    regionCode(row?.country) === region && label(row?.name));
  if (!rating) return undefined;
  const name = label(rating.name);
  return region === 'US' ? name : region.toLowerCase() + '/' + name;
}

/** Resolves TVDB artwork paths to public HTTP URLs. */
function artworkUrl(value) {
  const path = label(value);
  if (!path) return undefined;
  const url = URL.parse(path, 'https://artworks.thetvdb.com/');
  return url && ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
}

/** Maps available artwork for the specific kind of item and keeps its primary image first. */
function imagesFor(type, record) {
  const images = new Map();
  const primaryType = type === 'episode' ? 'snapshot' : 'coverPoster';
  const primaryUrl = artworkUrl(record.image);
  if (primaryUrl) {
    images.set(primaryType + ':' + primaryUrl, { type: primaryType, url: primaryUrl });
  }
  for (const artwork of list(record.artworks ?? record.artwork)) {
    const typeName = artworkTypes[type].get(artwork?.type);
    const url = artworkUrl(artwork?.image);
    if (typeName && url) images.set(typeName + ':' + url, { type: typeName, url });
  }
  return [...images.values()];
}

/** Maps cast and crew using TVDB's credit types and Plex's person fields. */
function creditsFor(record) {
  const credits = {};
  const people = list(record.characters).filter((person) => creditTypes.has(person?.type) && label(person.personName))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  for (const person of people) {
    const field = creditTypes.get(person.type);
    const entry = { tag: label(person.personName) };
    const thumb = artworkUrl(person.personImgURL) || artworkUrl(person.image);
    if (thumb) entry.thumb = thumb;
    const entries = credits[field] ??= [];
    if (field === 'Role') {
      if (label(person.name)) entry.role = label(person.name);
      entry.order = entries.length;
    }
    entries.push(entry);
  }
  return credits;
}

/** Converts upstream names into a deduplicated Plex tag array. */
function tagsFor(names) {
  return [...new Set(names.map(label).filter(Boolean))].map((tag) => ({ tag }));
}

/** Falls back to TVDB's primary company type when the nested type is unknown. */
const companyType = (company) => company?.companyType?.companyTypeId || company?.primaryCompanyType;

/** Builds the external GUID list that Plex and sync tools can use to identify an item. */
function externalIds(record) {
  const ids = new Set([`tvdb://${record.id}`]);
  for (const remote of list(record.remoteIds)) {
    const provider = label(remote?.sourceName).toLowerCase();
    if (provider === 'imdb' && /^tt\d+$/i.test(remote.id)) ids.add(`imdb://${remote.id.toLowerCase()}`);
    if (['themoviedb.com', 'tmdb', 'themoviedb'].includes(provider) && numericId(remote.id)) {
      ids.add(`tmdb://${remote.id}`);
    }
  }
  return [...ids].map((id) => ({ id }));
}

/** Formats the metadata fields and artwork shared by shows, seasons, and episodes. */
function describe(type, record, title, date, { seasonId, country } = {}) {
  if (!numericId(record.id)) throw new RequestError(502, 'TVDB returned an invalid item ID');
  const ratingKey = itemKey(type, record.id, seasonId);
  const images = imagesFor(type, record);
  const thumb = images.find((image) => image.type === (type === 'episode' ? 'snapshot' : 'coverPoster'))?.url;
  const art = images.find((image) => image.type === 'background')?.url;
  const rating = contentRating(record, country);
  return {
    ratingKey, key: `${metadataPath}/${ratingKey}`, guid: guid(type, ratingKey), type, title,
    ...(date ? { originallyAvailableAt: date, year: Number(date.slice(0, 4)) } : {}),
    ...(record.originalTitle ? { originalTitle: record.originalTitle } : {}),
    summary: [record.overview, 'Metadata provided by TheTVDB\nhttps://thetvdb.com/'].filter(Boolean).join('\n\n'),
    ...(thumb ? { thumb } : {}),
    ...(art ? { art } : {}),
    ...(rating ? { contentRating: rating } : {}),
    ...(images.length ? { Image: images } : {}),
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

/** Formats show metadata shared by lookup, artwork, and match responses. */
function showItem(series, country) {
  const genre = tagsFor(list(series.genres).map((row) => row?.name));
  const companies = list(series.companies);
  const studios = tagsFor(companies.filter((company) => [2, 3].includes(companyType(company)))
    .map((company) => company.name));
  const region = regionCode(series.originalCountry);
  const origin = region && regionNames.of(region);
  const networks = tagsFor([
    series.originalNetwork?.name,
    ...companies.filter((company) => companyType(company) === 1).map((company) => company.name),
    series.latestNetwork?.name,
  ]);
  return {
    ...describe('show', series, series.name, series.firstAired, { country }),
    ...creditsFor(series),
    ...(genre.length ? { Genre: genre } : {}),
    ...(studios.length ? { studio: studios[0].tag, Studio: studios } : {}),
    ...(origin ? { Country: [{ tag: origin }] } : {}),
    ...(networks.length ? { Network: networks } : {}),
    ...(series.averageRuntime > 0 ? { duration: series.averageRuntime * 60000 } : {}),
  };
}

/** Uses the declared season name or the Plex label for a numbered season or specials. */
const seasonTitle = (season) => season.name || (season.number === 0 ? 'Specials' : `Season ${season.number}`);

/** Formats a season using the earliest dated episode in its selected order. */
function seasonItem(series, season, details) {
  const firstAired = list(details?.episodes).map((episode) => episode.aired)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))).sort()[0];
  return {
    ...describe('season', { ...details, ...season }, seasonTitle(season), firstAired),
    ...ancestor('show', series.id, series.name, 'parent'),
    index: season.number,
  };
}

/** Formats an episode with its season number, ancestry, and runtime in milliseconds. */
function episodeItem(series, season, episode, country) {
  const seasonId = seasonOrder(season) === defaultOrder ? undefined : season.id;
  return {
    ...describe('episode', episode, episode.name || `Episode ${episode.number}`, episode.aired, { seasonId, country }),
    ...creditsFor(episode),
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
  const episodes = (s) => list(s?.episodes);
  /** Accepts either a JSON boolean or 1 for a Plex include flag. */
  const include = (value) => value === true || String(value) === '1';

  /** Resolves a listed season whose cached summary may outlive its extended record. */
  async function listedSeason(id) {
    try {
      return await season(id);
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error;
      return undefined;
    }
  }

  /** Returns the episode members of a listed season. */
  const seasonEpisodes = async (id) => episodes(await listedSeason(id));

  /** Checks a listed alternate order for an episode that Plex can match by number. */
  async function hasNumberedEpisodes(showId, order, rows) {
    for (const row of rows) {
      if (row.number === 0) continue;
      try {
        const members = await seasonEpisodes(row.id);
        if (members.some((episode) => numericId(episode.id) && coordinates(episode.number))) return true;
      } catch (error) {
        console.warn('Could not verify TVDB episode order', showId, order,
          error instanceof RequestError ? error.status : error.name);
      }
    }
    return false;
  }

  /** Advertises Aired and alternate orders with confirmed numbered episodes. */
  async function showMetadata(show, item) {
    const orders = new Map();
    for (const row of seriesSeasons(show)) {
      const id = seasonOrder(row);
      if (!orders.has(id)) orders.set(id, []);
      orders.get(id).push(row);
    }
    const types = await Promise.all([...orders].map(async ([id, rows]) => {
      if (id !== defaultOrder && !await hasNumberedEpisodes(show.id, id, rows)) return null;
      const { alternateName, name } = rows[0].type;
      const label = (id !== defaultOrder && alternateName) || orderLabels.get(id) || name || 'Order ' + rows[0].type.id;
      return { id, source: 'tvdb', tag: label, title: 'TheTVDB (' + label + ')' };
    }));
    return { ...item, SeasonType: types.filter(Boolean).sort((a, b) => (b.id === defaultOrder) - (a.id === defaultOrder)) };
  }

  /** Formats requested seasons, retaining the series summary if a season record is missing. */
  async function seasonItems(show, rows) {
    return Promise.all(rows.map(async (row) => seasonItem(show, row, await listedSeason(row.id))));
  }

  /** Loads requested children for every result before checking optional orders. */
  async function itemResults(items, includeChildren) {
    const results = [];
    for (const { item, children, series: show } of items) {
      const childItems = includeChildren && item.type !== 'episode'
        ? (show ? await seasonItems(show, children) : children)
        : undefined;
      results.push(childItems ? withChildren(item, childItems) : item);
    }
    for (const [index, { series: show }] of items.entries()) {
      if (show) results[index] = await showMetadata(show, results[index]);
    }
    return results;
  }

  /** Loads a known TheTVDB item and its Plex hierarchy. */
  async function load(kind, id, { language, order, seasonId, country }) {
    if (kind === 'show') {
      const s = await series(id, language);
      return { item: showItem(s, country), children: seriesSeasons(s, order ?? defaultOrder), series: s };
    }
    if (kind === 'season') {
      const seasonData = await season(id);
      if (!numericId(seasonData.seriesId)) throw new RequestError(502, 'TVDB season has no series');
      const s = await series(seasonData.seriesId, language);
      const row = seriesSeasons(s, order).find((part) => String(part.id) === id);
      if (!row) throw new RequestError(404, 'TVDB season not found in the requested order');
      const episodeRows = episodes(seasonData);
      return { item: seasonItem(s, row, seasonData), children: episodeRows.map((e) => episodeItem(s, row, e, country)) };
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
      if (member) return { item: episodeItem(s, row, { ...e, number: member.number }, country), children: [] };
    }
    throw new RequestError(404, 'TVDB episode not found in the requested order');
  }

  /** Resolves an external GUID only when one series still declares that cross-reference. */
  async function findRemoteSeries(expectedGuid, language) {
    const [, id] = expectedGuid.split('://');
    let results;
    try {
      results = await tvdb(`/search/remoteid/${id}`);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return [];
      throw error;
    }
    if (!Array.isArray(results)) throw new RequestError(502, 'TVDB external ID lookup has no results array');
    const ids = new Set(results.map((row) => row?.series?.id).filter(numericId).map(String));
    const shows = [];
    for (const seriesId of ids) {
      try {
        const record = await series(seriesId, language);
        if (externalIds(record).some(({ id }) => id === expectedGuid)) shows.push(record);
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 404) throw error;
      }
      if (shows.length > 1) return [];
    }
    return shows;
  }

  /** Resolves the show by file ID first, then by title and year when no ID is present. */
  async function findSeries(title, year, manual, file, language) {
    const path = typeof file === 'string' ? file : '';
    const namedId = path.match(/\{tvdb-([1-9][0-9]{0,14})\}/i)?.[1];
    if (namedId) return [await series(namedId, language)];
    const imdbId = path.match(/(?<![\p{L}\p{N}])imdb-(tt[0-9]{1,15})(?![\p{L}\p{N}])/iu)?.[1].toLowerCase();
    if (imdbId) return findRemoteSeries(`imdb://${imdbId}`, language);
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
  async function match(body, language, country) {
    const kind = Number.isInteger(body.type) ? kinds[body.type] : undefined;
    if (!kind) throw new RequestError(400, 'Unsupported metadata type');
    const order = requestedOrder(body.episodeOrder ?? body.episodeOrdering);
    const hint = typeof body.guid === 'string' ? body.guid.toLowerCase() : '';
    const external = hint.match(/^tvdb:\/\/([1-9][0-9]{0,14})$/)?.[1];
    if (external) {
      try {
        const loaded = await load(kind, external, { language, order, country });
        return envelope(await itemResults([loaded], include(body.includeChildren)));
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) return envelope([]);
        throw error;
      }
    }
    const manual = include(body.manual);
    const name = { show: body.title, season: body.parentTitle, episode: body.grandparentTitle }[kind];
    const remote = kind === 'show' && /^(?:imdb:\/\/tt[0-9]{1,15}|tmdb:\/\/[1-9][0-9]{0,14})$/.test(hint);
    const shows = remote
      ? await findRemoteSeries(hint, language)
      : await findSeries(name, kind === 'show' ? body.year : null, manual, body.filename, language);
    if (kind === 'show') {
      const items = shows.map((show) => ({
        item: showItem(show, country), children: seriesSeasons(show, order ?? defaultOrder), series: show,
      }));
      return envelope(await itemResults(items, include(body.includeChildren)));
    }
    const matches = [];
    for (const show of shows) {
      const seasons = seriesSeasons(show, order ?? defaultOrder);
      if (kind === 'season') {
        const row = seasons.find((item) => item.number === body.index);
        if (!row) continue;
        const details = await season(row.id);
        const item = seasonItem(show, row, details);
        matches.push(include(body.includeChildren)
          ? withChildren(item, episodes(details).map((e) => episodeItem(show, row, e, country))) : item);
      } else {
        for (const row of seasons.filter((item) => !coordinates(body.parentIndex) || item.number === body.parentIndex)) {
          for (const episode of await seasonEpisodes(row.id)) {
            const exact = coordinates(body.parentIndex) && coordinates(body.index)
              ? episode.number === body.index : Boolean(body.date && episode.aired === body.date);
            if (exact) matches.push(episodeItem(show, row, episode, country));
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
      const country = request.headers['x-plex-country'] || url.searchParams.get('X-Plex-Country');
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
        body = await match(await readBody(request), language, country);
      } else {
        const parsed = url.pathname.match(/^\/library\/metadata\/(show|season|episode)-([1-9][0-9]{0,14})(?:-([1-9][0-9]{0,14}))?(?:\/(children|grandchildren|images))?$/);
        if (request.method !== 'GET' || !parsed) throw new RequestError(404, 'Unknown endpoint');
        const order = requestedOrder(url.searchParams.get('episodeOrder') || url.searchParams.get('episodeOrdering'));
        const [, kind, id, seasonId, part] = parsed;
        if (seasonId && kind !== 'episode') throw new RequestError(404, 'Unknown endpoint');
        if (kind === 'episode' && !seasonId && order && order !== defaultOrder) {
          throw new RequestError(404, 'Episode key belongs to Aired order');
        }
        const loaded = await load(kind, id, { language, order, seasonId, country });
        const { item, children, series: show } = loaded;
        if (part === 'children') {
          body = await page(request, url, children, show);
        } else if (part === 'grandchildren') {
          const rows = [];
          for (const row of show ? children : []) {
            rows.push(...(await seasonEpisodes(row.id)).map((e) => episodeItem(show, row, e, country)));
          }
          body = await page(request, url, rows);
        } else if (part === 'images') {
          const images = item.Image || [];
          body = { MediaContainer: { identifier, offset: 0, size: images.length, totalSize: images.length, Image: images } };
        } else {
          body = envelope(await itemResults([loaded], include(url.searchParams.get('includeChildren'))));
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
