import 'dotenv/config';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Constants ---
const TL_BASE       = 'https://www.torrentleech.org';
const TL_LOGIN_URL  = `${TL_BASE}/user/account/login/`;
const TL_HNR_URL    = `${TL_BASE}/profile/${process.env.USERNAME}/hnr`;
const QT_BASE       = process.env.QT_URL;
const COOKIES_FILE  = path.join(__dirname, 'cookies.json');
const PRUNE_DAYS    = 9;
const PRUNE_MINS    = PRUNE_DAYS * 24 * 60;
const TL_TAG_PREFIX = 'tl-';
const QT_CATEGORY   = 'TorrentLeech-HNR';
const EXTRA_PRUNE_CATEGORIES = ['tv-sonarr', 'radarr'];
const USER_AGENT    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- Cookie jar (loaded from disk if available) ---
const jar = fs.existsSync(COOKIES_FILE)
  ? CookieJar.fromJSON(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')))
  : new CookieJar();

const client = wrapper(axios.create({
  jar,
  withCredentials: true,
  headers: { 'User-Agent': USER_AGENT },
  maxRedirects: 5,
}));

// --- Logging ---
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function err(...args) {
  console.error(new Date().toISOString(), 'ERROR', ...args);
}

function saveCookies() {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(jar.toJSON()));
}

// --- Seeding time parser → total minutes ---
function parseSeedingMins(text) {
  let mins = 0;
  const d = text.match(/(\d+)\s*days?/i);
  const h = text.match(/(\d+)\s*hrs?/i);
  const m = text.match(/(\d+)\s*mins?/i);
  if (d) mins += parseInt(d[1], 10) * 24 * 60;
  if (h) mins += parseInt(h[1], 10) * 60;
  if (m) mins += parseInt(m[1], 10);
  return mins;
}

// Extracts the info hash (SHA1 of bencoded info dict) from a .torrent buffer
function extractInfoHash(buf) {
  const marker = Buffer.from('4:info');
  const idx = buf.indexOf(marker);
  if (idx === -1) throw new Error('No info dict in torrent');
  let pos = idx + marker.length;
  if (buf[pos] !== 0x64) throw new Error('Info value is not a dict');
  let depth = 0;
  const start = pos;
  while (pos < buf.length) {
    const c = buf[pos];
    if (c === 0x64 || c === 0x6c) { depth++; pos++; }
    else if (c === 0x65) { depth--; pos++; if (depth === 0) break; }
    else if (c >= 0x30 && c <= 0x39) {
      let e = pos; while (buf[e] !== 0x3a) e++;
      pos = e + 1 + parseInt(buf.slice(pos, e).toString(), 10);
    } else if (c === 0x69) { pos++; while (buf[pos] !== 0x65) pos++; pos++; }
    else throw new Error(`Unexpected bencode byte 0x${c.toString(16)} at ${pos}`);
  }
  return crypto.createHash('sha1').update(buf.slice(start, pos)).digest('hex');
}

// --- TorrentLeech auth ---
async function login() {
  log('[AUTH] Logging in to TorrentLeech...');
  const form = new FormData();
  form.append('username', process.env.USERNAME);
  form.append('password', process.env.PASSWORD);

  const res = await client.post(TL_LOGIN_URL, form, {
    headers: form.getHeaders(),
  });

  if (res.data.includes('/user/account/login')) {
    throw new Error('TorrentLeech login failed — check USERNAME/PASSWORD in .env');
  }

  saveCookies();
  log('[AUTH] TorrentLeech login successful');
}

function isLoginPage(html) {
  return html.includes('/user/account/login');
}

async function ensureLoggedIn() {
  const res = await client.get(TL_HNR_URL);
  if (isLoginPage(res.data)) {
    await login();
  }
}

// --- HNR page scraper ---
function parseHnrTable(html) {
  const $ = cheerio.load(html);
  const entries = [];

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    const onclick = cells.eq(0).attr('onclick') || '';
    const match = onclick.match(/window\.location='\/torrent\/(\d+)'/);
    if (!match) return;

    const torrentId   = match[1];
    const seedingText = cells.eq(4).text().trim();
    const seedingMins = parseSeedingMins(seedingText);

    entries.push({ torrentId, seedingMins, seedingText });
  });

  let nextPage = null;
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().toLowerCase();
    if ((text === 'next' || text === '>' || text === '»') && href.includes('hnr')) {
      nextPage = href.startsWith('http') ? href : `${TL_BASE}${href}`;
    }
  });

  return { entries, nextPage };
}

