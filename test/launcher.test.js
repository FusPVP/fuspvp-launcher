// Tests du launcher FusPvP (node --test test/).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { iniSet } = require("../lib/settings");
const install = require("../lib/install");

test("iniSet remplace une clé existante sans toucher au reste", () => {
  const src = "[Display]\r\niSize W=1280\r\niSize H=720\r\n[Audio]\r\nfVal=1\r\n";
  const out = iniSet(src, "Display", "iSize W", 1920);
  assert.match(out, /iSize W=1920/);
  assert.match(out, /iSize H=720/);
  assert.match(out, /\[Audio\]\r\nfVal=1/);
});

test("iniSet ajoute la clé dans la bonne section, avant la suivante", () => {
  const out = iniSet("[Display]\r\niSize W=1280\r\n\r\n[Audio]\r\nfVal=1\r\n", "Display", "bBorderless", 1);
  assert.match(out, /iSize W=1280\r\nbBorderless=1\r\n\r\n\[Audio\]/);
});

test("iniSet crée la section si elle manque (fichier vide compris)", () => {
  assert.match(iniSet("", "Display", "bFull Screen", 0), /\[Display\]\r\nbFull Screen=0/);
  assert.match(iniSet("[Audio]\r\nfVal=1", "Display", "iSize H", 1080), /fVal=1\r\n\r\n\[Display\]\r\niSize H=1080/);
});

test("iniSet ignore la casse des sections et des clés", () => {
  assert.match(iniSet("[display]\r\nisize w=800\r\n", "Display", "iSize W", 1024), /^\[display\]\r\niSize W=1024/);
});

test("fichiers d'origine : seuls le jeu de base et les DLC officiels sont copiés", () => {
  const steam = fs.mkdtempSync(path.join(os.tmpdir(), "fuspvp-steam-"));
  const game = fs.mkdtempSync(path.join(os.tmpdir(), "fuspvp-game-"));
  fs.mkdirSync(path.join(steam, "Data"));
  for (const f of ["Skyrim.esm", "Update.esm", "Skyrim - Textures0.bsa", "SomeMod.esp", "SomeMod.bsa"]) {
    fs.writeFileSync(path.join(steam, "Data", f), "x".repeat(10));
  }
  fs.writeFileSync(path.join(steam, "SkyrimSE.exe"), "exe");
  const rels = install.baseFiles(steam).map((f) => f.rel).sort();
  assert.deepStrictEqual(rels, ["Data/Skyrim - Textures0.bsa", "Data/Skyrim.esm", "Data/Update.esm", "SkyrimSE.exe"]);

  // Déjà copié avec la bonne taille : plus rien à faire pour ce fichier.
  fs.mkdirSync(path.join(game, "Data"));
  fs.writeFileSync(path.join(game, "Data", "Skyrim.esm"), "x".repeat(10));
  fs.writeFileSync(path.join(game, "Data", "Update.esm"), "tronqué");
  const missing = install.missingBaseFiles(steam, game).map((f) => f.rel).sort();
  assert.deepStrictEqual(missing, ["Data/Skyrim - Textures0.bsa", "Data/Update.esm", "SkyrimSE.exe"]);
});

test("fichiers obsolètes : supprimés dans le dossier du jeu, jamais en dehors", () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), "fuspvp-game-"));
  const outside = path.join(path.dirname(game), path.basename(game) + "-voisin.txt");
  fs.writeFileSync(path.join(game, "Jouer-FusPvP.bat"), "x");
  fs.writeFileSync(outside, "à garder");
  install.removeObsolete(["Jouer-FusPvP.bat", "absent.ps1", "../" + path.basename(outside)], game);
  assert.ok(!fs.existsSync(path.join(game, "Jouer-FusPvP.bat")));
  assert.ok(fs.existsSync(outside));
  fs.rmSync(outside);
});

