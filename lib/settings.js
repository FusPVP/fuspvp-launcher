// settings.js - Réglages du launcher FusPvP et leur application au jeu.
//
// Gardés dans %APPDATA%\FusPvP\launcher-settings.json. Avant chaque partie :
//  - skymp5-client-settings.txt : adresse du serveur + réglages FusPvP lus en
//    jeu (micro, sortie audio, volumes, touches du chat vocal) ;
//  - Plugins.txt : FusPvP.esp actif (fichier partagé avec le Skyrim normal) ;
//  - SkyrimPrefs.ini : résolution, mode d'affichage, préréglage graphique.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const FILE = path.join(process.env.APPDATA || os.homedir(), "FusPvP", "launcher-settings.json");
// Ancien nom du projet (FusRP) : réglages repris une fois.
const OLD_FILE = path.join(process.env.APPDATA || os.homedir(), "FusRP", "launcher-settings.json");
try {
  if (!fs.existsSync(FILE) && fs.existsSync(OLD_FILE)) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.copyFileSync(OLD_FILE, FILE);
  }
} catch (e) {
  // pas grave : réglages par défaut
}
/** Dossier des .ini de Skyrim SE (partagé avec le Skyrim normal du PC). */
const MY_GAMES = path.join(os.homedir(), "Documents", "My Games", "Skyrim Special Edition");
const PLUGINS_DIR = path.join(process.env.LOCALAPPDATA || "", "Skyrim Special Edition");

/** Touches FusPvP par défaut (codes DirectInput) : V parler, B portée. */
const DEFAULT_KEYS = { talk: 0x2f, range: 0x30 };

/** Adresse officielle : HTTPS (game.fuspvp.org, account.fuspvp.org). */
const OFFICIAL_SERVER = "fuspvp.org";
/** Anciennes adresses par défaut (PC de développement, IP du VPS) : migrées vers le domaine. */
const LEGACY_SERVERS = ["192.168.68.58", "45.147.97.140", ""];

/**
 * Adresses dérivées du réglage « Adresse du serveur » :
 *  - fuspvp.org (officiel) : HTTPS par domaine, jeu sur game.fuspvp.org ;
 *  - toute autre adresse (serveur de test local) : HTTP sur les ports SkyMP.
 */
function endpoints(s) {
  const host = String(s.serverIp || OFFICIAL_SERVER).trim();
  if (host === OFFICIAL_SERVER || host === "game.fuspvp.org") {
    return { web: "https://game.fuspvp.org", master: "https://account.fuspvp.org", gameHost: "game.fuspvp.org" };
  }
  return { web: `http://${host}:3000`, master: `http://${host}:${s.masterPort}`, gameHost: host };
}

function defaults(config) {
  return {
    serverIp: config.serverIp,
    masterPort: config.masterPort,
    serverPort: config.serverPort,
    serverKey: config.serverKey,
    gameDir: null, // null = à côté du Skyrim Steam
    voice: { input: "", output: "", micVolume: 100, voiceVolume: 100 },
    keys: { ...DEFAULT_KEYS },
    display: null, // null = ne pas toucher aux .ini du joueur
  };
}

function load(config) {
  const d = defaults(config);
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // Réglages repris de l'ancien nom (FusRP) : clé du master et dossier du jeu.
    if (s.serverKey === "fusrp") s.serverKey = d.serverKey;
    if (LEGACY_SERVERS.includes(String(s.serverIp ?? "").trim())) s.serverIp = OFFICIAL_SERVER;
    if (typeof s.gameDir === "string") s.gameDir = s.gameDir.replace("Skyrim Special Edition - FusRP", "Skyrim Special Edition - FusPvP");
    return { ...d, ...s, voice: { ...d.voice, ...s.voice }, keys: { ...d.keys, ...s.keys } };
  } catch (e) {
    return d;
  }
}

function save(settings) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
}

function masterUrl(s) {
  return endpoints(s).master;
}

/**
 * Réglages lus par le client SkyMP et le HUD FusPvP en jeu.
 * gameIp : adresse IP du serveur de jeu (UDP), résolue par le launcher.
 */
function writeClientSettings(s, gameDir, gameIp) {
  const p = path.join(gameDir, "Data", "Platform", "Plugins", "skymp5-client-settings.txt");
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    // fichier absent ou invalide : recréé
  }
  const out = {
    ...cur,
    master: masterUrl(s),
    "server-ip": gameIp || endpoints(s).gameHost,
    // HUD (page web) et chat vocal : HTTPS / WSS sur le domaine officiel.
    "fuspvp-web": endpoints(s).web,
    "server-master-key": s.serverKey,
    "server-port": s.serverPort,
    "fuspvp-voice": {
      input: s.voice.input,
      output: s.voice.output,
      micVolume: s.voice.micVolume,
      voiceVolume: s.voice.voiceVolume,
    },
    "fuspvp-keys": { talk: s.keys.talk, range: s.keys.range },
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
}

/**
 * Plugins.txt est partagé avec le Skyrim normal : un lancement de Skyrim via
 * Steam peut désactiver FusPvP.esp. Sauvegarde unique de la version d'origine.
 */
