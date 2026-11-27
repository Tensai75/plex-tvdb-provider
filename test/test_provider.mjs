import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { createProvider } from '../application/provider.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

const episodes = [
  { id: 200, seriesId: 1, seasonNumber: 0, number: 1, name: 'Special', aired: '2020-12-01' },
  { id: 201, seriesId: 1, seasonNumber: 1, number: 1, name: 'Pilot', aired: '2021-01-01' },
  { id: 202, seriesId: 1, seasonNumber: 1, number: 2, name: 'Second', aired: '2021-01-02',
    image: 'https://artworks.thetvdb.com/banners/episodes/202.jpg' },
];
const series = {
  id: 1, name: 'Example', firstAired: '2021-01-01',
  originalLanguage: 'eng', nameTranslations: ['eng', 'fra', 'deu'],
  image: 'https://artworks.thetvdb.com/banners/posters/1.jpg',
  remoteIds: [{ sourceName: 'IMDB', id: 'tt0123456' }],
  seasons: [
    { id: 11, number: 0, type: { type: 'official' } },
    { id: 12, number: 1, type: { type: 'official' },
      image: 'https://artworks.thetvdb.com/banners/seasons/12.jpg' },
    { id: 13, number: 2, type: { type: 'dvd' } },
  ],
};
const aired = { ...series.seasons[1], seriesId: 1, episodes: episodes.slice(1) };
const special = { ...series.seasons[0], seriesId: 1, episodes: episodes.slice(0, 1) };

