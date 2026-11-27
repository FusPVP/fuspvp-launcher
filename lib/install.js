// install.js - Installation et mise à jour du dossier de jeu FusPvP.
//  1. copie les fichiers d'origine de Skyrim SE (exe, .esm, .bsa) depuis
//     l'installation Steam vers "Skyrim Special Edition - FusPvP" ;
//  2. télécharge depuis le serveur FusPvP les fichiers ajoutés par FusPvP
//     (SKSE, SkyrimPlatform, client, FusPvP.esp...) : seuls ceux dont
//     l'empreinte SHA-256 diffère du manifeste publié par le serveur.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
/** http ou https selon l'adresse (domaine officiel en HTTPS). */
const client = (url) => (url.startsWith("https:") ? https : http);
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

/** Fichiers à la racine du jeu Steam, copiés tels quels. */
const BASE_ROOT_FILES = [
  "SkyrimSE.exe", "SkyrimSELauncher.exe", "bink2w64.dll", "steam_api64.dll", "Skyrim.ccc",
  "Skyrim_Default.ini", "Low.ini", "Medium.ini", "High.ini", "Ultra.ini", "installscript.vdf",
];
/** Fichiers d'origine du dossier Data : jeu de base et DLC officiels (pas de mod). */
const BASE_DATA_PATTERN = /^(Skyrim|Update|Dawnguard|HearthFires|Dragonborn)\.esm$|^Skyrim - .+\.bsa$|^MarketplaceTextures\.bsa$/i;

/** Liste [{rel, size}] des fichiers d'origine présents dans le Skyrim Steam. */
function baseFiles(steamDir) {
  const out = [];
  for (const f of BASE_ROOT_FILES) {
    const p = path.join(steamDir, f);
    if (fs.existsSync(p)) out.push({ rel: f, size: fs.statSync(p).size });
  }
  for (const f of fs.readdirSync(path.join(steamDir, "Data"))) {
    if (BASE_DATA_PATTERN.test(f)) out.push({ rel: "Data/" + f, size: fs.statSync(path.join(steamDir, "Data", f)).size });
  }
  return out;
}

/** Fichiers d'origine absents ou de taille différente dans le dossier FusPvP. */
function missingBaseFiles(steamDir, gameDir) {
  return baseFiles(steamDir).filter(({ rel, size }) => {
    const p = path.join(gameDir, rel);
    return !fs.existsSync(p) || fs.statSync(p).size !== size;
  });
}

/** Flux qui compte les octets transmis (barre de progression). */
function counter(onBytes) {
  return new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

/**
 * Copie les fichiers d'origine manquants. onProgress({done, total, file}) en octets.
 * Écrit d'abord un fichier .fuspvp-tmp puis le renomme : une copie interrompue
 * (launcher fermé) n'est jamais prise pour un fichier complet.
 */
async function copyBaseFiles(steamDir, gameDir, onProgress) {
  const todo = missingBaseFiles(steamDir, gameDir);
  const total = todo.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (const { rel } of todo) {
    const src = path.join(steamDir, rel);
    const dst = path.join(gameDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = dst + ".fuspvp-tmp";
    onProgress({ done, total, file: rel });
    let last = 0;
    await pipeline(
      fs.createReadStream(src, { highWaterMark: 4 << 20 }),
      counter((n) => {
        done += n;
        if (Date.now() - last > 150) {
          last = Date.now();
          onProgress({ done, total, file: rel });
        }
      }),
      fs.createWriteStream(tmp),
    );
    fs.renameSync(tmp, dst);
  }
  onProgress({ done: total, total, file: null });
  return todo.length;
}

/** GET HTTP -> Buffer (petits fichiers : manifeste). */
function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = client(url).get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} sur ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("le serveur ne répond pas")));
    req.on("error", reject);
  });
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex").toUpperCase()))
      .on("error", reject);
  });
}

/**
 * Cache des empreintes (taille + date de modification -> sha256) : évite de
 * relire ~200 Mo à chaque lancement. Gardé dans le dossier du jeu.
 */
function loadHashCache(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(gameDir, "fuspvp-hashes.json"), "utf8"));
  } catch (e) {
    return {};
  }
}

async function cachedHash(cache, gameDir, rel) {
  const p = path.join(gameDir, rel);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  const key = `${st.size}:${st.mtimeMs}`;
  if (cache[rel] && cache[rel].key === key) return cache[rel].sha256;
  const sha256 = await sha256File(p);
  cache[rel] = { key, sha256 };
  return sha256;
}

/** Fichiers FusPvP du manifeste serveur à télécharger. */
async function filesToUpdate(manifest, gameDir, cache) {
  const todo = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    const p = path.join(gameDir, rel);
    const same = fs.existsSync(p) && fs.statSync(p).size === info.size &&
      (await cachedHash(cache, gameDir, rel)) === String(info.sha256).toUpperCase();
    if (!same) todo.push({ rel, size: info.size, sha256: String(info.sha256).toUpperCase() });
  }
  return todo;
}