function writePluginsTxt() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const p = path.join(PLUGINS_DIR, "Plugins.txt");
  const backup = p + ".avant-fuspvp";
  if (fs.existsSync(p) && !fs.existsSync(backup)) fs.copyFileSync(p, backup);
  fs.writeFileSync(
    p,
    "# This file is used by Skyrim to keep track of your downloaded content.\r\n" +
      "# Please do not modify this file.\r\n*FusPvP.esp\r\n",
  );
}

// ---------------------------------------------------------------------------
// INI de Skyrim (lecture/écriture simple, ordre et commentaires conservés)

function iniSet(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\[.*\]$/.test(t)) {
      if (inSection) {
        sectionEnd = i;
        break;
      }
      inSection = t.slice(1, -1).toLowerCase() === section.toLowerCase();
      continue;
    }
    if (inSection && t.toLowerCase().startsWith(key.toLowerCase() + "=")) {
      lines[i] = `${key}=${value}`;
      return lines.join("\r\n");
    }
  }
  if (inSection) {
    // section trouvée (dernière du fichier ou terminée à sectionEnd) : on ajoute la clé
    const at = sectionEnd === -1 ? lines.length : sectionEnd;
    let insert = at;
    while (insert > 0 && lines[insert - 1].trim() === "") insert--;
    lines.splice(insert, 0, `${key}=${value}`);
    return lines.join("\r\n");
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push("", `[${section}]`, `${key}=${value}`);
  return lines.join("\r\n") + "\r\n";
}

/**
 * Sections d'un préréglage jamais recopiées : réglages du joueur (sous-titres,
 * commandes, luminosité...), pas des réglages graphiques.
 */
const PRESET_SKIPPED_SECTIONS = new Set(["interface", "controls", "main", "gameplay", "launcher", "audio", "saveload"]);
/** Clés d'affichage propres au PC (carte graphique choisie par Skyrim) : jamais écrasées. */
const PRESET_SKIPPED_KEYS = new Set(["sd3ddevice", "iadapter", "ulastaspectratio", "fgamma"]);

/**
 * Applique les réglages graphiques d'un préréglage (Low.ini ... Ultra.ini) au
 * SkyrimPrefs.ini du joueur, clé par clé : le reste du fichier est conservé.
 */
function mergePreset(text, preset) {
  let section = "";
  for (const raw of preset.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    const kv = /^([^=;#]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv || !section || PRESET_SKIPPED_SECTIONS.has(section.toLowerCase())) continue;
    if (PRESET_SKIPPED_KEYS.has(kv[1].toLowerCase())) continue;
    text = iniSet(text, section, kv[1], kv[2]);
  }
  return text;
}

/** Préréglages graphiques de Skyrim (fichiers du jeu : Low.ini ... Ultra.ini). */
const PRESETS = { bas: "Low.ini", moyen: "Medium.ini", haut: "High.ini", ultra: "Ultra.ini" };
/** Modes d'affichage -> [bFull Screen, bBorderless]. */
const MODES = { pleinEcran: [1, 0], fenetre: [0, 0], sansBordure: [0, 1] };

/**
 * Applique résolution, mode et préréglage à SkyrimPrefs.ini. Le préréglage
 * n'est recopié que s'il a changé (il remplace tous les réglages graphiques).
 * Sauvegarde unique : SkyrimPrefs.ini.avant-fuspvp.
 */
function writeDisplay(display, gameDir, lastPreset) {
  if (!display) return;
  fs.mkdirSync(MY_GAMES, { recursive: true });
  const prefs = path.join(MY_GAMES, "SkyrimPrefs.ini");
  const backup = prefs + ".avant-fuspvp";
  if (fs.existsSync(prefs) && !fs.existsSync(backup)) fs.copyFileSync(prefs, backup);
  let text = fs.existsSync(prefs) ? fs.readFileSync(prefs, "latin1") : "";
  if (display.preset && display.preset !== lastPreset && PRESETS[display.preset]) {
    const src = path.join(gameDir, PRESETS[display.preset]);
    if (fs.existsSync(src)) text = mergePreset(text, fs.readFileSync(src, "latin1"));
  }
  const [full, borderless] = MODES[display.mode] || MODES.pleinEcran;
  text = iniSet(text, "Display", "iSize W", display.width);
  text = iniSet(text, "Display", "iSize H", display.height);
  text = iniSet(text, "Display", "bFull Screen", full);
  text = iniSet(text, "Display", "bBorderless", borderless);
  fs.writeFileSync(prefs, text, "latin1");
}

/** Réglages d'affichage actuels du joueur (lus dans SkyrimPrefs.ini). */
function readDisplay() {
  try {
    const text = fs.readFileSync(path.join(MY_GAMES, "SkyrimPrefs.ini"), "latin1");
    const get = (k) => {
      const m = new RegExp("^\\s*" + k.replace(/ /g, "\\s") + "\\s*=\\s*(\\S+)", "mi").exec(text);
      return m ? m[1] : null;
    };
    const full = get("bFull Screen") === "1";
    const borderless = get("bBorderless") === "1";
    return {
      width: Number(get("iSize W")) || null,
      height: Number(get("iSize H")) || null,
      mode: full ? "pleinEcran" : borderless ? "sansBordure" : "fenetre",
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  load, save, masterUrl, endpoints, writeClientSettings, writePluginsTxt, writeDisplay, readDisplay, iniSet, mergePreset,
  DEFAULT_KEYS, PRESETS, MODES, FILE,
};
