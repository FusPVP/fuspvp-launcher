// steam.js - Trouve l'installation Steam de Skyrim Special Edition et lit sa
// version (SkyrimSE.exe) et sa langue (appmanifest Steam).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/** Identifiant Steam de Skyrim Special Edition. */
const SSE_APP_ID = 489830;
/** Seule version du jeu supportée par FusPvP (SKSE, SkyrimPlatform, Address Library). */
const REQUIRED_VERSION = "1.6.1170";
/** Nom du dossier du jeu FusPvP, à côté du Skyrim Steam (le Skyrim normal reste intact). */
const FUSPVP_FOLDER = "Skyrim Special Edition - FusPvP";

/** Dossier d'installation de Steam, lu dans le registre (HKCU puis HKLM). */
function steamPath() {
  return new Promise((resolve) => {
    const keys = [
      ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
      ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
    ];
    const next = (i) => {
      if (i >= keys.length) return resolve(null);
      execFile("reg", ["query", keys[i][0], "/v", keys[i][1]], { windowsHide: true }, (err, out) => {
        const m = !err && /REG_SZ\s+(.+)/.exec(out);
        if (m) return resolve(path.normalize(m[1].trim()));
        next(i + 1);
      });
    };
    next(0);
  });
}

/** Bibliothèques Steam (libraryfolders.vdf) : dossiers contenant steamapps/. */
function libraryFolders(steam) {
  const libs = [steam];
  try {
    const vdf = fs.readFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"), "utf8");
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = path.normalize(m[1].replace(/\\\\/g, "\\"));
      if (!libs.some((l) => l.toLowerCase() === p.toLowerCase())) libs.push(p);
    }
  } catch (e) {
    // pas de bibliothèque supplémentaire
  }
  return libs;
}

/** Version de fichier d'un exécutable Windows (ex. "1.6.1170.0"), via PowerShell. */
function fileVersion(exe) {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { windowsHide: true },
      (err, out) => resolve(err ? null : out.trim() || null),
    );
  });
}

/**
 * Cherche Skyrim SE installé par Steam.
 * @returns {Promise<{steam, library, dir, version, versionOk, language} | {steam, error}>}
 */
async function findSkyrim() {
  const steam = await steamPath();
  if (!steam) return { error: "Steam n'est pas installé sur ce PC." };
  for (const lib of libraryFolders(steam)) {
    const manifest = path.join(lib, "steamapps", `appmanifest_${SSE_APP_ID}.acf`);
    if (!fs.existsSync(manifest)) continue;
    const acf = fs.readFileSync(manifest, "utf8");
    const installdir = (/"installdir"\s+"([^"]+)"/.exec(acf) || [])[1] || "Skyrim Special Edition";
    const dir = path.join(lib, "steamapps", "common", installdir);
    const exe = path.join(dir, "SkyrimSE.exe");
    if (!fs.existsSync(exe)) continue;
    const version = await fileVersion(exe);
    const language = (/"language"\s+"([^"]+)"/.exec(acf) || [])[1] || null;
    return {
      steam,
      library: lib,
      dir,
      version,
      versionOk: !!version && version.startsWith(REQUIRED_VERSION + "."),
      language,
    };
  }
  return { steam, error: "Skyrim Special Edition n'est pas installé dans Steam." };
}

// ---------------------------------------------------------------------------
// Téléchargement de Skyrim SE 1.6.1170 par les dépôts Steam
//
// Steam ne propose que la dernière version du jeu (1.7.x). La 1.6.1170 reste
// disponible sous forme de dépôts : la commande de console Steam
// "download_depot 489830 <dépôt> <manifeste>" les télécharge dans
// steamapps/content/app_489830/depot_<dépôt>, pour tout compte qui possède le
// jeu, même s'il n'est pas installé. Le launcher passe la commande à Steam en
// ligne de commande (steam.exe -console +download_depot ...) et suit sa fin
// dans le journal de la console Steam (logs/console_log.txt).

/** Dépôts de Skyrim SE 1.6.1170 (manifestes vérifiés : jeu 1.6.1170 obtenu). */
const DEPOTS_1170 = [
  { id: 489831, manifest: "8442952117333549665", label: "données du jeu (1/2)", approxBytes: 4.9e9 },
  { id: 489832, manifest: "8042843504692938467", label: "données du jeu (2/2)", approxBytes: 7.6e9 },
  { id: 489833, manifest: "1914580699073641964", label: "exécutable 1.6.1170", approxBytes: 2.7e7 },
];
/**
 * Dépôts de langue (voix et textes), téléchargés si Steam est dans cette
 * langue. Facultatifs : en cas d'échec, le jeu reste en anglais.
 */
