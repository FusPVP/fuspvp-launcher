// main.js - Processus principal du launcher FusPvP (Electron).
// L'interface (renderer/) appelle les fonctions ci-dessous via preload.js.
"use strict";
const { app, BrowserWindow, ipcMain, shell, screen, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const steam = require("./lib/steam");
const install = require("./lib/install");
const auth = require("./lib/auth");
const settings = require("./lib/settings");
const { selfUpdate } = require("./lib/selfupdate");

/** Valeurs par défaut (adresse du serveur...), modifiables dans les paramètres. */
const CONFIG = {
  serverIp: "fuspvp.org",
  masterPort: 7790,
  serverPort: 7777,
  serverKey: "fuspvp",
  ...readJson(path.join(__dirname, "launcher-config.json")),
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return {};
  }
}

let win = null;
let busy = false; // une seule opération longue à la fois
let loginCancelled = false;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/**
 * Dossier du jeu FusPvP : réglage du joueur, sinon à côté du Skyrim Steam
 * (ou dans la bibliothèque principale de Steam si Skyrim n'est pas installé).
 */
function gameDirFor(s, sky) {
  if (s.gameDir) return s.gameDir;
  const library = sky && (sky.library || sky.steam);
  if (library) {
    const dir = path.join(library, "steamapps", "common", steam.FUSPVP_FOLDER);
    // Ancien nom du projet (FusRP) : le dossier du jeu est renommé une fois,
    // sans recopier les 15 Go de Skyrim.
    const old = path.join(library, "steamapps", "common", "Skyrim Special Edition - FusRP");
    if (!fs.existsSync(dir) && fs.existsSync(old)) {
      try {
        fs.renameSync(old, dir);
      } catch (e) {
        return old; // jeu ouvert ou dossier verrouillé : on garde l'ancien pour cette fois
      }
    }
    return dir;
  }
  return null;
}

function isGameRunning() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq SkyrimSE.exe", "/NH"], { windowsHide: true }, (err, out) =>
      resolve(!err && /SkyrimSE\.exe/i.test(out)),
    );
  });
}

async function serverOnline(s) {
  try {
    await install.getJson(`${settings.endpoints(s).web}/client/manifest.json`, 4000);
    return true;
  } catch (e) {
    return false;
  }
}

/** État complet affiché par l'interface. */
/**
 * État du serveur donné par le master : joueurs en ligne (X / 100), file
 * d'attente, mode développement. null si le master ne répond pas.
 */