test("préréglage : seuls les réglages graphiques changent, le reste du joueur est gardé", () => {
  const { mergePreset } = require("../lib/settings");
  const mine = "[Display]\r\nsD3DDevice=\"NVIDIA GeForce RTX 3080\"\r\nfGamma=1.4000\r\nfShadowDistance=3000\r\n[Interface]\r\nbDialogueSubtitles=1\r\n";
  const ultra = "[Display]\r\nfShadowDistance=8000\r\nfGamma=1.0000\r\n[Interface]\r\nbDialogueSubtitles=0\r\n[Water]\r\nbUseWaterReflections=1\r\n";
  const out = mergePreset(mine, ultra);
  assert.match(out, /fShadowDistance=8000/);
  assert.match(out, /sD3DDevice="NVIDIA GeForce RTX 3080"/);
  assert.match(out, /fGamma=1\.4000/);
  assert.match(out, /bDialogueSubtitles=1/);
  assert.match(out, /\[Water\]\r\nbUseWaterReflections=1/);
});

// ---------------------------------------------------------------------------
// Dépôts Steam de Skyrim 1.6.1170
const steam = require("../lib/steam");

test("journal de la console Steam : en cours (taille), terminé, échec", () => {
  const d = steam.DEPOTS_1170[0];
  const lines = [
    `[2026-11-18 10:24:58] ExecCommandLine: ""C:\Steam\steam.exe" -console +download_depot 489830 ${d.id} ${d.manifest}"`,
    `[2026-11-18 10:25:00] Downloading depot ${d.id} (19 files, 4663 MB) ... `,
  ];
  let r = steam.parseDepotLog(lines.join("\n"), d, 0);
  assert.strictEqual(r.state, "downloading");
  assert.strictEqual(r.totalBytes, 4663 * 1024 * 1024);
  lines.push(`[2026-11-18 10:28:29] Depot download complete : "C:\Steam\steamapps\content\app_489830\depot_${d.id}" (manifest ${d.manifest}) `);
  assert.strictEqual(steam.parseDepotLog(lines.join("\n"), d, 0).state, "done");
  // Lignes antérieures à la demande ignorées.
  assert.strictEqual(steam.parseDepotLog(lines.join("\n"), d, Date.parse("2026-11-19T00:00:00")).state, null);
  // Autre dépôt : pas concerné.
  assert.strictEqual(steam.parseDepotLog(lines.join("\n"), steam.DEPOTS_1170[1], 0).state, null);
  // Échec.
  r = steam.parseDepotLog(`[2026-11-18 10:30:00] Depot download failed : "C:\Steam\steamapps\content\app_489830\depot_${d.id}" (No subscription)`, d, 0);
  assert.strictEqual(r.state, "failed");
});

test("dépôts : français ajouté seulement si Steam est en français", () => {
  assert.deepStrictEqual(steam.depotsFor(null).map((d) => d.id), [489831, 489832, 489833]);
  assert.deepStrictEqual(steam.depotsFor("french").map((d) => d.id), [489831, 489832, 489833, 489834]);
});

test("fichiers des dépôts : le premier dossier l'emporte, puis déplacement dans le jeu", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuspvp-depots-"));
  const lang = path.join(root, "depot_lang"), exe = path.join(root, "depot_exe"), data = path.join(root, "depot_data");
  const game = path.join(root, "game");
  const put = (p, txt) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
  put(path.join(exe, "SkyrimSE.exe"), "exe");
  put(path.join(data, "Data", "Skyrim.esm"), "esm");
  put(path.join(data, "Data", "Skyrim - Interface.bsa"), "anglais");
  put(path.join(lang, "Data", "Skyrim - Interface.bsa"), "francais");
  put(path.join(data, "Data", "ccBGSSSE001-Fish.esm"), "cc"); // contenu payant : ignoré
  const files = install.baseFilesFrom([lang, exe, data]).map((f) => f.rel).sort();
  assert.deepStrictEqual(files, ["Data/Skyrim - Interface.bsa", "Data/Skyrim.esm", "SkyrimSE.exe"]);
  const n = await install.moveBaseFilesFrom([lang, exe, data], game, () => {});
  assert.strictEqual(n, 3);
  assert.strictEqual(fs.readFileSync(path.join(game, "Data", "Skyrim - Interface.bsa"), "utf8"), "francais");
  assert.strictEqual(fs.readFileSync(path.join(game, "SkyrimSE.exe"), "utf8"), "exe");
  assert.ok(!fs.existsSync(path.join(exe, "SkyrimSE.exe"))); // déplacé, pas copié
  fs.rmSync(root, { recursive: true, force: true });
});