test('Plex discovery and TVDB matching, hierarchy, paging, misses and auth recovery', async (t) => {
  const logins = [];
  const imdbLookups = [];
  let refused = false;
  const tvdb = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let data;
    if (url.pathname === '/login') {
      assert.equal(request.method, 'POST');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      logins.push(JSON.parse(Buffer.concat(chunks)));
      data = { token: 'fixture-' + logins.length };
    } else {
      assert.match(request.headers.authorization, /^Bearer fixture-\d+$/);
      if (!refused) {
        refused = true;
        response.writeHead(401).end();
        return;
      }
      if (url.pathname === '/search') {
        assert.equal(url.searchParams.get('type'), 'series');
        if (url.searchParams.get('query') === 'Example') {
          data = [{ tvdb_id: '1', name: 'Example', year: '2021' }];
        } else {
          data = [{ tvdb_id: '1', name: 'Name', year: '2021' }, { tvdb_id: '2', name: 'Name', year: '2021' }];
        }
      } else if (url.pathname.startsWith('/search/remoteid/')) {
        const id = url.pathname.split('/').at(-1);
        imdbLookups.push(id);
        data = {
          tt0123456: [{ series: { id: 1 } }, { series: { id: 1 } }, { movie: { id: 42 } }],
          tt0222222: [{ series: { id: 1 } }, { series: { id: 2 } }],
          tt0333333: [{ episode: { id: 202 } }],
        }[id];
      } else {
        data = {
          '/series/1/extended': series,
          '/series/1/translations/fra': { name: 'Exemple', overview: 'Un exemple.' },
          '/seasons/11/extended': special,
          '/seasons/12/extended': aired,
          '/episodes/202/extended': episodes[2],
        }[url.pathname];
      }
    }
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'success', data }));
  });
  const upstream = await listen(tvdb);
  t.after(() => tvdb.close());
  const provider = createProvider({ api_key: 'fixture-key', pin: 'fixture-pin', baseUrl: upstream });
  const base = await listen(provider);
  t.after(() => provider.close());
  const request = async (route, options, expected = 200) => {
    const reply = await fetch(base + route, options);
    assert.equal(reply.status, expected);
    return reply.json();
  };
  const match = (body) => request('/library/metadata/matches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const discovery = (await request('/')).MediaProvider;
  assert.deepEqual(discovery.Types.map((x) => x.type), [2, 3, 4]);
  assert.deepEqual(discovery.Feature.map((x) => x.key), ['/library/metadata', '/library/metadata/matches']);
  assert.equal((await request('/health')).status, 'ok');
  assert.deepEqual(await request('/stats'), { cachedShows: 0, cachedEpisodes: 0 });
  assert.equal(logins.length, 0);

  const show = (await match({ type: 2, title: 'Example', year: 2021, includeChildren: 1 })).MediaContainer.Metadata[0];
  assert.equal(show.guid, discovery.identifier + '://show/show-1');
  assert.deepEqual(show.Guid, [{ id: 'tvdb://1' }, { id: 'imdb://tt0123456' }]);
  assert.deepEqual(show.Children.Metadata.map((x) => x.index), [0, 1]);
  const showPoster = [{ type: 'coverPoster', url: series.image }];
  const seasonPoster = [{ type: 'coverPoster', url: series.seasons[1].image }];
  assert.deepEqual(show.Image, showPoster);
  assert.deepEqual(show.Children.Metadata[1].Image, seasonPoster);
  assert.equal(show.Children.Metadata[0].Image, undefined);
  assert.deepEqual((await request(show.key)).MediaContainer.Metadata[0].Image, showPoster);
  assert.deepEqual((await request(show.key + '/images')).MediaContainer.Image, showPoster);
  assert.deepEqual((await request(show.Children.Metadata[1].key)).MediaContainer.Metadata[0].Image, seasonPoster);
  const nativeAired = await request(show.key + '?episodeOrder=tvdbAiring&includeChildren=1');
  assert.deepEqual(nativeAired.MediaContainer.Metadata[0], show);
  const airedMatch = await match({ type: 2, title: 'Example', episodeOrder: 'tvdbAiring', includeChildren: 1 });
  assert.deepEqual(airedMatch.MediaContainer.Metadata[0], show);
  const unavailableOrder = await request(show.key + '?episodeOrder=tvdbAbsolute&includeChildren=1');
  assert.deepEqual(unavailableOrder.MediaContainer.Metadata[0].Children.Metadata, []);
  const translatedShow = (await request(show.key + '?X-Plex-Language=fr-CA&includeChildren=1')).MediaContainer.Metadata[0];
  assert.equal(translatedShow.title, 'Exemple');
  assert.equal(translatedShow.originalTitle, 'Example');
  assert.match(translatedShow.summary, /^Un exemple\./);
  assert.equal(translatedShow.guid, show.guid);
  assert.equal(translatedShow.Children.Metadata[1].parentTitle, 'Exemple');
  const translatedMatch = await request('/library/metadata/matches', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Plex-Language': 'fr-CA' },
    body: JSON.stringify({ type: 3, parentTitle: 'Example', index: 1 }),
  });
  assert.equal(translatedMatch.MediaContainer.Metadata[0].parentTitle, 'Exemple');
  assert.equal((await request(show.key + '?X-Plex-Language=de-DE')).MediaContainer.Metadata[0].title, 'Example');
  assert.deepEqual(logins, Array.from({ length: 2 }, () => ({ apikey: 'fixture-key', pin: 'fixture-pin' })));

  const episode = (await match({ type: 4, grandparentTitle: 'Example', parentIndex: 1, index: 2 })).MediaContainer.Metadata[0];
  assert.equal(episode.title, 'Second');
  assert.equal(episode.grandparentGuid, show.guid);
  assert.deepEqual(episode.Guid, [{ id: 'tvdb://202' }]);
  assert.equal((await request(episode.key)).MediaContainer.Metadata[0].guid, episode.guid);
  const snapshot = [{ type: 'snapshot', url: episodes[2].image }];
  assert.deepEqual(episode.Image, snapshot);
  assert.deepEqual((await request(episode.key)).MediaContainer.Metadata[0].Image, snapshot);
  assert.deepEqual((await request(episode.key + '/images')).MediaContainer.Image, snapshot);
  const byExternal = (await match({ type: 4, guid: 'tvdb://202' })).MediaContainer.Metadata[0];
  assert.equal(byExternal.guid, episode.guid);
  assert.equal((await match({ type: 4, guid: 'tvdb://999' })).MediaContainer.size, 0);

  const filename = 'Different title {imdb-tt0123456}/Season 01/S01E01 - Pilot.mkv';
  for (const tag of ['{imdb-tt0123456}', '[imdb-tt0123456]', '(imdb-tt0123456)', 'IMDB-TT0123456']) {
    const response = await match({ type: 2, title: 'Different title', filename: `Different title ${tag}/Season 01/Pilot.mkv` });
    assert.equal(response.MediaContainer.Metadata[0]?.guid, show.guid, tag);
  }
  for (const tag of ['ximdb-tt0123456', 'imdb-tt0123456x', 'imdb-tt0123456789012345']) {
    const filename = `Example ${tag}/Season 01/Pilot.mkv`;
    const wrongTitle = await match({ type: 2, title: 'Different title', filename });
    assert.equal(wrongTitle.MediaContainer.size, 0, tag);
    const byTitle = await match({ type: 2, title: 'Example', year: 2021, filename });
    assert.equal(byTitle.MediaContainer.Metadata[0]?.guid, show.guid, tag);
  }
  const taggedSeason = (await match({ type: 3, parentTitle: 'Different title', index: 1,
    filename, includeChildren: 1 })).MediaContainer.Metadata[0];
  assert.equal(taggedSeason.index, 1);
  assert.deepEqual(taggedSeason.Children.Metadata.map((row) => row.index), [1, 2]);
  const taggedEpisode = (await match({ type: 4, grandparentTitle: 'Different title', parentIndex: 1,
    index: 2, filename })).MediaContainer.Metadata[0];
  assert.equal(taggedEpisode.guid, episode.guid);
  assert.deepEqual(imdbLookups, ['tt0123456']);
  for (const id of ['tt0222222', 'tt0333333', 'tt0444444']) {
    const response = await match({ type: 2, title: 'Example', filename: `Example {imdb-${id}}/Season 01/Pilot.mkv` });
    assert.equal(response.MediaContainer.size, 0);
  }

  const children = (await request(show.key + '/grandchildren?X-Plex-Container-Size=1', {
    headers: { 'X-Plex-Container-Start': '1' },
  })).MediaContainer;
  assert.equal(children.totalSize, 3);
  assert.equal(children.Metadata[0].title, 'Pilot');
  assert.deepEqual(await request('/stats'), { cachedShows: 1, cachedEpisodes: 3 });
  const fallback = await request(show.key + '/children?episodeOrdering=tmdbAiring');
  assert.deepEqual(fallback.MediaContainer.Metadata.map((x) => x.index), [0, 1]);
  assert.equal((await match({ type: 2, title: 'Name', year: 2021 })).MediaContainer.size, 0);
});

