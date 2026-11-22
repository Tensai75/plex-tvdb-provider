# Plex TVDB Provider

A self-hosted [TheTVDB](https://thetvdb.com/) metadata provider for Plex TV libraries. It supplies show, season, and episode metadata and artwork using TheTVDB Aired episode order, including specials. Multiple Plex servers can use one instance and share its 24-hour SQLite cache.

## Install with Docker Compose

You need Docker with Compose, Plex Media Server 1.43 or newer, and a [TheTVDB v4 API key](https://thetvdb.com/api-information) authorized for your use. Supply a subscriber PIN only if your key uses TheTVDB's subscriber model.

1. Save [compose.yaml](compose.yaml) and [.env.example](.env.example) in the same directory.
2. Copy `.env.example` to `.env` and put your key in `TVDB_API_KEY`. Leave `TVDB_PIN` empty if your key works without a PIN.
3. Start the provider.

   ```sh
   docker compose up -d
   curl -fsS http://localhost:3000/health
   ```

The Compose file pulls a versioned Linux amd64 image from GitHub Container Registry. Docker keeps the cache in the `tvdb-cache` volume across container updates. Set `PLEX_TVDB_PORT` in `.env` if host port 3000 is already in use. Keep the port reachable from your Plex servers on your local network. The provider has no client authentication.

If you prefer plain Docker, use the same `.env` file and the default port.

```sh
docker run -d --name plex-tvdb-provider --restart unless-stopped \
  --env-file .env -p 3000:3000 -v plex-tvdb-cache:/data \
  ghcr.io/marciocm/plex-tvdb-provider:v0.1.0
```

## Add the provider in Plex

1. Open Plex Web as the server owner and select the correct server. Go to **Settings → Metadata Agents → Add Provider**.
2. Enter `http://<docker-host-ip>:3000` and save. Use the Docker host's address as seen from **Plex Media Server**. If Plex runs in a container on the same Docker network, you can use the provider's service name and container port instead. Use the root URL, including any host port you changed.
3. On the same settings page, select **Add Agent**, name it **TheTVDB Aired**, and select the **TheTVDB Aired** provider as its primary provider. Save the agent.
4. Create a small **TV Shows** test library. In **Advanced**, choose **Plex TV Series** as the scanner and select your new agent. If Plex offers an episode-ordering selector, choose **TheTVDB (Aired)**. Scan a show and check the poster, season numbers, and episode matches.
5. Once the test looks right, you can select the same agent under **Manage Library → Edit → Advanced** for an existing TV library. Plex uses the new agent for new items. For existing items, start with **Refresh Metadata** on a single show and verify its numbering and watched status before refreshing a whole library.

Register the same provider URL on each Plex server that should use it. See [Plex's Custom Metadata Providers guide](https://forums.plex.tv/t/announcement-custom-metadata-providers/934384/) for the distinction between providers and agents.

## Limits and troubleshooting

- This beta supports TV shows with TheTVDB **Aired** episode order. DVD and alternate orders are outside its current scope.
- Custom agents use their own Plex GUIDs. Plex's [cloud watch-state and ratings sync](https://support.plex.tv/articles/sync-watch-state-and-ratings/) requires the built-in Plex TV Series agent for TV libraries. Check existing local watch state on your test show before switching a library.
- If Plex cannot add the provider, verify that the exact URL is reachable from the Plex server. The root URL should return a JSON object containing `MediaProvider`. If it registers but cannot fetch a show, run `docker compose logs plex-tvdb-provider` to check for TheTVDB authentication, connectivity, or rate-limit errors. `/health` checks that the local process is serving HTTP. `/stats` shows cached show and episode counts.
- Folder IDs such as `{tvdb-123456}` or `{imdb-tt1234567}` can help disambiguate shows when Plex sends the path. Keep season and episode filenames aligned with TheTVDB Aired numbering.

## Build and test from source

Clone this repository and set up `.env` as above. Build the image locally with the tag used by Compose.

```sh
docker build -t "$(docker compose config --images)" .
docker compose up -d --pull never
```

With Node.js 22.13 or newer, run the integration tests with `node --test test/test_provider.mjs`. The tests use a local HTTP fixture for TheTVDB and real SQLite.

The code is [MIT licensed](LICENSE). Metadata and artwork are provided by [TheTVDB](https://thetvdb.com/) under its [API terms](https://thetvdb.com/api-information).
