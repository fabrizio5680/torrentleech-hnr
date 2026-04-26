import 'dotenv/config';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

// --- TorrentLeech auth ---
async function login() {
  log('Logging in to TorrentLeech...');
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
  log('TorrentLeech login successful');
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

  while (url) {
    log(`Fetching HNR page: ${url}`);
    const res = await client.get(url);

    if (isLoginPage(res.data)) {
      await login();
      continue;
    }

    const { entries, nextPage } = parseHnrTable(res.data);
    allEntries.push(...entries);
    log(`  Found ${entries.length} entries on this page`);

    url = nextPage;
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
  log('qBittorrent login successful');
  return sid;
}

async function getQBittorrentTorrents(sidCookie) {
  const res = await axios.get(`${QT_BASE}/api/v2/torrents/info`, {
    params: { category: process.env.QT_CATEGORY },
    headers: qtHeaders(sidCookie),
  });
  return res.data;
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
  form.append('category', process.env.QT_CATEGORY);
  form.append('forceStart', 'true');
  form.append('tags', `${TL_TAG_PREFIX}${torrentId}`);

  const before = new Set((await getQBittorrentTorrents(sidCookie)).map(t => t.hash));

  const res = await axios.post(`${QT_BASE}/api/v2/torrents/add`, form, {
    headers: { ...form.getHeaders(), ...qtHeaders(sidCookie) },
  });

  if (res.data !== 'Ok.') {
    throw new Error(`qBittorrent rejected torrent: "${res.data}"`);
  }

  await sleep(1500);
  const after = await getQBittorrentTorrents(sidCookie);
  const newHash = after.map(t => t.hash).find(h => !before.has(h)) || null;

  if (newHash) {
    await setTorrentSeedingLimit(newHash, seedingTimeLimitMins, sidCookie);
  }

  return newHash;
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

// Deletes torrents whose seeding_time has reached their per-torrent seedingTimeLimit.
// seeding_time (qBT info) = seconds; seeding_time_limit (qBT info) = minutes; -1/-2 = special values, skip.
async function pruneCompletedTorrents(sidCookie) {
  const torrents = await getQBittorrentTorrents(sidCookie);
  let pruned = 0;

  for (const t of torrents) {
    if (t.seeding_time_limit <= 0) continue;
    if (t.seeding_time < t.seeding_time_limit * 60) continue;

    await deleteTorrentFromQBittorrent(t.hash, sidCookie);
    log(`Pruned: ${t.name} (seeded ${Math.round(t.seeding_time / 3600)}h / limit ${Math.round(t.seeding_time_limit / 60)}h)`);
    pruned++;
  }

  log(`Pruned ${pruned} completed torrent(s)`);
}

// --- Utilities ---
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Main ---
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) log('=== DRY RUN — no files will be downloaded or uploaded ===');
  log('=== TorrentLeech HNR runner starting ===');

  await ensureLoggedIn();
  const sidCookie = await loginQBittorrent();

  if (dryRun) {
    const existingTorrents = await getQBittorrentTorrents(sidCookie);
    const trackedIds       = extractTrackedIds(existingTorrents);

    const wouldPrune = existingTorrents.filter(
      t => t.seeding_time_limit > 0 && t.seeding_time >= t.seeding_time_limit * 60
    );

    if (wouldPrune.length > 0) {
      log(`\nTorrents that would be deleted (${wouldPrune.length}):`);
      for (const t of wouldPrune) {
        log(`  ${t.name} (seeded: ${Math.round(t.seeding_time / 3600)}h)`);
      }
    }

    const entries    = await getAllHnrEntries();
    const toDownload = entries.filter(({ torrentId }) => !trackedIds.has(torrentId));

    if (toDownload.length > 0) {
      log(`\nFiles that would be uploaded to qBittorrent (${toDownload.length}):`);
      for (const { torrentId, seedingText, seedingMins } of toDownload) {
        const remainingMins = Math.max(1, PRUNE_MINS - seedingMins);
        const downloadUrl   = await getTorrentDownloadUrl(torrentId);
        const filename      = path.basename(new URL(downloadUrl).pathname);
        log(`  [${torrentId}] ${filename}  (seeded: ${seedingText}, remaining limit: ${Math.round(remainingMins / 60)}h)`);
        await sleep(500);
      }
    }

    if (wouldPrune.length === 0 && toDownload.length === 0) log('Nothing to do.');
    log('\nDry run complete — nothing written.');
    return;
  }

  await pruneCompletedTorrents(sidCookie);

  // Fetch fresh list after prune to build skip set
  const activeTorrents = await getQBittorrentTorrents(sidCookie);
  const trackedIds     = extractTrackedIds(activeTorrents);
  log(`qBittorrent tracking ${trackedIds.size} TL torrent(s)`);

  const entries    = await getAllHnrEntries();
  log(`Total HNR entries found: ${entries.length}`);

  const toDownload = entries.filter(({ torrentId }) => !trackedIds.has(torrentId));
  log(`New torrents to download: ${toDownload.length}`);

  if (toDownload.length === 0) {
    log('Nothing to do.');
    return;
  }

  for (const { torrentId, seedingMins } of toDownload) {
    let tmpFile;
    try {
      log(`Processing torrent ID ${torrentId}...`);

      const downloadUrl   = await getTorrentDownloadUrl(torrentId);
      const filename      = path.basename(new URL(downloadUrl).pathname);
      const remainingMins = Math.max(1, PRUNE_MINS - seedingMins);

      tmpFile = await downloadToTempFile(downloadUrl);
      log(`  Downloaded to temp: ${tmpFile}`);

      const qtHash = await addTorrentToQBittorrent(tmpFile, filename, torrentId, remainingMins, sidCookie);
      log(`  Added to qBittorrent: ${filename} [limit: ${Math.round(remainingMins / 60)}h]${qtHash ? ` [hash: ${qtHash}]` : ' [hash not captured]'}`);

      await sleep(2000);
    } catch (e) {
      err(`Failed on torrent ${torrentId}:`, e.message);
      process.exitCode = 1;
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }

  log('=== Done ===');
}

main().catch(e => {
  console.error(new Date().toISOString(), 'FATAL:', e.message);
  process.exit(1);
});