test('uses Aired episode membership and season dates, and checks localized titles and premiere years', async (t) => {
  const airedSeason = { id: 31, seriesId: 1, number: 1, type: { type: 'official' } };
  const undatedSeason = { id: 32, seriesId: 1, number: 2, type: { type: 'official' } };
  const dvdSeason = { id: 39, seriesId: 1, number: 1, type: { type: 'dvd' } };
  const firstEpisode = { id: 21, seriesId: 1, seasonNumber: 1, number: 1, aired: '2020-04-01' };
  const secondEpisode = { id: 23, seriesId: 1, seasonNumber: 1, number: 2, aired: '2020-03-15' };
  const dvdEpisode = { id: 22, seriesId: 1, seasonNumber: 1, number: 1, seasons: [dvdSeason] };
  const original = { id: 1, name: 'Original', firstAired: '2020-03-15', defaultSeasonType: 2,
    seasons: [dvdSeason, airedSeason, undatedSeason] };
  const remake = { id: 2, name: 'Original', firstAired: '2024-06-01', seasons: [] };
  const originalHit = { tvdb_id: '1', name: 'Original', translations: { fra: 'Titre français' } };
  const remakeHit = { tvdb_id: '2', name: 'Original', year: '2024', aliases: ['Reboot'],
    translations: { fra: 'Titre français' } };
  const searches = {
    Original: [originalHit],
    Reboot: [{ ...originalHit, aliases: ['Reboot'] }, remakeHit],
    'Titre français': [originalHit, remakeHit],
  };
  const routes = {
    '/login': { token: 'fixture-token' },
    '/series/1/extended': original,
    '/series/2/extended': remake,
    '/seasons/31/extended': { ...airedSeason, episodes: [firstEpisode, secondEpisode] },
    '/seasons/32/extended': { ...undatedSeason, episodes: [{ id: 24, number: 1, aired: null }] },
    '/episodes/21/extended': { ...firstEpisode, seasonNumber: 3, number: 9, seasons: [dvdSeason, airedSeason] },
    '/episodes/22/extended': dvdEpisode,
    '/episodes/23/extended': { ...secondEpisode, seasonNumber: 2, number: 8 },
    '/episodes/25/extended': { ...dvdEpisode, id: 25, seasons: [dvdSeason, airedSeason] },
  };
  const seasonFetches = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/seasons/')) seasonFetches.push(url.pathname);
    const data = url.pathname === '/search' ? searches[url.searchParams.get('query')] : routes[url.pathname];
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const provider = createProvider({ api_key: 'fixture-key', baseUrl, spacingMs: 0 });
  const base = await listen(provider);
  t.after(() => provider.close());

  const read = async (kind, id, status = 200) => {
    const response = await fetch(base + '/library/metadata/' + kind + '-' + id + '?includeChildren=1');
    assert.equal(response.status, status);
    return (await response.json()).MediaContainer?.Metadata[0];
  };
  const match = async (body) => {
    const response = await fetch(base + '/library/metadata/matches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return (await response.json()).MediaContainer.Metadata;
  };

  const plainShow = await fetch(base + '/library/metadata/show-1');
  assert.equal(plainShow.status, 200);
  assert.deepEqual(seasonFetches, ['/seasons/39/extended']);
  seasonFetches.length = 0;
  const page = await fetch(base + '/library/metadata/show-1/children?X-Plex-Container-Size=1');
  assert.equal(page.status, 200);
  const listed = (await page.json()).MediaContainer;
  assert.equal(listed.totalSize, 2);
  assert.equal(listed.size, 1);
  assert.equal(listed.Metadata[0].originallyAvailableAt, '2020-03-15');
  assert.deepEqual(seasonFetches, ['/seasons/31/extended']);

  const episode = await read('episode', 21);
  assert.equal(episode.index, 1);
  assert.equal(episode.parentIndex, 1);
  assert.deepEqual(await match({ type: 4, guid: 'tvdb://21' }), [episode]);
  const fallback = await read('episode', 23);
  assert.equal(fallback.index, 2);
  assert.equal(fallback.parentIndex, 1);
  for (const id of [22, 25]) {
    await read('episode', id, 404);
    assert.deepEqual(await match({ type: 4, guid: 'tvdb://' + id }), []);
  }

  assert.deepEqual(await match({ type: 2, title: 'Original', year: 2024 }), []);
  assert.equal((await match({ type: 2, title: 'Reboot', year: 2024 }))[0]?.ratingKey, 'show-2');
  assert.equal((await match({ type: 2, title: 'Titre français', year: 2020 }))[0]?.ratingKey, 'show-1');
  assert.deepEqual(await match({ type: 2, title: 'Titre français' }), []);

  const season = await read('season', 31);
  assert.equal(season.originallyAvailableAt, '2020-03-15');
  assert.equal(season.year, 2020);
  const [matchedSeason] = await match({ type: 3, parentTitle: 'Original', index: 1 });
  assert.equal(matchedSeason.originallyAvailableAt, season.originallyAvailableAt);
  const showWithChildren = await read('show', 1);
  const [titleMatch] = await match({ type: 2, title: 'Original', year: 2020, includeChildren: 1 });
  const [guidMatch] = await match({ type: 2, guid: 'tvdb://1', includeChildren: 1 });
  for (const show of [showWithChildren, titleMatch, guidMatch]) {
    assert.equal(show.Children.size, 2);
    assert.equal(show.Children.Metadata[0].originallyAvailableAt, season.originallyAvailableAt);
    assert.equal(show.Children.Metadata[1].originallyAvailableAt, undefined);
  }
  const undated = await read('season', 32);
  assert.equal(undated.originallyAvailableAt, undefined);
  assert.equal(undated.year, undefined);
});

test('Plex uses one provider for Aired, DVD, Absolute and named episode orders', async (t) => {
  const aired = { id: 30, seriesId: 1, number: 1, type: { id: 1, type: 'official' } };
  const dvd = { id: 31, seriesId: 1, number: 1, type: { id: 2, type: 'dvd', alternateName: 'DVD Volumes' } };
  const absolute = { id: 32, seriesId: 1, number: 1, type: { id: 3, type: 'absolute' } };
  const streaming = { id: 33, seriesId: 1, number: 2, type: { id: 4, type: 'alternate', alternateName: 'Streaming Order' } };
  const allOrders = [aired, dvd, absolute, streaming];
  const data = { id: 1, name: 'Example', firstAired: '2021-01-01', defaultSeasonType: 2, seasons: allOrders,
    remoteIds: [{ sourceName: 'TheMovieDB.com', id: '42' }] };
  const shared = { id: 21, seriesId: 1, name: 'Shared episode', aired: '2021-01-01', seasons: [aired, dvd, absolute] };
  const recut = { id: 41, seriesId: 1, name: 'Streaming cut', aired: '2021-04-21', seasons: [streaming] };
  const placeholder = { id: 50, seriesId: 2, number: 1, type: { id: 3, type: 'absolute' } };
  const specialsOnly = { id: 51, seriesId: 2, number: 0, type: { id: 4, type: 'alternate' } };
  const datedRegularSeason = { ...dvd, id: 52, seriesId: 2, number: 2 };
  const emptyFirstDvdSeason = { ...dvd, id: 53, seriesId: 2 };
  const upstreamRoutes = {
    '/login': { token: 'fixture-token' },
    '/search': [{ tvdb_id: '1', name: 'Example', year: '2021' }],
    '/search/remoteid/42': [{ series: { id: 1 } }],
    '/series/1/extended': data,
    '/series/2/extended': { id: 2, name: 'Partially populated show', firstAired: '2021-01-01',
      seasons: [{ ...aired, id: 49, seriesId: 2 }, placeholder, specialsOnly, datedRegularSeason, emptyFirstDvdSeason] },
    '/seasons/50/extended': { ...placeholder, episodes: [] },
    '/seasons/51/extended': { ...specialsOnly, episodes: [{ id: 63, number: 1 }] },
    '/seasons/52/extended': { ...datedRegularSeason, episodes: [{ id: 62, number: 1 }] },
    '/seasons/53/extended': { ...emptyFirstDvdSeason, episodes: [] },
    '/seasons/30/extended': { ...aired, episodes: [{ ...shared, number: 1 }] },
    '/seasons/31/extended': { ...dvd, episodes: [{ ...shared, number: 2 }] },
    '/seasons/32/extended': { ...absolute, episodes: [{ ...shared, number: 11 }] },
    '/seasons/33/extended': { ...streaming, episodes: [{ ...recut, number: 1 }] },
    '/episodes/21/extended': { ...shared, seasonNumber: 1, number: 2 },
    '/episodes/41/extended': { ...recut, seasonNumber: 1, number: 1 },
  };
  const upstream = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const value = upstreamRoutes[pathname];
    if (!value) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: value }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const provider = createProvider({ api_key: 'fixture-key', baseUrl, spacingMs: 0 });
  const base = await listen(provider);
  t.after(() => provider.close());
  const get = async (path, options, status = 200) => {
    const response = await fetch(base + path, options);
    assert.equal(response.status, status);
    const body = await response.json();
    return body.MediaContainer?.Metadata ?? body;
  };
  const match = (body) => get('/library/metadata/matches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const showPath = '/library/metadata/show-1';
  const discovery = (await get('/')).MediaProvider;
  assert.equal(discovery.title, 'TheTVDB');
  const [show] = await get(showPath + '?includeChildren=1');
  assert.equal(show.ratingKey, 'show-1');
  const [withPlaceholders] = await get('/library/metadata/show-2');
  assert.deepEqual(withPlaceholders.SeasonType.map(({ id }) => id), ['official', 'dvd']);
  const [matchedWithPlaceholders] = await match({ type: 2, guid: 'tvdb://2', includeChildren: 1 });
  assert.deepEqual(matchedWithPlaceholders.SeasonType, withPlaceholders.SeasonType);
  assert.deepEqual(show.SeasonType.map(({ id, title }) => [id, title]), [
    ['official', 'TheTVDB (Aired)'], ['dvd', 'TheTVDB (DVD Volumes)'],
    ['absolute', 'TheTVDB (Absolute)'], ['tvdbOrder4', 'TheTVDB (Streaming Order)'],
  ]);
  assert.equal(show.Children.Metadata[0].ratingKey, 'season-30');

  const inOrder = [
    ['official', aired, shared, 1],
    ['tvdbDVD', dvd, shared, 2],
    ['tvdbAbsolute', absolute, shared, 11],
    ['tvdbOrder4', streaming, recut, 1],
  ];
  for (const [order, selected, episode, index] of inOrder) {
    const seasonKey = 'season-' + selected.id;
    const episodeKey = 'episode-' + episode.id + (selected === aired ? '' : '-' + selected.id);
    const episodeGuid = discovery.identifier + '://episode/' + episodeKey;
    const [datedSeason] = await get(showPath + '/children?episodeOrdering=' + order);
    assert.equal(datedSeason.ratingKey, seasonKey);
    assert.equal(datedSeason.originallyAvailableAt, episode.aired);
    const [showMatch] = await match({ type: 2, guid: 'tvdb://1', episodeOrder: order, includeChildren: 1 });
    assert.equal(showMatch.guid, show.guid);
    assert.equal(showMatch.Children.Metadata[0].ratingKey, seasonKey);
    assert.deepEqual(await match({ type: 2, guid: 'tmdb://42', episodeOrder: order, includeChildren: 1 }),
      [showMatch]);
    const [seasonMatch] = await match({ type: 3, parentTitle: 'Example', index: selected.number,
      episodeOrder: order, includeChildren: 1 });
    assert.equal(seasonMatch.key, datedSeason.key);
    assert.equal(seasonMatch.Children.Metadata[0].guid, episodeGuid);
    // Plex can omit the order when it fetches a season or episode by key.
    const [seasonDetails] = await get(datedSeason.key + '?includeChildren=1');
    const [listedEpisode] = seasonDetails.Children.Metadata;
    assert.equal(listedEpisode.guid, episodeGuid);
    const [episodeDetails] = await get(listedEpisode.key);
    assert.equal(episodeDetails.guid, episodeGuid);
    assert.equal(episodeDetails.index, index);
    assert.equal(episodeDetails.parentIndex, selected.number);
    assert.deepEqual(episodeDetails.Guid, [{ id: 'tvdb://' + episode.id }]);
    assert.equal((await get(showPath + '/grandchildren?episodeOrder=' + order))[0].guid, episodeGuid);
    const [episodeMatch] = await match({ type: 4, grandparentTitle: 'Example', parentIndex: selected.number,
      index, episodeOrder: order });
    assert.equal(episodeMatch.guid, episodeGuid);
    const [externalMatch] = await match({ type: 4, guid: 'tvdb://' + episode.id, episodeOrder: order });
    assert.equal(externalMatch.guid, episodeGuid);
  }

  // The same cache must still resolve the original Aired coordinates after visiting the other orders.
  const [airedAgain] = await get('/library/metadata/episode-21');
  assert.equal(airedAgain.ratingKey, 'episode-21');
  assert.equal(airedAgain.index, 1);
  const [airedWithOrder] = await get('/library/metadata/episode-21?episodeOrder=official');
  assert.deepEqual(airedWithOrder, airedAgain);
  await get('/library/metadata/episode-21?episodeOrder=tvdbDVD', undefined, 404);
  assert.deepEqual(await get(showPath + '/children?episodeOrder=tvdbOrder99'), []);
  assert.deepEqual(await match({ type: 4, guid: 'tvdb://41', episodeOrder: 'official' }), []);
  await get('/library/metadata/episode-41-31', undefined, 404);
  await get('/library/metadata/episode-21-31?episodeOrder=official', undefined, 404);
});

test('a missing season does not hide a cached show or its dated siblings', async (t) => {
  let seriesFetches = 0;
  let missingSeasonStatus = 404;
  const routes = {
    '/login': { token: 'fixture-token' },
    '/series/1/extended': series,
    '/seasons/11/extended': special,
    '/search': [{ tvdb_id: '1', name: 'Example', year: '2021' }],
  };
  const upstream = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === '/series/1/extended') seriesFetches++;
    if (pathname === '/seasons/12/extended') {
      response.writeHead(missingSeasonStatus).end();
      return;
    }
    const data = routes[pathname];
    if (!data) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const provider = createProvider({ api_key: 'fixture-key', baseUrl, spacingMs: 0 });
  const base = await listen(provider);
  t.after(() => provider.close());

  const get = async (path, options) => {
    const response = await fetch(base + path, options);
    assert.equal(response.status, 200);
    return (await response.json()).MediaContainer;
  };
  const match = (body) => get('/library/metadata/matches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 2, includeChildren: 1, ...body }),
  });

  const showPath = '/library/metadata/show-1';
  await get(showPath);
  const [detail] = (await get(showPath + '?includeChildren=1')).Metadata;
  const [titleMatch] = (await match({ title: 'Example', year: 2021 })).Metadata;
  const [guidMatch] = (await match({ guid: 'tvdb://1' })).Metadata;
  const listing = await get(showPath + '/children');
  for (const show of [detail, titleMatch, guidMatch]) {
    assert.equal(show.ratingKey, 'show-1');
  }
  for (const children of [detail.Children, titleMatch.Children, guidMatch.Children, listing]) {
    assert.deepEqual(children.Metadata.map((row) => [row.ratingKey, row.originallyAvailableAt]),
      [['season-11', '2020-12-01'], ['season-12', undefined]]);
  }
  assert.equal(seriesFetches, 1);
  const missingPage = await get(showPath + '/children?X-Plex-Container-Start=1&X-Plex-Container-Size=1');
  assert.equal(missingPage.totalSize, 2);
  assert.equal(missingPage.Metadata[0].ratingKey, 'season-12');
  assert.equal((await fetch(base + '/library/metadata/season-12')).status, 404);
  assert.deepEqual((await get(showPath + '/grandchildren')).Metadata.map((row) => row.ratingKey), ['episode-200']);

  missingSeasonStatus = 500;
  assert.equal((await fetch(base + showPath + '?includeChildren=1')).status, 502);
});

