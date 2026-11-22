import assert from 'node:assert/strict';
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
  await request(show.key + '?episodeOrder=tvdbAbsolute', {}, 404);
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
  assert.equal((await request(show.key + '/children?episodeOrdering=dvd', {}, 404)).error,
    'Only TVDB Aired ordering is available');
  assert.equal((await match({ type: 2, title: 'Name', year: 2021 })).MediaContainer.size, 0);
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
    response.end(JSON.stringify({ data: { ...series, name: 'Revision ' + calls } }));
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
    response.end(JSON.stringify({ data: series }));
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
