#!/usr/bin/env node
/*
 * Reishin Sync — à lancer sur le VPS, à côté du serveur nanos world.
 *
 * Il regarde en permanence les Packages et Asset Packs utilisés par le serveur
 * (Config.toml + leurs dépendances) et publie :
 *   http://IP:7780/manifest.json   → liste à jour des fichiers clients (+ hash SHA-256)
 *   http://IP:7780/files/<chemin>  → téléchargement des fichiers
 *
 * Le launcher compare cette liste avec le PC du joueur et télécharge ce qui manque,
 * AVANT de lancer le jeu. Quand un collaborateur ajoute/modifie quelque chose sur le
 * serveur, la liste se met à jour toute seule (pas de manipulation à faire).
 *
 * Sécurité : seuls les fichiers que nanos world envoie déjà aux joueurs sont publiés
 * (Package.toml, Client/, Shared/ des packages et les asset packs).
 * Les dossiers Server/ (scripts serveur), Config.toml, tokens… ne sont JAMAIS exposés.
 *
 * Utilisation :  node reishin-sync.js /chemin/vers/le/serveur/nanos [port]
 * Aucune dépendance : Node.js 18+ suffit.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(process.argv[2] || process.env.NANOS_DIR || '.');
const PORT = Number(process.argv[3] || process.env.SYNC_PORT || 7780);
const REFRESH_MS = 60 * 1000;
const MODE = process.env.SYNC_MODE || 'auto'; // 'auto' = Config.toml (ou tout si vide), 'all' = tout publier
const CACHE_FILE = path.join(ROOT, '.reishin-sync-cache.json');

if (!fs.existsSync(path.join(ROOT, 'Config.toml'))) {
  console.error(`Config.toml introuvable dans ${ROOT}. Donne le dossier du serveur nanos world :\n  node reishin-sync.js /home/nanos/server`);
  process.exit(1);
}

// ---------- Lecture TOML minimale (les clés dont on a besoin) ----------
function tomlString(txt, key) {
  const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm'));
  return m ? m[1].trim() : '';
}
function tomlArray(txt, key) {
  const m = txt.match(new RegExp('^\\s*' + key + '\\s*=\\s*\\[([\\s\\S]*?)\\]', 'm'));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].trim()).filter(Boolean);
}
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };

/** Arguments du serveur nanos world en cours (AMP passe --game_mode, --assets… en ligne de commande). */
function serverArgs() {
  const out = { packages: [], assets: [] };
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch (_) { return out; }
  for (const pid of pids) {
    let argv;
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch (_) { continue; }
    if (!argv.slice(0, 2).some((a) => /NanosWorldServer/i.test(path.basename(a)))) continue;
    let cwd = '';
    try { cwd = fs.realpathSync(`/proc/${pid}/cwd`); } catch (_) {}
    if (cwd && path.resolve(cwd) !== ROOT) continue;
    const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
    const list = (flag) => val(flag).split(/[,\s]+/).filter(Boolean);
    out.packages.push(val('--game_mode'), val('--map'), val('--loading_screen'), ...list('--packages'));
    out.assets.push(...list('--assets'));
  }
  out.packages = out.packages.filter(Boolean);
  return out;
}