const LANGUAGE_DEPOTS_1170 = {
  french: { id: 489834, manifest: "8562891139598763344", label: "voix et textes français", approxBytes: 1.83e9, optional: true },
};

/** Langue de l'interface Steam (registre), ex. "french", ou null. */
function steamLanguage() {
  return new Promise((resolve) => {
    execFile("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "Language"], { windowsHide: true }, (err, out) => {
      const m = !err && /REG_SZ\s+(.+)/.exec(out);
      resolve(m ? m[1].trim().toLowerCase() : null);
    });
  });
}

/** Dépôts à télécharger pour une langue de jeu ("french" ajoute le dépôt français). */
function depotsFor(language) {
  const lang = LANGUAGE_DEPOTS_1170[language];
  return lang ? [...DEPOTS_1170, lang] : [...DEPOTS_1170];
}

/** Dossier où Steam dépose un dépôt téléchargé. */
function depotDir(steam, depot) {
  return path.join(steam, "steamapps", "content", `app_${SSE_APP_ID}`, `depot_${depot.id}`);
}

/** Demande à Steam (déjà ouvert ou non) de télécharger un dépôt. */
function requestDepot(steam, depot) {
  const { spawn } = require("child_process");
  const exe = path.join(steam, "steam.exe");
  if (!fs.existsSync(exe)) throw new Error("steam.exe introuvable");
  spawn(exe, ["-console", "+download_depot", String(SSE_APP_ID), String(depot.id), depot.manifest], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Analyse du journal de la console Steam, lignes écrites à partir de sinceMs :
 *   "Downloading depot 489831 (19 files, 4663 MB) ..."        -> en cours, taille totale
 *   "Depot download complete : "...\depot_489831" (manifest N)" -> terminé
 *   "Depot download failed ..." / refus de la commande         -> échec
 * Renvoie { state: "downloading" | "done" | "failed" | null, totalBytes, message }.
 */
function parseDepotLog(text, depot, sinceMs = 0) {
  const out = { state: null, totalBytes: null, message: null };
  for (const line of text.split(/\r?\n/)) {
    const t = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]\s*(.*)$/.exec(line);
    if (!t || new Date(t[1].replace(" ", "T")).getTime() < sinceMs - 2000) continue;
    const msg = t[2];
    if (/ExecCommandLine/i.test(msg)) continue;
    const id = String(depot.id);
    const dl = /Downloading depot (\d+) \((\d+) files?, (\d+) MB\)/i.exec(msg);
    if (dl && dl[1] === id) {
      out.state = "downloading";
      out.totalBytes = Number(dl[3]) * 1024 * 1024;
    } else if (/Depot download complete/i.test(msg) && msg.includes(`depot_${id}`)) {
      if (msg.includes(depot.manifest)) out.state = "done";
    } else if (/Depot download failed/i.test(msg) && (msg.includes(`depot_${id}`) || msg.includes(` ${id}`))) {
      out.state = "failed";
      out.message = msg.trim();
    } else if (/download_depot/i.test(msg) && /fail|denied|invalid|not (own|available|found)|usage/i.test(msg)) {
      out.state = "failed";
      out.message = msg.trim();
    }
  }
  return out;
}

/** État d'un dépôt d'après le journal de la console Steam (logs/console_log*.txt). */
function depotLogState(steam, depot, sinceMs = 0) {
  let text = "";
  for (const f of ["console_log.previous.txt", "console_log.txt"]) {
    try {
      text += fs.readFileSync(path.join(steam, "logs", f), "utf8") + "\n";
    } catch (e) {
      // journal absent
    }
  }
  return parseDepotLog(text, depot, sinceMs);
}

/** Taille actuelle (octets) d'un dossier (dépôt en cours de téléchargement). */
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch (err) {
          // fichier en cours d'écriture
        }
      }
    }
  };
  walk(dir);
  return total;
}

module.exports = {
  findSkyrim, fileVersion, REQUIRED_VERSION, FUSPVP_FOLDER, SSE_APP_ID,
  DEPOTS_1170, LANGUAGE_DEPOTS_1170, steamLanguage, depotsFor, depotDir, requestDepot, depotLogState, parseDepotLog, dirSize,
};
