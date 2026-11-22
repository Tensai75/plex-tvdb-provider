# Plex TVDB Provider

A self-hosted [TheTVDB](https://thetvdb.com/) metadata provider for Plex TV libraries. It supplies show, season, and episode metadata using TheTVDB episode orders, including specials. Where TheTVDB has the data, Plex receives cast and crew, genres, networks and studios, regional content ratings, posters, backgrounds, logos, and episode snapshots. Multiple Plex servers can use one instance and share a persistent SQLite cache. The provider coalesces concurrent requests for the same metadata and honors TheTVDB rate-limit responses.

## Install with Docker Compose

You need Docker with Compose, Plex Media Server 1.43 or newer, and a [TheTVDB v4 API key](https://thetvdb.com/api-information) authorized for your use. Supply a subscriber PIN only if your key uses TheTVDB's subscriber model.

1. Save [compose.yaml](compose.yaml) and [.env.example](.env.example) in the same directory.
2. Copy `.env.example` to `.env` and put your key in `TVDB_API_KEY`. Leave `TVDB_PIN` empty if your key works without a PIN.
3. Start the provider.

   ```sh
   docker compose up -d
   curl -fsS http://localhost:3000/health
   ```

The Compose file pins the Linux amd64 image to `v0.1.0`. GitHub Container Registry also offers a `latest` tag for the most recently published stable release. Docker keeps the cache in the `tvdb-cache` volume across container updates. Set `PLEX_TVDB_PORT` in `.env` if host port 3000 is already in use. Keep the port reachable from your Plex servers on your local network. The provider has no client authentication.

If you prefer plain Docker, use the same `.env` file and the default port.

```sh
docker run -d --name plex-tvdb-provider --restart unless-stopped \
  --env-file .env -p 3000:3000 -v plex-tvdb-cache:/data \
  ghcr.io/marciocm/plex-tvdb-provider:v0.1.0
```

## Configure the cache

Set `TVDB_CACHE_TTL_HOURS` in `.env` to a non-negative whole number. The default is `24`. Use `1` or `6` for a shorter cache, or `0` to disable it. The duration is measured from the last fetch from TheTVDB. Reading an entry does not extend its lifetime. Run `docker compose up -d` after editing `.env` to apply the change.

With the cache disabled, the provider leaves the SQLite volume untouched and still shares simultaneous requests for the same metadata. TheTVDB request pacing and rate-limit backoff still apply.

## Add the provider in Plex

1. Open Plex Web as the server owner and select the correct server. Go to **Settings → Metadata Agents → Add Provider**.
2. Enter `http://<docker-host-ip>:3000` and save. Use the Docker host's address as seen from **Plex Media Server**. If Plex runs in a container on the same Docker network, you can use the provider's service name and container port instead. Use the root URL, including any host port you changed.
3. On the same settings page, select **Add Agent**, name it **TheTVDB**, and select the **TheTVDB** provider as its primary provider. Save the agent.
4. Create a **TV Shows** library or open **Manage Library → Edit** on an existing one. Under **Advanced**, select **Plex TV Series** as the scanner and **TheTVDB** as the agent. Save the library.
5. Plex uses the selected agent for new items. To apply it to existing shows, use **Refresh Metadata** on a show or **Refresh All Metadata** in the library menu.

Register the same provider URL on each Plex server that should use it. See [Plex's Custom Metadata Providers guide](https://forums.plex.tv/t/announcement-custom-metadata-providers/934384/) for the distinction between providers and agents.

## Choose an episode order

The provider defaults to **TheTVDB (Aired)**. To use a different order, open the show in Plex Web and select **Edit → Advanced → Episode ordering**. Plex can list **DVD**, **Absolute**, and named orders such as **Streaming Order** when TheTVDB has numbered episodes for that order. Match the season and episode numbers in your filenames to the order you choose.

## How show matching works

When Plex supplies an external show GUID in a match request, the provider accepts `tvdb://123456`, `imdb://tt1234567`, and `tmdb://123456`. IMDb and TMDB IDs must match the corresponding cross-reference on exactly one series. Metadata and episode ordering come from TheTVDB for all three ID formats.

When Plex sends a media path with an IMDb ID, the provider can also use that ID. A show folder can include `imdb-tt1234567`, `{imdb-tt1234567}`, `[imdb-tt1234567]`, or `(imdb-tt1234567)`. A `{tvdb-123456}` tag takes precedence if both are present. When Plex sends no supported ID, the provider searches by show title or alias and uses the year when available.

In **Sonarr → Settings → Media Management**, enable **Show Advanced**. This **Series Folder Format** adds the IMDb ID.

```text
{Series CleanTitleWithoutYear} ({Series Year}) {imdb-{ImdbId}}
```

Keep the `imdb-` prefix. The outer braces are optional. [Sonarr supports the IMDb token for series folders](https://wiki.servarr.com/sonarr/settings#series-folder-format). [Radarr also supports IMDb IDs in movie folder names](https://wiki.servarr.com/radarr/settings#movie-folder-format). This provider serves TV libraries.

## Limits and troubleshooting

- Custom agents use their own Plex GUIDs. Plex's [cloud watch-state and ratings sync](https://support.plex.tv/articles/sync-watch-state-and-ratings/) requires the built-in Plex TV Series agent for TV libraries.
- If Plex cannot add the provider, verify that the exact URL is reachable from the Plex server. The root URL should return a JSON object containing `MediaProvider`. If it registers but cannot fetch a show, run `docker compose logs plex-tvdb-provider` to check for TheTVDB authentication, connectivity, or rate-limit errors. `/health` checks that the local process is serving HTTP. `/stats` shows cached show and episode counts.

## Build and test from source

Clone this repository and set up `.env` as above. Build the image locally with the tag used by Compose.

```sh
docker build -t "$(docker compose config --images)" .
docker compose up -d --pull never
```

With Node.js 22.13 or newer, run the integration tests with `node --test test/test_provider.mjs`. The tests use a local HTTP fixture for TheTVDB and real SQLite.

The code is [MIT licensed](LICENSE). Metadata and artwork are provided by [TheTVDB](https://thetvdb.com/) under its [API terms](https://thetvdb.com/api-information).