/** Packages et asset packs réellement utilisés par le serveur (+ dépendances). */
function resolveUsed() {
  const cfg = readText(path.join(ROOT, 'Config.toml'));
  const args = serverArgs();
  const packages = new Set([tomlString(cfg, 'game_mode'), tomlString(cfg, 'map'), tomlString(cfg, 'loading_screen'), ...tomlArray(cfg, 'packages'), ...args.packages].filter(Boolean));
  const assets = new Set([...tomlArray(cfg, 'assets'), ...args.assets]);
  const queue = [...packages];
  while (queue.length) {
    const p = queue.pop();
    const pt = readText(path.join(ROOT, 'Packages', p, 'Package.toml'));
    for (const dep of tomlArray(pt, 'packages_requirements')) if (!packages.has(dep)) { packages.add(dep); queue.push(dep); }
    for (const a of tomlArray(pt, 'assets_requirements')) assets.add(a);
  }
  // Config.toml vide (ex : serveur géré par AMP qui passe les packages en ligne de commande) :
  // on publie tous les packages / asset packs présents dans les dossiers du serveur.
  const listDirs = (d) => { try { return fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch (_) { return []; } };
  const configured = [...packages].filter((p) => fs.existsSync(path.join(ROOT, 'Packages', p))).length + [...assets].filter((a) => fs.existsSync(path.join(ROOT, 'Assets', a))).length;
  if (MODE === 'all' || configured === 0) {
    listDirs('Packages').forEach((p) => packages.add(p));
    listDirs('Assets').forEach((a) => assets.add(a));
  }
  // Asset packs dont le dossier existe sur le serveur (les autres viennent du Vault nanos world)
  return {
    packages: [...packages].filter((p) => fs.existsSync(path.join(ROOT, 'Packages', p))),
    assets: [...assets].filter((a) => fs.existsSync(path.join(ROOT, 'Assets', a))),
  };
}

async function walk(dir, out = []) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // .git, .cache, .vscode…
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function listClientFiles() {
  const used = resolveUsed();
  const files = [];
  for (const p of used.packages) {
    const base = path.join(ROOT, 'Packages', p);
    if (fs.existsSync(path.join(base, 'Package.toml'))) files.push(path.join(base, 'Package.toml'));
    for (const sub of ['Client', 'Shared']) files.push(...(await walk(path.join(base, sub))));
  }
  for (const a of used.assets) files.push(...(await walk(path.join(ROOT, 'Assets', a))));
  return { used, files };
}

// ---------- Hash avec cache (on ne re-hashe que ce qui a changé) ----------
let hashCache = {};
try { hashCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

let manifest = { version: null, files: [] };
let allowed = new Map(); // chemin relatif → chemin absolu
let building = null;

async function build() {
  const t0 = Date.now();
  const { used, files } = await listClientFiles();
  const entries = [];
  const nextAllowed = new Map();
  for (const abs of files) {
    let st;
    try { st = await fsp.stat(abs); } catch (_) { continue; }
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const c = hashCache[rel];
    let hash = c && c.size === st.size && c.mtime === st.mtimeMs ? c.sha256 : null;
    if (!hash) { hash = await sha256(abs); hashCache[rel] = { size: st.size, mtime: st.mtimeMs, sha256: hash }; }
    entries.push({ path: rel, size: st.size, sha256: hash });
    nextAllowed.set(rel, abs);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const version = crypto.createHash('sha256').update(entries.map((e) => e.path + e.sha256).join('\n')).digest('hex').slice(0, 12);
  const changed = version !== manifest.version;
  manifest = { version, generated: new Date().toISOString(), packages: used.packages, assets: used.assets, files: entries };
  allowed = nextAllowed;
  for (const k of Object.keys(hashCache)) if (!nextAllowed.has(k)) delete hashCache[k];
  fs.writeFile(CACHE_FILE, JSON.stringify(hashCache), () => {});
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (changed) console.log(`[${new Date().toLocaleString('fr-FR')}] Manifeste ${version} : ${entries.length} fichiers, ${(total / 1048576).toFixed(1)} Mo — packages: ${used.packages.join(', ')} | assets: ${used.assets.join(', ') || '-'} (${Date.now() - t0} ms)`);
}
function rebuild() {
  if (!building) building = build().catch((e) => console.error('Erreur :', e.message)).finally(() => { building = null; });
  return building;
}

// ---------- Serveur HTTP ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/manifest.json') {
    if (!manifest.version) await rebuild();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(manifest));
  }
  if (url.pathname.startsWith('/files/')) {
    const rel = decodeURIComponent(url.pathname.slice(7));
    const abs = allowed.get(rel);
    if (!abs) { res.writeHead(404); return res.end('Fichier non publié'); }
    fs.stat(abs, (err, st) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(abs).pipe(res);
    });
    return;
  }
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(`Reishin Sync OK — manifeste ${manifest.version} (${manifest.files.length} fichiers)`); }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Reishin Sync démarré sur le port ${PORT} — dossier serveur : ${ROOT}`);
  rebuild();
  setInterval(rebuild, REFRESH_MS);
});