async function getAllHnrEntries() {
  const allEntries = [];
  let url = TL_HNR_URL;
  let page = 1;

  while (url) {
    log(`[HNR] Fetching page ${page}: ${url}`);
    const res = await client.get(url);

    if (isLoginPage(res.data)) {
      await login();
      continue;
    }

    const { entries, nextPage } = parseHnrTable(res.data);
    allEntries.push(...entries);
    log(`[HNR] Page ${page}: ${entries.length} entries`);

    url = nextPage;
    page++;
    if (nextPage) await sleep(1500);
  }

  return allEntries;
}

// --- Torrent download ---
async function getTorrentDownloadUrl(torrentId) {
  const res = await client.get(`${TL_BASE}/torrent/${torrentId}`);
  if (isLoginPage(res.data)) throw new Error(`Session expired fetching torrent ${torrentId}`);

  const $ = cheerio.load(res.data);
  const href = $(`a[href^="/download/${torrentId}/"]`).first().attr('href');
  if (!href) throw new Error(`No download link found on torrent page ${torrentId}`);
  return `${TL_BASE}${href}`;
}

async function downloadToTempFile(downloadUrl) {
  const tmpFile = path.join(os.tmpdir(), `tl-${Date.now()}.torrent`);
  const res = await client.get(downloadUrl, { responseType: 'arraybuffer' });

  const contentType = res.headers['content-type'] || '';
  const buf = Buffer.from(res.data);

  if (buf.length === 0) {
    throw new Error(`Downloaded file is empty (content-type: ${contentType})`);
  }
  // bencoded torrent files always start with 'd'
  if (buf[0] !== 0x64) {
    const preview = buf.slice(0, 120).toString('utf8').replace(/\n/g, ' ');
    throw new Error(`Downloaded file is not a valid torrent (content-type: ${contentType}, starts with: ${preview})`);
  }

  fs.writeFileSync(tmpFile, buf);
  return tmpFile;
}

// --- qBittorrent API ---
function qtHeaders(sidCookie) {
  return { Cookie: sidCookie, Referer: QT_BASE };
}

async function loginQBittorrent() {
  const params = new URLSearchParams();
  params.append('username', process.env.QT_USERNAME);
  params.append('password', process.env.QT_PASSWORD);

  const res = await axios.post(`${QT_BASE}/api/v2/auth/login`, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': QT_BASE,
    },
  });

  if (res.status === 403) throw new Error('qBittorrent login failed — IP banned');

  const setCookie = res.headers['set-cookie'] || [];
  const sidEntry  = setCookie.find(c => c.startsWith('SID='));
  if (!sidEntry) throw new Error('qBittorrent login failed — no SID cookie in response');

  const sid = sidEntry.split(';')[0];
  log('[QBT] Login successful');
  return sid;
}

async function getQBittorrentTorrents(sidCookie, category = QT_CATEGORY) {
  const res = await axios.get(`${QT_BASE}/api/v2/torrents/info`, {
    params: { category },
    headers: qtHeaders(sidCookie),
  });
  return res.data;
}

async function getAllQBittorrentTorrents(sidCookie) {
  const res = await axios.get(`${QT_BASE}/api/v2/torrents/info`, {
    headers: qtHeaders(sidCookie),
  });
  return res.data;
}

async function addTagToTorrent(hash, tag, sidCookie) {
  const params = new URLSearchParams();
  params.append('hashes', hash);
  params.append('tags', tag);
  await axios.post(`${QT_BASE}/api/v2/torrents/addTags`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...qtHeaders(sidCookie) },
  });
}

// Returns Set of TL torrent IDs already tracked via tags in qBittorrent
function extractTrackedIds(torrents) {
  return new Set(
    torrents.flatMap(t =>
      (t.tags || '')
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.startsWith(TL_TAG_PREFIX))
        .map(tag => tag.slice(TL_TAG_PREFIX.length))
    )
  );
}

