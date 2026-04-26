# TorrentLeech HNR — Claude Context

## What this project does

Automated script that monitors the TorrentLeech HNR (Hit and Run) page for the user `Fabrizio5680`, downloads `.torrent` files for any entries not yet seeded, injects them into a remote qBittorrent instance, and deletes them (with data) once the seeding requirement is met.

## Stack

- Node.js ESM (`"type": "module"`)
- `axios` + `axios-cookiejar-support` + `tough-cookie` — HTTP client with persistent cookie jar
- `cheerio` — server-side HTML parsing
- `form-data` — multipart uploads
- `dotenv` — environment config

## Key files

- `index.js` — single-file implementation, all logic lives here
- `.env` — credentials (never commit)
- `cookies.json` — TorrentLeech session cookie jar, auto-managed (never commit)
- `cron.log` — output from scheduled runs (never commit)

## Environment variables (`.env`)

| Key | Purpose |
|---|---|
| `USERNAME` | TorrentLeech username |
| `PASSWORD` | TorrentLeech password |
| `EMAIL` | TorrentLeech email (not used in script, kept for reference) |
| `QT_URL` | qBittorrent Web UI base URL (no trailing slash) |
| `QT_USERNAME` | qBittorrent Web UI username |
| `QT_PASSWORD` | qBittorrent Web UI password |
| `QT_WEBUI_PORT` | qBittorrent port (handled by reverse proxy, not appended to URL) |
| `QT_CATEGORY` | qBittorrent category label for injected torrents |

## How it works (per run)

1. Load `cookies.json` → test HNR page → re-login if session expired
2. **Prune**: delete qBittorrent torrents (category) where `seeding_time >= seeding_time_limit * 60`
3. Paginate all HNR pages, parse col 1 (torrent ID via `onclick`) + col 5 (seeding time in minutes)
4. **Skip**: IDs already tracked — detected via `tl-{torrentId}` tag on qBittorrent torrents
5. **Add**: fetch torrent page → extract download link → stream `.torrent` to temp file → `POST /api/v2/torrents/add` with `forceStart=true`, category, tag `tl-{torrentId}`, and `seedingTimeLimit = (PRUNE_MINS - alreadySeedingMins)`

## Seeding threshold

`PRUNE_DAYS = 9` (8-day TL requirement + 1-day buffer). Parsed from text like `"7 days, 19 hrs, 33 mins, 24 secs"`.

## Running

```bash
node index.js            # normal run
node index.js --dry-run  # preview only — no downloads, no uploads, no state changes
```

## Cron (on seedbox — Debian 11, nvm node)

```
0 3 * * * cd /home/flexget99/torrentleech-hnr && /home/flexget99/.nvm/versions/node/v24.14.1/bin/node index.js >> /home/flexget99/torrentleech-hnr/cron.log 2>&1
```

## TorrentLeech auth notes

- Login: `POST https://www.torrentleech.org/user/account/login/` with `multipart/form-data` fields `username` + `password`
- No CAPTCHA — confirmed via Prowlarr indexer source
- Session cookie lasts ~30 days; stored in `cookies.json`
- Session expiry detected by checking response HTML for `/user/account/login`

## qBittorrent API notes

- Base: `QT_URL/api/v2`
- Auth: `POST /api/v2/auth/login` → `SID` cookie
- Add: `POST /api/v2/torrents/add` (multipart, `forceStart=true`, `tags=tl-{id}`, `seedingTimeLimit` in minutes)
- Delete: `POST /api/v2/torrents/delete` (`deleteFiles=true`)
- Hash captured by diffing `/api/v2/torrents/info?category=...` before and after add
- `seeding_time` in torrent info = seconds; `seeding_time_limit` in torrent info = minutes; -1/-2 = special (skip)
