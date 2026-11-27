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

module.exports = { findSkyrim, fileVersion, REQUIRED_VERSION, FUSPVP_FOLDER, SSE_APP_ID };
