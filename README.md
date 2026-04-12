# torrentleech-hnr

Automated Hit and Run manager for TorrentLeech. Scrapes your HNR page, downloads `.torrent` files for unseeded entries, injects them into qBittorrent with force-start, and deletes them (including data) once the seeding requirement is satisfied.

## Requirements

- Node.js 18+
- A qBittorrent instance with Web UI enabled

## Setup

```bash
git clone <repo>
cd torrentleech-hnr
npm install
cp .env.example .env   # then fill in your credentials
```

### `.env`

```env
USERNAME=your_tl_username
PASSWORD=your_tl_password
EMAIL=your_tl_email

QT_URL=https://your-seedbox.example.com/qbittorrent
QT_USERNAME=your_qbit_username
QT_PASSWORD=your_qbit_password
QT_WEBUI_PORT=12345
QT_CATEGORY=TorrentLeech-HNR
```

## Usage

```bash
# Preview what would be downloaded / deleted — no changes made
node index.js --dry-run

# Run for real
node index.js
```

### Dry run output example

```
2026-04-12T03:00:01Z === DRY RUN — no files will be downloaded or uploaded ===
2026-04-12T03:00:01Z === TorrentLeech HNR runner starting ===
2026-04-12T03:00:03Z Total HNR entries found: 4

Torrents that would be deleted from qBittorrent (1):
  [998877] Some.Show.S03E01.1080p.BluRay.torrent  (seeding: 9 days, 4 hrs, 12 mins)

Files that would be uploaded to qBittorrent (2):
  [112233] Another.Show.S01E05.1080p.WEB.torrent  (seeding: 1 day, 6 hrs)
  [445566] Movie.2025.2160p.UHD.torrent  (seeding: 3 hrs, 22 mins)

Dry run complete — nothing written.
```

## Scheduling (cron)

```bash
# Add daily 3am cron job
(crontab -l 2>/dev/null; echo "0 3 * * * cd /path/to/torrentleech-hnr && /path/to/node index.js >> /path/to/torrentleech-hnr/cron.log 2>&1") | crontab -
```

## State files

| File | Purpose |
|---|---|
| `cookies.json` | TorrentLeech session (auto-managed, ~30 day TTL) |
| `downloaded.json` | Tracks downloaded torrent IDs, names, and qBittorrent hashes |
| `cron.log` | Appended log from scheduled runs |

All three are git-ignored.

## Seeding threshold

TorrentLeech requires 8 days of seeding to clear an HNR. The script uses a 9-day threshold (8 + 1 buffer day) before deleting from qBittorrent.