test('show requests keep available orders and load requested seasons before optional checks', async (t) => {
  const dvdFirst = { id: 31, number: 1, seriesId: 1, type: { type: 'dvd' }, episodes: [] };
  const dvdSecond = { ...dvdFirst, id: 32, number: 2, episodes: aired.episodes };
  const routes = {
    '/login': { token: 'fixture-token' },
    '/series/1/extended': { ...series, seasons: [aired, dvdFirst, dvdSecond] },
    '/search': [{ tvdb_id: '1', name: 'Example', year: '2021' }],
    '/seasons/12/extended': aired,
    '/seasons/31/extended': dvdFirst,
    '/seasons/32/extended': dvdSecond,
  };
  const seasonRequests = [];
  let firstDvdStatus = 500;
  let seasonQuota = Infinity;
  const upstream = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname.startsWith('/seasons/')) {
      seasonRequests.push(pathname);
      if (seasonRequests.length > seasonQuota) return response.writeHead(429, { 'Retry-After': '8' }).end();
      if (pathname === '/seasons/31/extended' && firstDvdStatus) return response.writeHead(firstDvdStatus).end();
    }
    const data = routes[pathname];
    if (!data) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const start = async (testCase) => {
    const provider = createProvider({ api_key: 'fixture-key', baseUrl, spacingMs: 0 });
    testCase.after(() => provider.close());
    return listen(provider);
  };
  const match = (base, params, includeChildren) => fetch(base + '/library/metadata/matches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 2, episodeOrder: 'official', includeChildren, ...params }),
  });
  const callers = [
    ['show detail', (base, children) => fetch(base + '/library/metadata/show-1?episodeOrder=official&includeChildren=' + children)],
    ['title match', (base, children) => match(base, { title: 'Example', year: 2021 }, children)],
    ['TVDB GUID match', (base, children) => match(base, { guid: 'tvdb://1' }, children)],
  ];

  for (const [name, call] of callers) {
    await t.test(name + ' advertises DVD when a later cached season has episodes', async (testCase) => {
      seasonRequests.length = 0;
      const base = await start(testCase);
      const warm = await fetch(base + '/library/metadata/season-32/children');
      assert.equal(warm.status, 200);
      assert.equal((await warm.json()).MediaContainer.size, 2);
      const response = await call(base, 0);
      assert.equal(response.status, 200);
      const [show] = (await response.json()).MediaContainer.Metadata;
      assert.deepEqual(show.SeasonType.map(({ id }) => id), ['official', 'dvd']);
      assert.deepEqual(seasonRequests, ['/seasons/32/extended', '/seasons/31/extended']);
    });
  }

  firstDvdStatus = 0;
  seasonQuota = 1;
  for (const [name, call] of callers) {
    await t.test(name + ' returns Aired children when an optional season hits the rate limit', async (testCase) => {
      seasonRequests.length = 0;
      const base = await start(testCase);
      const response = await call(base, 1);
      assert.equal(response.status, 200);
      const [show] = (await response.json()).MediaContainer.Metadata;
      assert.deepEqual(show.SeasonType.map(({ id }) => id), ['official']);
      assert.deepEqual(show.Children.Metadata.map(({ ratingKey, originallyAvailableAt }) => [ratingKey, originallyAvailableAt]),
        [['season-12', '2021-01-01']]);
      assert.deepEqual(seasonRequests, ['/seasons/12/extended', '/seasons/31/extended']);
    });
  }

  await t.test('manual title match loads all candidates before checking alternate orders', async (testCase) => {
    const secondAired = {
      ...aired, id: 22, seriesId: 2,
      episodes: [{ ...aired.episodes[0], id: 301, seriesId: 2, aired: '2022-01-01' }],
    };
    routes['/search'].push({ tvdb_id: '2', name: 'Example', year: '2022' });
    routes['/series/2/extended'] = { ...series, id: 2, firstAired: '2022-01-01', seasons: [secondAired] };
    routes['/seasons/22/extended'] = secondAired;
    seasonQuota = 2;
    seasonRequests.length = 0;
    const base = await start(testCase);
    const response = await match(base, { title: 'Example', manual: 1 }, 1);
    assert.equal(response.status, 200);
    const { Metadata } = (await response.json()).MediaContainer;
    assert.deepEqual(Metadata.map((show) => [show.ratingKey, show.Children.Metadata[0].ratingKey,
      show.Children.Metadata[0].originallyAvailableAt]), [
      ['show-1', 'season-12', '2021-01-01'],
      ['show-2', 'season-22', '2022-01-01'],
    ]);
    assert.deepEqual(seasonRequests, ['/seasons/12/extended', '/seasons/22/extended', '/seasons/31/extended']);
  });
});