function download(url, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const req = client(url).get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} sur ${url}`));
      }
      pipeline(res, counter(onBytes), fs.createWriteStream(dst)).then(resolve, reject);
    });
    req.on("timeout", () => req.destroy(new Error("téléchargement interrompu")));
    req.on("error", reject);
  });
}

/**
 * Supprime les fichiers d'anciennes versions de FusPvP listés par le serveur
 * (manifest.remove). Seulement des chemins relatifs au dossier du jeu.
 */
function removeObsolete(list, gameDir) {
  const root = path.resolve(gameDir) + path.sep;
  for (const rel of list || []) {
    const p = path.resolve(gameDir, rel);
    if (!p.startsWith(root) || !fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    try {
      fs.rmSync(p);
    } catch (e) {
      // verrouillé : réessayé au prochain lancement
    }
  }
}

/**
 * Met à jour les fichiers FusPvP depuis http://<serveur>:3000/client.
 * onProgress({done, total, file, index, count}) en octets.
 */
async function updateFromServer(webBase, gameDir, onProgress) {
  const baseUrl = `${webBase}/client`;
  const cache = loadHashCache(gameDir);
  onProgress({ done: 0, total: 0, file: null, index: 0, count: 0, checking: true });
  const manifest = await getJson(`${baseUrl}/manifest.json`);
  const todo = await filesToUpdate(manifest, gameDir, cache);
  const total = todo.reduce((s, f) => s + f.size, 0);
  let done = 0;
  let last = 0;
  for (let i = 0; i < todo.length; i++) {
    const { rel, sha256 } = todo[i];
    const dst = path.join(gameDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = dst + ".fuspvp-dl";
    const url = `${baseUrl}/files/` + rel.split("/").map(encodeURIComponent).join("/");
    onProgress({ done, total, file: rel, index: i + 1, count: todo.length });
    await download(url, tmp, (n) => {
      done += n;
      if (Date.now() - last > 150) {
        last = Date.now();
        onProgress({ done, total, file: rel, index: i + 1, count: todo.length });
      }
    });
    if ((await sha256File(tmp)) !== sha256) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`fichier corrompu au téléchargement : ${rel}`);
    }
    try {
      fs.renameSync(tmp, dst);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`${rel} est verrouillé (le jeu est-il encore ouvert ?)`);
    }
    delete cache[rel];
    await cachedHash(cache, gameDir, rel);
  }
  removeObsolete(manifest.remove, gameDir);
  fs.writeFileSync(path.join(gameDir, "fuspvp-hashes.json"), JSON.stringify(cache));
  onProgress({ done: total, total, file: null, index: todo.length, count: todo.length });
  return todo.length;
}

/**
 * Fichiers d'origine fournis par plusieurs dossiers (dépôts Steam 1.6.1170) :
 * pour un même fichier, le premier dossier de la liste l'emporte (le dépôt de
 * langue avant les dépôts de base).
 */
function baseFilesFrom(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = [];
    for (const f of BASE_ROOT_FILES) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) files.push({ rel: f, size: fs.statSync(p).size });
    }
    const data = path.join(dir, "Data");
    if (fs.existsSync(data)) {
      for (const f of fs.readdirSync(data)) {
        if (BASE_DATA_PATTERN.test(f)) files.push({ rel: "Data/" + f, size: fs.statSync(path.join(data, f)).size });
      }
    }
    for (const f of files) {
      const key = f.rel.toLowerCase();
      if (!seen.has(key)) seen.set(key, { ...f, src: path.join(dir, f.rel) });
    }
  }
  return [...seen.values()];
}

/**
 * Déplace les fichiers d'origine des dépôts téléchargés vers le dossier FusPvP
 * (instantané sur le même disque ; copie puis suppression sinon) : pas besoin
 * d'avoir deux fois 12 Go libres. onProgress({done, total, file}) en octets.
 */
async function moveBaseFilesFrom(dirs, gameDir, onProgress) {
  const todo = baseFilesFrom(dirs);
  const total = todo.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (const { rel, src, size } of todo) {
    const dst = path.join(gameDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    onProgress({ done, total, file: rel });
    const tmp = dst + ".fuspvp-tmp";
    try {
      fs.renameSync(src, tmp);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      let last = 0;
      let copied = 0;
      await pipeline(
        fs.createReadStream(src, { highWaterMark: 4 << 20 }),
        counter((n) => {
          copied += n;
          if (Date.now() - last > 150) {
            last = Date.now();
            onProgress({ done: done + copied, total, file: rel });
          }
        }),
        fs.createWriteStream(tmp),
      );
      fs.unlinkSync(src);
    }
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.renameSync(tmp, dst);
    done += size;
  }
  onProgress({ done: total, total, file: null });
  return todo.length;
}

module.exports = {
  baseFiles, missingBaseFiles, copyBaseFiles, updateFromServer, removeObsolete, getJson, download, sha256File,
  baseFilesFrom, moveBaseFilesFrom, BASE_DATA_PATTERN,
};