async function addTorrentToQBittorrent(tmpFile, filename, torrentId, seedingTimeLimitMins, sidCookie) {
  const form = new FormData();
  form.append('torrents', fs.createReadStream(tmpFile), {
    filename,
    contentType: 'application/x-bittorrent',
  });
  form.append('category', QT_CATEGORY);
  form.append('forceStart', 'true');
  form.append('tags', `${TL_TAG_PREFIX}${torrentId}`);

  const before = new Set((await getQBittorrentTorrents(sidCookie)).map(t => t.hash));

  const res = await axios.post(`${QT_BASE}/api/v2/torrents/add`, form, {
    headers: { ...form.getHeaders(), ...qtHeaders(sidCookie) },
  });

  if (res.data === 'Fails.') {
    // Duplicate — find the existing torrent by info hash and tag it
    const infoHash = extractInfoHash(fs.readFileSync(tmpFile));
    const existing = (await getAllQBittorrentTorrents(sidCookie)).find(t => t.hash === infoHash);
    if (existing) {
      const alreadySeedingMins = Math.floor(existing.seeding_time / 60);
      const adjustedLimitMins  = alreadySeedingMins + seedingTimeLimitMins;
      log(`[ADD] Duplicate hash ${infoHash.slice(0, 8)}… — tagging existing, qBT seeded ${alreadySeedingMins}m, adjusted limit: ${adjustedLimitMins}m (${Math.round(adjustedLimitMins / 60)}h)`);
      await addTagToTorrent(existing.hash, `${TL_TAG_PREFIX}${torrentId}`, sidCookie);
      await setTorrentSeedingLimit(existing.hash, adjustedLimitMins, sidCookie);
      await resumeTorrent(existing.hash, sidCookie);
      return { hash: existing.hash, duplicate: true };
    }
    throw new Error(`qBittorrent rejected torrent: "Fails." (no matching hash found)`);
  }

  if (res.data !== 'Ok.') {
    throw new Error(`qBittorrent rejected torrent: "${res.data}"`);
  }

  await sleep(1500);
  const after = await getQBittorrentTorrents(sidCookie);
  const newHash = after.map(t => t.hash).find(h => !before.has(h)) || null;

  if (newHash) {
    await setTorrentSeedingLimit(newHash, seedingTimeLimitMins, sidCookie);
  }

  return { hash: newHash, duplicate: false };
}

async function setTorrentSeedingLimit(hash, seedingTimeLimitMins, sidCookie) {
  const params = new URLSearchParams();
  params.append('hashes', hash);
  params.append('seedingTimeLimit', String(Math.max(1, Math.round(seedingTimeLimitMins))));
  params.append('ratioLimit', '-2');

  await axios.post(`${QT_BASE}/api/v2/torrents/setShareLimits`, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...qtHeaders(sidCookie),
    },
  });
}

async function resumeTorrent(hash, sidCookie) {
  const params = new URLSearchParams();
  params.append('hashes', hash);
  await axios.post(`${QT_BASE}/api/v2/torrents/resume`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...qtHeaders(sidCookie) },
  });
}

async function deleteTorrentFromQBittorrent(hash, sidCookie) {
  const params = new URLSearchParams();
  params.append('hashes', hash);
  params.append('deleteFiles', 'true');

  await axios.post(`${QT_BASE}/api/v2/torrents/delete`, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...qtHeaders(sidCookie),
    },
  });
}

// Deletes torrents in given category where state is 'pausedUP' (seeding time limit reached, auto-paused by qBittorrent)
async function pruneCompletedTorrents(sidCookie, category = QT_CATEGORY, dryRun = false) {
  const torrents = await getQBittorrentTorrents(sidCookie, category);
  const toDelete = torrents.filter(t => t.state === 'pausedUP');

  log(`[PRUNE] Category "${category}": ${torrents.length} total, ${toDelete.length} completed (pausedUP)`);

  let pruned = 0;
  for (const t of toDelete) {
    const seededH   = (t.seeding_time / 3600).toFixed(1);
    const limitMins = t.seeding_time_limit;
    const limitStr  = limitMins > 0 ? `limit ${Math.round(limitMins / 60)}h` : 'global limit';
    if (dryRun) {
      log(`[PRUNE] Would delete: "${t.name}" (seeded ${seededH}h, ${limitStr}, state: ${t.state})`);
    } else {
      await deleteTorrentFromQBittorrent(t.hash, sidCookie);
      log(`[PRUNE] Deleted: "${t.name}" (seeded ${seededH}h, ${limitStr})`);
      pruned++;
    }
  }

  if (toDelete.length === 0) log('[PRUNE] Nothing to prune');
  return { categoryTotal: torrents.length, pruned: dryRun ? 0 : pruned, wouldPrune: toDelete.length };
}