test('direct external show GUIDs return the same Plex identity, artwork and enriched metadata as title matches', async (t) => {
  const poster = 'https://artworks.thetvdb.com/poster-alternate.jpg';
  const background = 'https://artworks.thetvdb.com/background.jpg';
  const logo = 'https://artworks.thetvdb.com/logo.png';
  const seasonBackground = 'https://artworks.thetvdb.com/season-background.jpg';
  const photo = 'https://artworks.thetvdb.com/cast.jpg';
  const enriched = {
    ...series,
    image: '/banners/posters/1.jpg',
    averageRuntime: 30,
    originalCountry: 'usa',
    originalNetwork: { name: 'Example Network' },
    latestNetwork: { name: 'Hulu' },
    genres: [{ name: 'Comedy' }, null, { name: 'Comedy' }],
    companies: [
      { name: 'Example Network', primaryCompanyType: 1 },
      { name: 'Comedy Central', companyType: { companyTypeId: 1 } },
      { name: 'Example Studio', companyType: { companyTypeId: 2 } },
      { name: 'Example Production', companyType: { companyTypeId: 0 }, primaryCompanyType: 3 },
      { name: 'Example Distributor', companyType: { companyTypeId: 4 }, primaryCompanyType: 3 },
    ],
    characters: [
      { type: 4, personName: 'Guest Actor', name: 'Guest', sort: 2 },
      { type: 3, personName: 'Main Actor', name: 'Lead', personImgURL: '/cast.jpg', sort: 1 },
      { type: 2, personName: 'The Writer' },
      { type: 1, personName: 'The Director' },
      { type: 11, personName: 'The Producer' },
      { type: 3, name: 'No credited actor' },
    ],
    contentRatings: [{ country: 'usa', name: 'TV-14' }, { country: 'can', name: 'PG' }],
    artworks: [
      { type: 2, image: series.image }, { type: 2, image: 'poster-alternate.jpg' },
      { type: 3, image: '/background.jpg' }, { type: 3, image: background },
      { type: 23, image: '//artworks.thetvdb.com/logo.png' },
      { type: 2, image: 'file:///invalid-poster.jpg' },
      { type: 7, image: 'https://artworks.thetvdb.com/unrelated-season.jpg' }, null,
    ],
    remoteIds: [...series.remoteIds, { sourceName: 'TheMovieDB.com', id: '1668' }],
    seasons: series.seasons.slice(0, 2),
  };
  const collision = { id: 2, name: 'Different show', remoteIds: [{ sourceName: 'Other Provider', id: '1668' }] };
  const tmdbDuplicate = (id) => ({ id, name: 'Duplicate', remoteIds: [{ sourceName: 'TMDB', id: '444' }] });
  const routes = {
    '/login': { token: 'fixture-token' },
    '/search': [{ tvdb_id: '1', name: 'Example', year: '2021' }],
    '/search/remoteid/tt0123456': [{ series: { id: 1 } }, { movie: { id: 44 } }],
    '/search/remoteid/1668': [{ series: { id: 2 } }, { movie: { id: 7 } }, { series: { id: 1 } }, { series: { id: 1 } }],
    '/search/remoteid/777': [{ series: { id: 2 } }],
    '/search/remoteid/444': [{ series: { id: 3 } }, { series: { id: 4 } }],
    '/series/1/extended': enriched,
    '/series/2/extended': collision,
    '/series/3/extended': tmdbDuplicate(3),
    '/series/4/extended': tmdbDuplicate(4),
    '/seasons/11/extended': special,
    '/seasons/12/extended': { ...aired, artwork: [{ type: 8, image: '/season-background.jpg' }] },
    '/episodes/202/extended': {
      ...episodes[2], image: '/banners/episodes/202.jpg',
      characters: [{ type: 1, personName: 'Episode Director', image: '/cast.jpg' }],
      contentRatings: [{ country: 'usa', name: 'TV-G' }, { country: 'can', name: 'G' }],
    },
  };
  const requests = [];
  const upstream = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    requests.push(pathname);
    if (pathname === '/search/remoteid/888') return response.writeHead(429, { 'Retry-After': '8' }).end();
    const data = routes[pathname];
    if (!data) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const provider = createProvider({ api_key: 'fixture-key', baseUrl, spacingMs: 0 });
  const base = await listen(provider);
  t.after(() => provider.close());
  const get = async (path, options) => {
    const response = await fetch(base + path, options);
    assert.equal(response.status, 200);
    return (await response.json()).MediaContainer;
  };
  const matchOptions = (params) => ({
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Plex-Country': 'CA' },
    body: JSON.stringify({ type: 2, includeChildren: 1, ...params }),
  });
  const match = (params) => get('/library/metadata/matches', matchOptions(params));

  const [byTitle] = (await match({ title: 'Example' })).Metadata;
  assert.deepEqual(byTitle.Guid.map(({ id }) => id), ['tvdb://1', 'imdb://tt0123456', 'tmdb://1668']);
  for (const id of ['tvdb://1', 'imdb://tt0123456', 'tmdb://1668']) {
    const [byId] = (await match({ guid: id, title: 'Unrelated' })).Metadata;
    assert.deepEqual(byId, byTitle, id);
  }
  for (const guid of ['imdb://tt9999999', 'tmdb://777', 'tmdb://444']) {
    assert.equal((await match({ guid, title: 'Example' })).size, 0);
  }
  assert.equal(requests.filter((path) => path === '/search').length, 1);
  assert.equal(requests.filter((path) => path === '/series/1/extended').length, 1);

  assert.equal(byTitle.duration, 1800000);
  assert.equal(byTitle.contentRating, 'ca/PG');
  assert.deepEqual(byTitle.Genre, [{ tag: 'Comedy' }]);
  assert.deepEqual(byTitle.Country, [{ tag: 'United States' }]);
  assert.deepEqual(byTitle.Network, [{ tag: 'Example Network' }, { tag: 'Comedy Central' }, { tag: 'Hulu' }]);
  assert.deepEqual(byTitle.Studio, [{ tag: 'Example Studio' }, { tag: 'Example Production' }]);
  assert.deepEqual(byTitle.Role, [
    { tag: 'Main Actor', role: 'Lead', thumb: photo, order: 0 },
    { tag: 'Guest Actor', role: 'Guest', order: 1 },
  ]);
  assert.deepEqual(byTitle.Director, [{ tag: 'The Director' }]);
  assert.deepEqual(byTitle.Writer, [{ tag: 'The Writer' }]);
  assert.deepEqual(byTitle.Producer, [{ tag: 'The Producer' }]);
  assert.equal(byTitle.thumb, series.image);
  assert.equal(byTitle.art, background);
  assert.deepEqual(byTitle.Image, [
    { type: 'coverPoster', url: series.image }, { type: 'coverPoster', url: poster },
    { type: 'background', url: background }, { type: 'clearLogo', url: logo },
  ]);
  assert.deepEqual((await get(byTitle.key + '/images')).Image, byTitle.Image);
  assert.deepEqual((await get(byTitle.key + '?includeChildren=1&X-Plex-Country=CAN')).Metadata[0], byTitle);
  assert.equal((await get(byTitle.key)).Metadata[0].contentRating, 'TV-14');
  assert.equal((await get(byTitle.key + '?X-Plex-Country=GB')).Metadata[0].contentRating, undefined);
  const season = byTitle.Children.Metadata[1];
  assert.deepEqual((await get(season.key)).Metadata[0], season);
  assert.deepEqual((await get(season.key + '/images')).Image, [
    { type: 'coverPoster', url: aired.image }, { type: 'background', url: seasonBackground },
  ]);
  const episodeKey = '/library/metadata/episode-202';
  const [episode] = (await get(episodeKey + '?X-Plex-Country=CA')).Metadata;
  assert.deepEqual(episode.Director, [{ tag: 'Episode Director', thumb: photo }]);
  assert.equal(episode.thumb, episodes[2].image);
  assert.equal(episode.contentRating, 'ca/G');
  assert.equal((await get(episodeKey)).Metadata[0].contentRating, 'TV-G');
  assert.deepEqual((await match({ type: 4, guid: 'tvdb://202' })).Metadata, [episode]);

  const limited = await fetch(base + '/library/metadata/matches', matchOptions({ guid: 'tmdb://888' }));
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get('retry-after'), '8');
});

