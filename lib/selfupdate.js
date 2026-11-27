// selfupdate.js - Mise à jour automatique du launcher FusPvP à son démarrage.
//
// Le serveur publie http://<serveur>:3000/launcher/launcher.json
// ({ version, sha256, size }) et FusPvP-Launcher.exe (tools/publish-launcher.ps1).
// Si l'empreinte de l'exe du joueur diffère : téléchargement de la nouvelle
// version à côté (.new) et vérification. L'exe portable reste ouvert (et donc
// impossible à renommer) tant que le launcher tourne : un petit script
// PowerShell attend sa fermeture, échange les fichiers (l'ancien devient .old,
// supprimé au démarrage suivant) puis lance la nouvelle version.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { getJson, download, sha256File } = require("./install");

/**
 * Exe du launcher à remplacer : le fichier portable lancé par le joueur
 * (electron-builder s'extrait dans un dossier temporaire et donne le chemin
 * d'origine dans PORTABLE_EXECUTABLE_FILE). null en développement.
 */
function launcherExe(app) {
  return app.isPackaged ? process.env.PORTABLE_EXECUTABLE_FILE || null : null;
}

/** Supprime l'ancienne version laissée par la dernière mise à jour. */
function cleanupOld(exe) {
  if (!exe) return;
  try {
    fs.rmSync(exe + ".old", { force: true });
    fs.rmSync(exe + ".new", { force: true });
  } catch (e) {
    // encore verrouillé : on réessaiera au prochain démarrage
  }
}

/**
 * Vérifie et installe une nouvelle version du launcher.
 * @returns {Promise<"dev"|"offline"|"current"|"restarting">}
 */
async function selfUpdate(app, webBase, onProgress) {
  const exe = launcherExe(app);
  if (!exe) return "dev";
  cleanupOld(exe);
  let info;
  try {
    info = await getJson(`${webBase}/launcher/launcher.json`, 4000);
  } catch (e) {
    return "offline"; // serveur injoignable : on garde la version actuelle
  }
  const wanted = String(info.sha256 || "").toUpperCase();
  if (!wanted || (await sha256File(exe)) === wanted) return "current";

  const tmp = exe + ".new";
  let done = 0;
  onProgress({ done, total: info.size, version: info.version });
  await download(`${webBase}/launcher/FusPvP-Launcher.exe`, tmp, (n) => {
    done += n;
    onProgress({ done, total: info.size, version: info.version });
  });
  if ((await sha256File(tmp)) !== wanted) {
    fs.rmSync(tmp, { force: true });
    throw new Error("mise à jour du launcher corrompue au téléchargement");
  }
  await swapAfterExit(exe);
  return "restarting";
}

/**
 * Lance (détaché) le script qui remplace l'exe une fois le launcher fermé.
 * En cas d'échec de la 2e étape, l'ancienne version est remise en place.
 */
function swapAfterExit(exe) {
  const script = path.join(os.tmpdir(), "fuspvp-launcher-update.ps1");
  fs.writeFileSync(
    script,
    [
      "param([string]$Exe)",
      "for ($i = 0; $i -lt 120; $i++) {",
      "  Start-Sleep -Milliseconds 500",
      "  try { Move-Item -LiteralPath $Exe ($Exe + '.old') -Force -ErrorAction Stop } catch { continue }",
      "  try { Move-Item -LiteralPath ($Exe + '.new') $Exe -Force -ErrorAction Stop }",
      "  catch { Move-Item -LiteralPath ($Exe + '.old') $Exe -Force }",
      "  break",
      "}",
      "Start-Process -FilePath $Exe",
    ].join("\r\n"),
  );
  // L'exe portable place ses processus enfants dans un "job" Windows qui les
  // tue à sa fermeture : le script est créé par WMI, donc hors de ce job (et
  // avec un environnement propre, sans les variables de l'exe portable).
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -Exe "${exe}"`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command",
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:FUSPVP_CMD }; exit $r.ReturnValue"],
      { windowsHide: true, env: { ...process.env, FUSPVP_CMD: cmd } },
      (err) => (err ? reject(new Error("impossible de lancer la mise à jour du launcher")) : resolve()),
    );
  });
}

module.exports = { selfUpdate, launcherExe };