async function serverStatus(s) {
  try {
    const res = await fetch(`${settings.masterUrl(s)}/api/servers/${encodeURIComponent(s.serverKey)}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function status() {
  const s = settings.load(CONFIG);
  const sky = await steam.findSkyrim();
  const gameDir = gameDirFor(s, sky);
  let gameVersion = null;
  let missingBytes = null;
  if (gameDir && fs.existsSync(path.join(gameDir, "SkyrimSE.exe"))) {
    gameVersion = await steam.fileVersion(path.join(gameDir, "SkyrimSE.exe"));
  }
  if (gameDir && sky.dir && sky.versionOk) {
    missingBytes = install.missingBaseFiles(sky.dir, gameDir).reduce((t, f) => t + f.size, 0);
  }
  const depots = steam.depotsFor(await gameLanguage());
  return {
    skyrim: sky,
    // Skyrim 1.6.1170 téléchargeable par les dépôts Steam (Steam installé).
    canDownload: !!sky.steam,
    downloadBytes: depots.reduce((t, d) => t + d.approxBytes, 0),
    requiredVersion: steam.REQUIRED_VERSION,
    gameDir,
    gameVersion,
    gameVersionOk: !!gameVersion && gameVersion.startsWith(steam.REQUIRED_VERSION + "."),
    missingBytes,
    profile: auth.savedProfile(),
    settings: s,
    online: await serverOnline(s),
    server: await serverStatus(s),
    running: await isGameRunning(),
    currentDisplay: settings.readDisplay(),
    screen: (() => {
      const d = screen.getPrimaryDisplay();
      return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    })(),
  };
}

/** Après l'apparition de la fenêtre du jeu, délai avant de fermer le launcher. */
const GAME_WINDOW_GRACE_MS = 15000;
/** Attente maximale de la fenêtre du jeu. */
const GAME_WINDOW_TIMEOUT_MS = 3 * 60 * 1000;

/** Fenêtre "Skyrim Special Edition" ouverte par SkyrimSE.exe ? */
function gameWindowOpen() {
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/V", "/FO", "CSV", "/NH", "/FI", "IMAGENAME eq SkyrimSE.exe"],
      { windowsHide: true },
      (err, out) => resolve(!err && /"Skyrim Special Edition"/i.test(out)),
    );
  });
}

async function waitForGameWindow() {
  const deadline = Date.now() + GAME_WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gameWindowOpen()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Langue du jeu à installer : celle de Steam ("french"...), sinon anglais. */
let cachedLanguage;
async function gameLanguage() {
  if (cachedLanguage === undefined) cachedLanguage = await steam.steamLanguage();
  return cachedLanguage;
}

/** Sans signe de vie de Steam pendant ce délai, le téléchargement est abandonné. */
const DEPOT_START_TIMEOUT_MS = 3 * 60 * 1000;
const DEPOT_STALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Télécharge Skyrim SE 1.6.1170 par les dépôts Steam (voir lib/steam.js) puis
 * déplace ses fichiers d'origine dans le dossier FusPvP. Le Skyrim Steam du
 * joueur, s'il existe, n'est pas modifié. Renvoie les avertissements éventuels.
 */
async function installSkyrim1170(sky, gameDir) {
  const language = await gameLanguage();
  const depots = steam.depotsFor(language);
  const warnings = [];
  // Place disque : les dépôts arrivent dans le dossier de Steam, puis sont déplacés.
  const missing = depots.filter((d) => !fs.existsSync(steam.depotDir(sky.steam, d)));
  const need = missing.reduce((t, d) => t + d.approxBytes, 0) + 1e9;
  try {
    const fsInfo = fs.statfsSync(sky.steam);
    const free = fsInfo.bavail * fsInfo.bsize;
    if (free < need) {
      throw new Error(`place insuffisante sur le disque de Steam : ${Math.ceil(need / 1e9)} Go nécessaires, ${Math.floor(free / 1e9)} Go libres`);
    }
  } catch (e) {
    if (/place insuffisante/.test(e.message)) throw e; // statfs indisponible : on tente quand même
  }

  const ok = [];
  for (const [i, d] of depots.entries()) {
    const dir = steam.depotDir(sky.steam, d);
    const progress = (extra) => send("progress", { phase: "depot", index: i + 1, count: depots.length, label: d.label, ...extra });
    // Déjà téléchargé (launcher relancé après coup) : rien à refaire.
    if (fs.existsSync(dir) && steam.depotLogState(sky.steam, d, 0).state === "done" && steam.dirSize(dir) >= d.approxBytes * 0.9) {
      ok.push(d);
      continue;
    }
    const since = Date.now();
    progress({ waiting: true, done: 0, total: d.approxBytes });
    steam.requestDepot(sky.steam, d);
    let total = d.approxBytes;
    let lastSize = -1;
    let lastChange = Date.now();
    let started = false;
    for (;;) {
      await sleep(2000);
      const log = steam.depotLogState(sky.steam, d, since);
      if (log.totalBytes) total = log.totalBytes;
      const size = steam.dirSize(dir);
      if (log.state === "downloading" || size > 0) started = true;
      if (log.state === "done") break;
      let failure = log.state === "failed" ? log.message || "Steam a refusé le téléchargement" : null;
      if (size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      } else if (!started && Date.now() - lastChange > DEPOT_START_TIMEOUT_MS) {
        failure = "Steam n'a pas commencé le téléchargement";
      } else if (started && Date.now() - lastChange > DEPOT_STALL_TIMEOUT_MS) {
        failure = "le téléchargement Steam est bloqué depuis 15 minutes";
      }
      if (failure) {
        if (d.optional) {
          warnings.push(`${d.label} indisponible (${failure}) : le jeu sera en anglais.`);
          break;
        }
        throw new Error(
          `${failure} (${d.label}). Ouvre Steam, connecte-toi avec le compte qui possède Skyrim Special Edition, puis clique de nouveau sur Installer.`,
        );
      }
      progress({ waiting: !started, done: Math.min(size, total), total });
    }
    if (!warnings.some((w) => w.startsWith(d.label))) ok.push(d);
  }

  // Dépôt de langue d'abord (il remplace des fichiers anglais), puis l'exécutable, puis les données.
  const dirs = [...ok].reverse().map((d) => steam.depotDir(sky.steam, d));
  send("progress", { phase: "move", done: 0, total: 1 });
  await install.moveBaseFilesFrom(dirs, gameDir, (p) => send("progress", { phase: "move", ...p }));
  const v = await steam.fileVersion(path.join(gameDir, "SkyrimSE.exe"));
  if (!v || !v.startsWith(steam.REQUIRED_VERSION + ".")) {
    throw new Error(`le jeu téléchargé est en version ${v || "inconnue"} au lieu de la ${steam.REQUIRED_VERSION}`);
  }
  // Dépôts vidés : on libère la place.
  for (const d of ok) fs.rmSync(steam.depotDir(sky.steam, d), { recursive: true, force: true });
  return warnings;
}

/**
 * Installe ou met à jour : fichiers d'origine de Skyrim 1.6.1170 (copiés depuis
 * le Skyrim Steam s'il est dans la bonne version, sinon téléchargés par les
 * dépôts Steam), puis fichiers FusPvP depuis le serveur. Progression sur "progress".
 */
async function installOrUpdate() {
  const s = settings.load(CONFIG);
  const sky = await steam.findSkyrim();
  if (!sky.steam) throw new Error(sky.error || "Steam n'est pas installé sur ce PC.");
  const gameDir = gameDirFor(s, sky);
  if (await isGameRunning()) throw new Error("ferme Skyrim avant la mise à jour");
  let warnings = [];
  const missing = sky.versionOk ? install.missingBaseFiles(sky.dir, gameDir) : [];
  if (!sky.versionOk) {
    // Skyrim Steam absent ou dans une autre version (1.7...) : la 1.6.1170 est
    // téléchargée par les dépôts Steam, sauf si le dossier FusPvP l'a déjà.
    const v = fs.existsSync(path.join(gameDir, "SkyrimSE.exe"))
      ? await steam.fileVersion(path.join(gameDir, "SkyrimSE.exe"))
      : null;
    if (!v || !v.startsWith(steam.REQUIRED_VERSION + ".")) warnings = await installSkyrim1170(sky, gameDir);
  }
  if (missing.length) {
    send("progress", { phase: "copy", done: 0, total: 1 });
    await install.copyBaseFiles(sky.dir, gameDir, (p) => send("progress", { phase: "copy", ...p }));
  }
  const n = await install.updateFromServer(settings.endpoints(s).web, gameDir, (p) => send("progress", { phase: "update", ...p }));
  send("progress", { phase: "done", updated: n });
  return { updated: n, copied: missing.length, warnings };
}

let queueCancelled = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Demande une place au master, en restant dans la file d'attente tant que le serveur est complet. */
async function waitForPlace(s) {
  queueCancelled = false;
  const master = settings.masterUrl(s);
  for (;;) {
    const r = await auth.requestPlaySession(master, s.serverKey);
    if (!r.queued) return r;
    send("progress", { phase: "queue", position: r.position, size: r.size });
    for (let i = 0; i < 30 && !queueCancelled; i++) await sleep(100); // nouvelle demande toutes les 3 s
    if (queueCancelled) {
      await auth.leaveQueue(master, s.serverKey);
      throw new Error("tu as quitté la file d'attente");
    }
  }
}

async function play() {
  const s = settings.load(CONFIG);
  const sky = await steam.findSkyrim();
  const gameDir = gameDirFor(s, sky);
  if (await isGameRunning()) throw new Error("Skyrim est déjà lancé");
  await installOrUpdate();
  // Adresse IP du serveur de jeu (UDP) : résolue ici, le client SkyMP reçoit une IP.
  const gameHost = settings.endpoints(s).gameHost;
  let gameIp = gameHost;
  try {
    gameIp = (await require("dns").promises.lookup(gameHost, { family: 4 })).address;
  } catch (e) {
    throw new Error(`adresse du serveur introuvable (${gameHost}) : vérifie ta connexion`);
  }
  settings.writeClientSettings(s, gameDir, gameIp);
  settings.writePluginsTxt();
  settings.writeDisplay(s.display, gameDir, s.appliedPreset);
  if (s.display && s.display.preset !== s.appliedPreset) {
    s.appliedPreset = s.display.preset;
    settings.save(s);
  }
  // Place sur le serveur (file d'attente si complet), puis lancement.
  auth.writePlaySession(await waitForPlace(s), gameDir);
  send("progress", { phase: "launch" });
  const loader = path.join(gameDir, "skse64_loader.exe");
  if (!fs.existsSync(loader)) throw new Error("skse64_loader.exe introuvable dans le dossier du jeu");
  spawn(loader, [], { cwd: gameDir, detached: true, stdio: "ignore" }).unref();
  // Le launcher reste ouvert (au premier plan) jusqu'à ce que la fenêtre du jeu
  // existe, puis encore un peu : se fermer pendant que Skyrim crée sa fenêtre
  // lui faisait perdre le premier plan (en plein écran exclusif : écran noir,
  // son du jeu, bureau bloqué).
  waitForGameWindow().then(() => setTimeout(() => app.quit(), GAME_WINDOW_GRACE_MS));
}

/** Exécute une opération longue en signalant les erreurs à l'interface. */
function guarded(fn) {
  return async (...args) => {
    if (busy) return { ok: false, error: "une opération est déjà en cours" };
    busy = true;
    try {
      return { ok: true, result: await fn(...args) };
    } catch (e) {
      send("progress", { phase: "error", error: e.message });
      return { ok: false, error: e.message };
    } finally {
      busy = false;
    }
  };
}

ipcMain.handle("status", () => status());
ipcMain.handle("version", () => app.getVersion());
// Au démarrage, avant tout le reste : nouvelle version du launcher ?
ipcMain.handle("selfUpdate", async () => {
  try {
    const s = settings.load(CONFIG);
    const r = await selfUpdate(app, settings.endpoints(s).web, (p) => send("progress", { phase: "self", ...p }));
    if (r === "restarting") setTimeout(() => app.quit(), 500);
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("install", guarded(installOrUpdate));
ipcMain.handle("play", guarded(play));
ipcMain.handle("login", async () => {
  loginCancelled = false;
  const s = settings.load(CONFIG);
  try {
    return { ok: true, result: await auth.login(settings.masterUrl(s), (u) => shell.openExternal(u), () => loginCancelled) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("cancelLogin", () => {
  loginCancelled = true;
});
ipcMain.handle("logout", () => auth.logout());
ipcMain.handle("cancelQueue", () => {
  queueCancelled = true;
});
ipcMain.handle("saveSettings", (_e, next) => {
  const cur = settings.load(CONFIG);
  const merged = { ...cur, ...next, voice: { ...cur.voice, ...next.voice }, keys: { ...cur.keys, ...next.keys } };
  settings.save(merged);
  return merged;
});
// Réseaux sociaux du menu du haut : seules ces adresses peuvent être ouvertes.
const SOCIAL_LINKS = {
  discord: "https://discord.gg/ckmEXCE2mV",
  youtube: "https://www.youtube.com/@FUSPVP",
  tiktok: "https://www.tiktok.com/@fuspvp",
};
ipcMain.handle("openLink", (_e, key) => {
  if (Object.hasOwn(SOCIAL_LINKS, key)) shell.openExternal(SOCIAL_LINKS[key]);
});

ipcMain.handle("openFolder", async () => {
  const st = await status();
  if (st.gameDir && fs.existsSync(st.gameDir)) shell.openPath(st.gameDir);
});
ipcMain.handle("quit", () => app.quit());
ipcMain.handle("minimize", () => win && win.minimize());

app.whenReady().then(() => {
  // Le micro est demandé par la page des paramètres (liste et test des micros).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  win = new BrowserWindow({
    width: 1100,
    height: 680,
    resizable: false,
    frame: false,
    backgroundColor: "#000000",
    title: "FusPvP",
    icon: path.join(__dirname, "renderer", "icon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Outil de développement : FUSPVP_LAUNCHER_SNAPSHOT=<dossier> enregistre une
  // capture de la fenêtre du launcher (uniquement elle) toutes les 2 s, et
  // FUSPVP_LAUNCHER_JS=<code> exécute du code dans la page (tests).
  const snapDir = process.env.FUSPVP_LAUNCHER_SNAPSHOT;
  if (snapDir) {
    win.webContents.on("console-message", (_e, level, message, line, source) =>
      console.log(`[page ${level}] ${message} (${source}:${line})`),
    );
    let n = 0;
    setInterval(async () => {
      if (!win || win.isDestroyed()) return;
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(snapDir, `launcher-${n++ % 10}.png`), img.toPNG());
    }, 2000);
  }
  if (process.env.FUSPVP_LAUNCHER_JS) {
    win.webContents.once("did-finish-load", () =>
      setTimeout(() => win.webContents.executeJavaScript(process.env.FUSPVP_LAUNCHER_JS), 1500),
    );
  }
});

app.on("window-all-closed", () => app.quit());