test('a cached IMDb search cannot match a series whose cross-reference has changed', async (t) => {
  let now = 100_000;
  const originalId = 'tt0123456';
  const currentId = 'tt0123457';
  const lookups = [];
  const seriesReads = [];
  let reassigned = false;
  const upstream = createServer((request, response) => {
    const path = request.url;
    let data;
    if (path === '/login') data = { token: 'fixture-token' };
    if (path === '/search/remoteid/' + originalId) {
      lookups.push(path);
      data = [{ series: { id: reassigned ? 2 : 1 } }];
    }
    if (path === '/series/1/extended' || path === '/series/2/extended') {
      seriesReads.push(path);
      const id = Number(path.split('/')[2]);
      data = {
        ...series, id, seasons: [],
        remoteIds: [{ sourceName: 'IMDB', id: reassigned && id === 1 ? currentId : originalId }],
      };
    }
    if (!data) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const provider = createProvider({ api_key: 'fixture-key', baseUrl, spacingMs: 0, now: () => now });
  const base = await listen(provider);
  t.after(() => provider.close());
  const match = async (params) => {
    const reply = await fetch(base + '/library/metadata/matches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 2, ...params }),
    });
    assert.equal(reply.status, 200);
    return (await reply.json()).MediaContainer.Metadata;
  };
  const day = 24 * 60 * 60 * 1000;
  const guid = 'imdb://' + originalId;
  const warm = await fetch(base + '/library/metadata/show-1');
  assert.equal(warm.status, 200);
  await warm.json();
  now += 60_000;
  assert.equal((await match({ guid }))[0].ratingKey, 'show-1');
  assert.equal(seriesReads.length, 1);

  reassigned = true;
  now += day - 30_000;
  assert.deepEqual(await match({ guid, title: 'Example' }), []);
  assert.deepEqual(await match({ filename: `Example {imdb-${originalId}}/Pilot.mkv` }), []);
  assert.equal(lookups.length, 1);
  assert.equal(seriesReads.length, 2);

  now += 60_000;
  assert.equal((await match({ guid }))[0].ratingKey, 'show-2');
  assert.equal(lookups.length, 2);
});

test('custom provider identifiers preserve case and reject disallowed characters', () => {
  const source = new URL('../application/provider.mjs', import.meta.url).href;
  const command = `
    import { createProvider } from ${JSON.stringify(source)};
    const server = createProvider({ api_key: 'fixture-key', cacheTtlMs: 0 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/');
    console.log(JSON.stringify((await response.json()).MediaProvider));
    server.close();
  `;
  const run = (identifier) => spawnSync(process.execPath, ['--input-type=module', '-e', command], {
    env: { ...process.env, PLEX_PROVIDER_IDENTIFIER: identifier }, encoding: 'utf8', timeout: 5000,
  });

  const identifier = 'tv.plex.agents.custom.Review.Legacy';
  const accepted = run(identifier);
  assert.equal(accepted.status, 0, accepted.stderr);
  const discovery = JSON.parse(accepted.stdout);
  assert.equal(discovery.identifier, identifier);
  assert.ok(discovery.Types.every(({ Scheme }) => Scheme[0].scheme === identifier));

  const rejected = run('tv.plex.agents.custom.review-legacy');
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /PLEX_PROVIDER_IDENTIFIER must be a valid Plex custom provider identifier/);
});

