// app.js - Logique de l'interface du launcher FusPvP.
// Accueil : vérifie Skyrim, le serveur, la connexion Discord, installe / met à
// jour les fichiers puis lance le jeu. Paramètres : audio, touches, affichage.
"use strict";
const $ = (id) => document.getElementById(id);
const api = window.fuspvp;
const { DX_BY_CODE, SPECIAL_NAMES, RESERVED, keyName } = window.FuspvpKeys;

let st = null; // dernier état renvoyé par le processus principal
let working = false; // installation / lancement en cours
let ready = false; // fichiers à jour

// ---------------------------------------------------------------------------
// Utilitaires d'affichage

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + " Go";
  if (n >= 1e6) return Math.round(n / 1e6) + " Mo";
  return Math.max(1, Math.round(n / 1e3)) + " Ko";
}

function setCheck(id, state, value) {
  const li = $(id);
  li.className = state;
  li.querySelector(".value").textContent = value;
}

function setMessage(text, isError) {
  $("message").textContent = text || "";
  $("message").className = isError ? "error" : "";
}

function showView(id) {
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("active", v.id === id);
}

// ---------------------------------------------------------------------------
// Accueil

async function refresh() {
  st = await api.status();
  const sky = st.skyrim;
  if (sky.error) setCheck("chk-skyrim", "err", sky.error);
  else if (!sky.versionOk && !st.gameVersionOk) setCheck("chk-skyrim", "err", `version ${sky.version || "?"} (${st.requiredVersion} requise)`);
  else if (sky.language && sky.language !== "french") setCheck("chk-skyrim", "warn", `${st.requiredVersion} - jeu en ${sky.language} (français conseillé)`);
  else setCheck("chk-skyrim", "ok", `version ${st.requiredVersion}`);

  if (!st.gameVersionOk) setCheck("chk-game", "warn", st.missingBytes ? `à installer (${fmtBytes(st.missingBytes)})` : "à installer");
  else if (st.missingBytes) setCheck("chk-game", "warn", `incomplet (${fmtBytes(st.missingBytes)} à copier)`);
  else if (!ready) setCheck("chk-game", "busy", "vérification...");

  const srv = st.server;
  const players = srv && srv.online !== null && srv.online !== undefined ? `${srv.online} / ${srv.max} joueurs` : null;
  const full = srv && players && srv.online >= srv.max;
  if (!st.online) setCheck("chk-server", "err", `injoignable (${st.settings.serverIp})`);
  else if (srv && srv.devMode) setCheck("chk-server", "warn", `mode développement : réservé aux admins${players ? ` · ${players}` : ""}`);
  else if (full) setCheck("chk-server", "warn", `complet · ${players}${srv.queue ? ` · ${srv.queue} en file d'attente` : ""}`);
  else setCheck("chk-server", "ok", players ? `en ligne · ${players}` : `en ligne (${st.settings.serverIp})`);
  setCheck("chk-discord", st.profile ? "ok" : "warn", st.profile ? st.profile.discordUsername : "non connecté");
  updateMainButton();
  return st;
}

/** Le bouton principal change selon ce qui manque : installer, se connecter, jouer. */
function updateMainButton() {
  const b = $("btn-main");
  b.onclick = null;
  if (!st || working) {
    b.disabled = true;
    return;
  }
  const skyOk = !st.skyrim.error && (st.skyrim.versionOk || st.gameVersionOk);
  if (st.running) {
    b.textContent = "Jeu lancé";
    b.disabled = true;
  } else if (!st.gameVersionOk || st.missingBytes) {
    b.textContent = "Installer";
    b.disabled = !skyOk || !st.online;
    b.onclick = runInstall;
  } else if (!st.profile) {
    b.textContent = "Connexion Discord";
    b.disabled = !st.online;
    b.onclick = runLogin;
  } else {
    b.textContent = "Jouer";
    b.disabled = !ready || !st.online;
    b.onclick = runPlay;
  }
}

function showProgress(title, done, total, detail) {
  $("progress").hidden = false;
  $("progress-title").textContent = title;
  $("progress-fill").style.width = (total ? Math.min(100, (done / total) * 100) : 0).toFixed(1) + "%";
  $("progress-detail").textContent = detail || "";
}

api.onProgress((p) => {
  if (p.phase === "copy") {
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    showProgress(
      `Copie des fichiers de Skyrim depuis Steam : ${pct} %`,
      p.done, p.total,
      p.file ? `${p.file} - ${fmtBytes(p.done)} / ${fmtBytes(p.total)}. Ton Skyrim normal n'est pas modifié.` : "",
    );
    $("btn-main").textContent = `${pct} %`;
  } else if (p.phase === "update") {
    if (p.checking) {
      showProgress("Recherche des mises à jour FusPvP...", 0, 0, "Comparaison de tes fichiers avec ceux du serveur.");
      return;
    }
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 100;
    showProgress(
      p.count ? `Téléchargement des fichiers FusPvP : ${pct} %` : "Fichiers FusPvP à jour",
      p.done, p.total,
      p.file ? `[${p.index}/${p.count}] ${p.file} - ${fmtBytes(p.done)} / ${fmtBytes(p.total)}` : "",
    );
    if (p.count) $("btn-main").textContent = `${pct} %`;
  } else if (p.phase === "self") {
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    showProgress(`Mise à jour du launcher (version ${p.version || "?"}) : ${pct} %`, p.done, p.total,
      "Le launcher redémarrera tout seul.");
  } else if (p.phase === "queue") {
    showProgress(
      `File d'attente : ${p.position}${p.position === 1 ? "re" : "e"} place sur ${p.size}`,
      0, 0,
      "Serveur complet (100 joueurs, 50 par faction). Les officiers puis les sergents passent en priorité. Garde le launcher ouvert : le jeu se lancera tout seul dès qu'une place se libère.",
    );
    const b = $("btn-main");
    b.textContent = "Quitter la file";
    b.disabled = false;
    b.onclick = () => {
      b.disabled = true;
      api.cancelQueue();
    };
  } else if (p.phase === "launch") {
    showProgress("Lancement de Skyrim...", 1, 1, "Le launcher se fermera une fois le jeu démarré.");
  } else if (p.phase === "done") {
    $("progress").hidden = true;
  } else if (p.phase === "error") {
    $("progress").hidden = true;
  }
});

async function runInstall(auto) {
  working = true;
  updateMainButton();
  setMessage(auto === true ? "" : "Installation de FusPvP. Les fichiers de Skyrim sont copiés dans un dossier à part : ton Skyrim normal reste jouable.");
  const r = await api.install();
  working = false;
  if (r.ok) {
    ready = true;
    setCheck("chk-game", "ok", r.result.updated ? `à jour (${r.result.updated} fichier(s) mis à jour)` : "à jour");
    setMessage("");
  } else {
    setCheck("chk-game", "err", "erreur");
    setMessage("Installation impossible : " + r.error, true);
  }
  await refresh();
}

async function runLogin() {
  working = true;
  updateMainButton();
  setMessage("Connexion Discord ouverte dans ton navigateur. Autorise FusPvP puis reviens ici.");
  const r = await api.login();
  working = false;
  setMessage(r.ok ? `Connecté en tant que ${r.result.discordUsername}.` : "Connexion impossible : " + r.error, !r.ok);
  await refresh();
}

async function runPlay() {
  working = true;
  updateMainButton();
  setMessage("");
  const r = await api.play();
  if (!r.ok) {
    working = false;
    setMessage("Lancement impossible : " + r.error, true);
    await refresh();
  }
}

// ---------------------------------------------------------------------------
// Paramètres

let draft = null; // réglages en cours de modification
let micTest = null; // { stream, ctx, raf } pendant l'affichage du niveau du micro

async function listDevices() {
  // Les noms des périphériques ne sont visibles qu'avec l'accès au micro.
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (e) {
    // pas de micro : listes réduites à "par défaut"
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current) => {
    sel.innerHTML = "";
    sel.add(new Option("Périphérique par défaut de Windows", ""));
    for (const d of devices) {
      if (d.kind !== kind || d.deviceId === "default" || d.deviceId === "communications") continue;
      sel.add(new Option(d.label || "Périphérique", d.label));
    }
    if (current && ![...sel.options].some((o) => o.value === current)) sel.add(new Option(current + " (absent)", current));
    sel.value = current || "";
  };
  fill($("set-input"), "audioinput", draft.voice.input);
  fill($("set-output"), "audiooutput", draft.voice.output);
}

/** Niveau du micro choisi, pour vérifier qu'il capte (barre verte). */
async function startMicTest() {
  stopMicTest();
  const devices = await navigator.mediaDevices.enumerateDevices();
  const dev = devices.find((d) => d.kind === "audioinput" && d.label === draft.voice.input);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: dev ? { deviceId: { exact: dev.deviceId } } : true });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    micTest = { stream, ctx, raf: 0 };
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      peak *= draft.voice.micVolume / 100;
      $("mic-level").style.width = Math.min(100, peak * 140).toFixed(0) + "%";
      micTest.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    $("mic-level").style.width = "0";
  }
}

