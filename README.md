# Aurral plugin: Mornye Python

An [Aurral](https://docs.aurral.org/api/plugins/) download source that asks a
[Mornye Python](https://github.com/mornyeapp/Mornye-Python) server (web mode, in Docker)
for single tracks. Plugin API `1` (beta).

Mornye ships with no providers. You supply your own extension registry
(`MORNYE_REGISTRIES`), and you are responsible for what you configure and for
complying with local law and provider terms. This plugin only talks to Mornye's REST API.

## How it works

- **Search**: `GET /api/v1/search` (Spotify catalogue via Mornye), ranked by title, artist, album and duration.
- **Track download**: `POST /api/v1/downloads` with a per-download `output_dir` inside a folder shared
  by both containers. Aurral polls `status` until Mornye reports `done`, then the plugin hardlinks
  (or copies) the audio into Aurral's `directory` and deletes the temporary folder.
- **Track-only, on purpose.** An album-capable source is pulled into Aurral's release-first step, which
  runs even for single-song requests. Mornye can't deliver an exact release in one download, so that
  queued whole albums whose tracks Aurral then rejected. Album requests still reach this plugin track by
  track, after album-capable clients (slskd, Usenet, …) have had their turn.
- **Cancel/failure**: `discard` cancels the Mornye job and removes the temporary folder.

## Requirements

- Mornye in **single-user** web mode (multi-user ignores `output_dir`). Set `MORNYE_WEB_TOKEN`.
- A folder mounted into both containers, ideally at the **same container path** (Aurral's recommended
  layout), so you only fill in *Shared download folder*. Aurral's *Remote path mappings* don't apply to plugins,
  so if the paths differ, also set *Shared folder path in Aurral*. See [docker-compose.example.yml](docker-compose.example.yml).
  Mornye's user (`PUID`/`PGID`) must be able to write to it. Hardlinks need it on the same filesystem as
  Aurral's library, otherwise files are copied.
- Leave *Providers* empty to let Mornye use every installed, enabled provider in its priority order with
  fallback. Set it only to restrict the plugin to specific extension ids. **Test** lists the providers Mornye reports.
- Don't point Mornye's "existing library folders" at your Aurral library: Mornye skips tracks it finds
  there and writes nothing, and the download fails with "wrote no audio".
- Priority: Aurral tries the plugin in its Download clients order (default: after SABnzbd/NZBGet, before
  qBittorrent). Drag it up, or lower its *Priority*, to have Mornye tried before other clients.

## Install

In Aurral: **Settings > Plugins**, paste this repository's link. Or copy the `mornye-python`
folder into the `plugins` folder of Aurral's data folder. Fill in the settings and press **Test**.

## Development

```sh
npm test   # node:test against a mock Mornye server; Node 20+, no dependencies
```

`mornye-python/index.js` has no imports beyond Node built-ins, as Aurral doesn't install packages.
Change `repository` in `manifest.json` to your repo URL.