test('cache coalescing, persistence, default and configured expiration, and disabling', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'plex-tvdb-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let calls = 0;
  let logins = 0;
  let now = 100000;
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/login') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { apikey: 'fixture-key' });
      logins++;
      response.end(JSON.stringify({ data: { token: 'fixture-token' } }));
      return;
    }
    assert.equal(request.url, '/series/1/extended');
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    calls++;
    response.end(JSON.stringify({ data: { ...series, seasons: [], name: 'Revision ' + calls } }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const config = { api_key: 'fixture-key', baseUrl, now: () => now, spacingMs: 0,
    cachePath: join(directory, 'tvdb.sqlite3') };
  const title = async (base) => {
    const reply = await fetch(base + '/library/metadata/show-1');
    assert.equal(reply.status, 200);
    return (await reply.json()).MediaContainer.Metadata[0].title;
  };
  const first = createProvider(config);
  const firstBase = await listen(first);
  assert.deepEqual(await Promise.all([title(firstBase), title(firstBase), title(firstBase)]),
    ['Revision 1', 'Revision 1', 'Revision 1']);
  await new Promise((resolve) => first.close(resolve));
  assert.equal(calls, 1);
  assert.equal(logins, 1);

  const second = createProvider(config);
  const secondBase = await listen(second);
  t.after(() => second.close());
  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal(await title(secondBase), 'Revision 1');
  assert.equal(calls, 1);
  assert.equal(logins, 1);
  now += 1;
  assert.deepEqual(await (await fetch(secondBase + '/stats')).json(), { cachedShows: 0, cachedEpisodes: 0 });
  assert.equal(calls, 1);
  assert.equal(await title(secondBase), 'Revision 2');
  assert.equal(calls, 2);
  assert.equal(logins, 2);

  const sixHours = 6 * 60 * 60 * 1000;
  const shorter = createProvider({ ...config, cacheTtlMs: sixHours });
  const shorterBase = await listen(shorter);
  t.after(() => shorter.close());
  now += sixHours - 1;
  assert.equal(await title(shorterBase), 'Revision 2');
  now += 1;
  assert.equal(await title(shorterBase), 'Revision 3');

  const disabled = createProvider({ ...config, cacheTtlMs: 0 });
  const disabledBase = await listen(disabled);
  t.after(() => disabled.close());
  assert.deepEqual(await Promise.all([title(disabledBase), title(disabledBase)]),
    ['Revision 4', 'Revision 4']);
  assert.equal(await title(disabledBase), 'Revision 5');
  assert.deepEqual(await (await fetch(disabledBase + '/stats')).json(), { cachedShows: 0, cachedEpisodes: 0 });
  assert.equal(await title(shorterBase), 'Revision 3');
  assert.equal(calls, 5);
});

test('TVDB 429 suppresses new upstream requests until Retry-After and a failure is never cached', async (t) => {
  let calls = 0;
  let now = 100000;
  const upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/login') {
      response.end(JSON.stringify({ data: { token: 'fixture-token' } }));
      return;
    }
    calls++;
    if (calls === 1) {
      response.writeHead(429, { 'Retry-After': '12' }).end();
      return;
    }
    response.end(JSON.stringify({ data: { ...series, seasons: [] } }));
  });
  const baseUrl = await listen(upstream);
  t.after(() => upstream.close());
  const provider = createProvider({ api_key: 'fixture-key', baseUrl, now: () => now, spacingMs: 0 });
  const base = await listen(provider);
  t.after(() => provider.close());

  const request = (id) => fetch(base + '/library/metadata/show-' + id);
  const first = await request(1);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('Retry-After'), '12');
  now += 11000;
  const other = await request(2);
  assert.equal(other.status, 503);
  assert.equal(other.headers.get('Retry-After'), '1');
  assert.equal(calls, 1);
  now += 1000;
  assert.equal((await request(1)).status, 200);
  assert.equal(calls, 2);
});