function stopMicTest() {
  if (!micTest) return;
  cancelAnimationFrame(micTest.raf);
  micTest.stream.getTracks().forEach((t) => t.stop());
  micTest.ctx.close();
  micTest = null;
  $("mic-level").style.width = "0";
}

const COMMON_RESOLUTIONS = [
  [1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1080], [2560, 1440], [3440, 1440], [3840, 2160],
];

function fillResolutions() {
  const sel = $("set-resolution");
  sel.innerHTML = "";
  const list = COMMON_RESOLUTIONS.filter(([w, h]) => w <= st.screen.width && h <= st.screen.height);
  if (!list.some(([w, h]) => w === st.screen.width && h === st.screen.height)) list.push([st.screen.width, st.screen.height]);
  const d = draft.display;
  if (d && d.width && !list.some(([w, h]) => w === d.width && h === d.height)) list.push([d.width, d.height]);
  list.sort((a, b) => a[0] * a[1] - b[0] * b[1]);
  for (const [w, h] of list) {
    const native = w === st.screen.width && h === st.screen.height;
    sel.add(new Option(`${w} x ${h}${native ? " (écran)" : ""}`, `${w}x${h}`));
  }
}

function renderKeys() {
  const names = draft.keyNames || {};
  $("key-talk").textContent = keyName(draft.keys.talk, names);
  $("key-range").textContent = keyName(draft.keys.range, names);
}