// --- Utilities ---
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Main ---
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  log(`=== TorrentLeech HNR runner starting${dryRun ? ' [DRY RUN]' : ''} ===`);

  const stats = {
    pruned:       0,
    hnrTotal:     0,
    hnrSkipped:   0,
    hnrAttempted: 0,
    hnrAdded:     0,
    hnrDuplicate: 0,
    hnrFailed:    0,
  };

  await ensureLoggedIn();
  const sidCookie = await loginQBittorrent();

  // Step 1: Prune completed torrents across all managed categories
  for (const cat of [QT_CATEGORY, ...EXTRA_PRUNE_CATEGORIES]) {
    const pruneResult = await pruneCompletedTorrents(sidCookie, cat, dryRun);
    stats.pruned += pruneResult.pruned;
    if (dryRun) stats._wouldPrune = (stats._wouldPrune || 0) + pruneResult.wouldPrune;
  }

  // Step 2: Build skip-set from current category torrents (after prune)
  const activeTorrents = await getQBittorrentTorrents(sidCookie);
  const trackedIds     = extractTrackedIds(activeTorrents);
  log(`[TRACK] qBittorrent tracking ${trackedIds.size} TL torrent ID(s) in category`);

  // Step 3: Fetch all HNR entries
  const entries = await getAllHnrEntries();
  stats.hnrTotal = entries.length;
  log(`[HNR] Total entries: ${entries.length}`);

  const toDownload = entries.filter(({ torrentId }) => !trackedIds.has(torrentId));
  stats.hnrSkipped = entries.length - toDownload.length;
  log(`[HNR] Already tracked: ${stats.hnrSkipped}, new to add: ${toDownload.length}`);

  if (toDownload.length === 0 && !dryRun) {
    log('[HNR] Nothing to add');
  }

  // Step 4: Add new torrents
  for (const { torrentId, seedingMins, seedingText } of toDownload) {
    const remainingMins = Math.max(1, PRUNE_MINS - seedingMins);
    let tmpFile;
    try {
      log(`[ADD] Torrent ${torrentId} — TL seeded: ${seedingText} (${seedingMins}m), limit to set: ${Math.round(remainingMins / 60)}h (${remainingMins}m)`);

      const downloadUrl = await getTorrentDownloadUrl(torrentId);
      const filename    = path.basename(new URL(downloadUrl).pathname);

      if (dryRun) {
        log(`[ADD] Would add: ${filename}`);
        stats.hnrAttempted++;
        continue;
      }

      tmpFile = await downloadToTempFile(downloadUrl);

      stats.hnrAttempted++;
      const { hash, duplicate } = await addTorrentToQBittorrent(tmpFile, filename, torrentId, remainingMins, sidCookie);

      if (duplicate) {
        stats.hnrDuplicate++;
        log(`[ADD] Tagged duplicate: ${filename}${hash ? ` [${hash.slice(0, 8)}…]` : ''}`);
      } else {
        stats.hnrAdded++;
        log(`[ADD] Added: ${filename}${hash ? ` [${hash.slice(0, 8)}…]` : ' [hash not captured]'}`);
      }

      await sleep(2000);
    } catch (e) {
      stats.hnrFailed++;
      err(`[ADD] Failed torrent ${torrentId}: ${e.message}`);
      process.exitCode = 1;
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }

  // Step 5: Summary
  log('=== Run complete ===');
  log(`[STATS] Pruned:     ${stats.pruned}${dryRun ? ` (would prune: ${stats._wouldPrune || 0})` : ''}`);
  log(`[STATS] HNR total:  ${stats.hnrTotal}`);
  log(`[STATS] Skipped:    ${stats.hnrSkipped} (already tracked)`);
  log(`[STATS] Attempted:  ${stats.hnrAttempted}`);
  log(`[STATS] Added:      ${stats.hnrAdded}`);
  log(`[STATS] Duplicates: ${stats.hnrDuplicate} (existing tagged)`);
  log(`[STATS] Failed:     ${stats.hnrFailed}`);
}

main().catch(e => {
  console.error(new Date().toISOString(), 'FATAL:', e.message);
  process.exit(1);
});
