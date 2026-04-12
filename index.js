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
const STATE_FILE    = path.join(__dirname, 'downloaded.json');
const PRUNE_DAYS    = 9;
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

// --- State helpers ---
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveCookies() {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(jar.toJSON()));
}

// --- Seeding time parser ---
// Parses "7 days, 19 hrs, 33 mins, 24 secs" → total days (float)
function parseSeedingDays(text) {
  let days = 0;
  const d = text.match(/(\d+)\s*days?/i);
  const h = text.match(/(\d+)\s*hrs?/i);
  const m = text.match(/(\d+)\s*mins?/i);
  if (d) days += parseInt(d[1], 10);
  if (h) days += parseInt(h[1], 10) / 24;
  if (m) days += parseInt(m[1], 10) / 1440;
  return days;
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
    const seedingDays = parseSeedingDays(seedingText);

    entries.push({ torrentId, seedingDays, seedingText });
  });

  // Detect next-page link (TL uses ?page=N or similar)
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
      // retry same page after re-login
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
  const res = await client.get(downloadUrl, { responseType: 'stream' });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tmpFile);
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return tmpFile;
}

// --- qBittorrent API ---
async function loginQBittorrent() {
  const params = new URLSearchParams();
  params.append('username', process.env.QT_USERNAME);
  params.append('password', process.env.QT_PASSWORD);

  const res = await axios.post(`${QT_BASE}/api/v2/auth/login`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const setCookie = res.headers['set-cookie'] || [];
  const sidEntry  = setCookie.find(c => c.startsWith('SID='));
  if (!sidEntry) throw new Error('qBittorrent login failed — no SID cookie in response');

  const sid = sidEntry.split(';')[0]; // "SID=xxxxx"
  log('qBittorrent login successful');
  return sid;
}

async function getQBittorrentHashes(sidCookie) {
  const res = await axios.get(`${QT_BASE}/api/v2/torrents/info`, {
    params: { category: process.env.QT_CATEGORY },
    headers: { Cookie: sidCookie },
  });
  return new Set(res.data.map(t => t.hash));
}

async function addTorrentToQBittorrent(tmpFile, filename, sidCookie) {
  const form = new FormData();
  form.append('torrents', fs.createReadStream(tmpFile), {
    filename,
    contentType: 'application/x-bittorrent',
  });
  form.append('category', process.env.QT_CATEGORY);
  form.append('forceStart', 'true');

  const before = await getQBittorrentHashes(sidCookie);

  const res = await axios.post(`${QT_BASE}/api/v2/torrents/add`, form, {
    headers: {
      ...form.getHeaders(),
      Cookie: sidCookie,
    },
  });

  if (res.data !== 'Ok.') {
    throw new Error(`qBittorrent rejected torrent: "${res.data}"`);
  }

  // Give qBittorrent a moment to register the new torrent
  await sleep(1500);
  const after = await getQBittorrentHashes(sidCookie);
  const newHash = [...after].find(h => !before.has(h)) || null;
  return newHash;
}

async function deleteTorrentFromQBittorrent(hash, sidCookie) {
  const params = new URLSearchParams();
  params.append('hashes', hash);
  params.append('deleteFiles', 'true');

  await axios.post(`${QT_BASE}/api/v2/torrents/delete`, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: sidCookie,
    },
  });
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

  const state   = loadState();
  const entries = await getAllHnrEntries();
  log(`Total HNR entries found: ${entries.length}`);

  // Prune: delete from qBittorrent (with data) + remove from state when seeding done
  const toPrune = entries.filter(
    ({ torrentId, seedingDays }) => state[torrentId] && seedingDays > PRUNE_DAYS
  );

  // Identify torrents not yet downloaded and not past prune threshold
  const toDownload = entries.filter(
    ({ torrentId, seedingDays }) => !state[torrentId] && seedingDays <= PRUNE_DAYS
  );

  if (dryRun) {
    if (toPrune.length > 0) {
      log(`\nTorrents that would be deleted from qBittorrent (${toPrune.length}):`);
      for (const { torrentId, seedingText } of toPrune) {
        const { torrentName, qtHash } = state[torrentId];
        log(`  [${torrentId}] ${torrentName}  (seeding: ${seedingText})${qtHash ? '' : '  [no hash — skipping qBittorrent delete]'}`);
      }
    }
    if (toDownload.length > 0) {
      log(`\nFiles that would be uploaded to qBittorrent (${toDownload.length}):`);
      for (const { torrentId, seedingText } of toDownload) {
        const downloadUrl = await getTorrentDownloadUrl(torrentId);
        const filename    = path.basename(new URL(downloadUrl).pathname);
        log(`  [${torrentId}] ${filename}  (seeding: ${seedingText})`);
        await sleep(500);
      }
    }
    if (toPrune.length === 0 && toDownload.length === 0) log('Nothing to do.');
    log('\nDry run complete — nothing written.');
    return;
  }

  // Login to qBittorrent once if either deletions or uploads are needed
  let sidCookie;
  if (toPrune.length > 0 || toDownload.length > 0) {
    sidCookie = await loginQBittorrent();
  }

  // Delete pruned torrents from qBittorrent
  for (const { torrentId, seedingText } of toPrune) {
    const { torrentName, qtHash } = state[torrentId];
    if (qtHash) {
      await deleteTorrentFromQBittorrent(qtHash, sidCookie);
      log(`Deleted from qBittorrent: ${torrentName} (seeding: ${seedingText})`);
    } else {
      log(`Pruning ${torrentId} — no stored hash, skipping qBittorrent delete`);
    }
    delete state[torrentId];
  }
  if (toPrune.length > 0) saveState(state);

  log(`New torrents to download: ${toDownload.length}`);
  if (toDownload.length === 0) {
    log('Nothing to do.');
    return;
  }

  for (const { torrentId } of toDownload) {
    let tmpFile;
    try {
      log(`Processing torrent ID ${torrentId}...`);

      const downloadUrl = await getTorrentDownloadUrl(torrentId);
      const filename    = path.basename(new URL(downloadUrl).pathname);

      tmpFile = await downloadToTempFile(downloadUrl);
      log(`  Downloaded to temp: ${tmpFile}`);

      const qtHash = await addTorrentToQBittorrent(tmpFile, filename, sidCookie);

      state[torrentId] = {
        downloadedAt: new Date().toISOString(),
        torrentName: filename,
        qtHash,
      };
      saveState(state);
      log(`  Added to qBittorrent: ${filename}${qtHash ? ` [hash: ${qtHash}]` : ' [hash not captured]'}`);

      await sleep(2000); // polite delay between torrents
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