function renderDisplay() {
  const managed = !!draft.display;
  $("set-display-managed").checked = managed;
  $("display-fields").classList.toggle("disabled", !managed);
  const d = draft.display || {
    ...(st.currentDisplay || {}),
    width: (st.currentDisplay && st.currentDisplay.width) || st.screen.width,
    height: (st.currentDisplay && st.currentDisplay.height) || st.screen.height,
    mode: (st.currentDisplay && st.currentDisplay.mode) || "sansBordure",
    preset: "",
  };
  $("set-resolution").value = `${d.width}x${d.height}`;
  $("set-mode").value = d.mode || "sansBordure";
  $("set-preset").value = d.preset || "";
}

function readDisplayFields() {
  const [w, h] = $("set-resolution").value.split("x").map(Number);
  return { width: w, height: h, mode: $("set-mode").value, preset: $("set-preset").value };
}

async function openSettings() {
  st = await api.status();
  draft = JSON.parse(JSON.stringify(st.settings));
  showView("settings");
  $("set-mic").value = draft.voice.micVolume;
  $("set-voice").value = draft.voice.voiceVolume;
  $("out-mic").textContent = draft.voice.micVolume + " %";
  $("out-voice").textContent = draft.voice.voiceVolume + " %";
  $("set-server").value = draft.serverIp;
  $("account").textContent = st.profile ? `Connecté en tant que ${st.profile.discordUsername}` : "Non connecté";
  $("btn-logout").disabled = !st.profile;
  fillResolutions();
  renderDisplay();
  renderKeys();
  await listDevices();
  startMicTest();
}

function closeSettings() {
  stopMicTest();
  stopListening();
  showView("home");
  refresh();
}

// Attribution d'une touche : clic sur le bouton puis appui sur la touche voulue.
let listening = null;
function startListening(which) {
  stopListening();
  listening = which;
  const b = $(which === "talk" ? "key-talk" : "key-range");
  b.classList.add("listening");
  b.textContent = "Appuie sur une touche...";
}
function stopListening() {
  if (!listening) return;
  $("key-talk").classList.remove("listening");
  $("key-range").classList.remove("listening");
  listening = null;
  renderKeys();
}
window.addEventListener("keydown", (e) => {
  if (!listening) return;
  e.preventDefault();
  if (e.code === "Escape") return stopListening();
  const dx = DX_BY_CODE[e.code];
  if (!dx || RESERVED.has(e.code)) {
    $(listening === "talk" ? "key-talk" : "key-range").textContent = "Touche non disponible";
    return;
  }
  const other = listening === "talk" ? "range" : "talk";
  if (draft.keys[other] === dx) draft.keys[other] = draft.keys[listening]; // échange
  draft.keys[listening] = dx;
  draft.keyNames = { ...(draft.keyNames || {}) };
  draft.keyNames[dx] = SPECIAL_NAMES[e.code] || (e.key.length === 1 ? e.key.toUpperCase() : e.code);
  stopListening();
});

// ---------------------------------------------------------------------------
// Événements

$("btn-min").onclick = () => api.minimize();
document.querySelectorAll("#topmenu [data-link]").forEach((b) => (b.onclick = () => api.openLink(b.dataset.link)));
$("btn-close").onclick = () => api.quit();
$("btn-settings").onclick = openSettings;
$("btn-folder").onclick = () => api.openFolder();
$("btn-back").onclick = closeSettings;
$("key-talk").onclick = () => startListening("talk");
$("key-range").onclick = () => startListening("range");
$("set-input").onchange = () => {
  draft.voice.input = $("set-input").value;
  startMicTest();
};
$("set-output").onchange = () => (draft.voice.output = $("set-output").value);
$("set-mic").oninput = () => {
  draft.voice.micVolume = Number($("set-mic").value);
  $("out-mic").textContent = draft.voice.micVolume + " %";
};
$("set-voice").oninput = () => {
  draft.voice.voiceVolume = Number($("set-voice").value);
  $("out-voice").textContent = draft.voice.voiceVolume + " %";
};
$("set-display-managed").onchange = () => {
  draft.display = $("set-display-managed").checked ? readDisplayFields() : null;
  $("display-fields").classList.toggle("disabled", !draft.display);
};
for (const id of ["set-resolution", "set-mode", "set-preset"]) {
  $(id).onchange = () => {
    if (draft.display) draft.display = readDisplayFields();
  };
}
$("btn-logout").onclick = async () => {
  await api.logout();
  $("account").textContent = "Non connecté";
  $("btn-logout").disabled = true;
};
$("btn-save").onclick = async () => {
  draft.serverIp = $("set-server").value.trim() || draft.serverIp;
  if (draft.display) draft.display = readDisplayFields();
  await api.saveSettings(draft);
  closeSettings();
};

// Démarrage : état, puis vérification automatique des mises à jour si le jeu
// FusPvP est déjà installé (le bouton Jouer s'active ensuite).
(async () => {
  api.version().then((v) => ($("version").textContent = "v" + v));
  const up = await api.selfUpdate();
  if (up.ok && up.result === "restarting") {
    showProgress("Redémarrage du launcher...", 1, 1, "");
    return;
  }
  if (!up.ok) setMessage("Mise à jour du launcher impossible : " + up.error, true);
  await refresh();
  if (st.gameVersionOk && !st.missingBytes && st.online && !st.running) await runInstall(true);
})();

// Nombre de joueurs en ligne (X / 100) tenu à jour tant que rien n'est en cours.
setInterval(() => {
  if (!working) refresh().catch(() => {});
}, 15000);
