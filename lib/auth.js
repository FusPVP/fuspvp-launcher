// auth.js - Connexion Discord du joueur via le master FusPvP, et session de jeu.
// Même logique que l'ancien script FusPvP-connexion-discord.ps1 :
//  - le navigateur ouvre la connexion Discord du master ;
//  - le launcher interroge le master jusqu'à la fin de la connexion ;
//  - le jeton est gardé dans %LOCALAPPDATA%\FusPvP\auth.json (jamais affiché) ;
//  - avant chaque partie, une "play session" est créée et écrite dans
//    Data\Platform\PluginsNoLoad\auth-data-no-load.js, lu par le client FusPvP.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE = path.join(process.env.LOCALAPPDATA || "", "FusPvP", "auth.json");
// Ancien nom du projet (FusRP) : connexion Discord reprise une fois.
const OLD_STORE = path.join(process.env.LOCALAPPDATA || "", "FusRP", "auth.json");
try {
  if (!fs.existsSync(STORE) && fs.existsSync(OLD_STORE)) {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.copyFileSync(OLD_STORE, STORE);
  }
} catch (e) {
  // pas grave : il suffira de se reconnecter
}

/** Profil Discord enregistré (sans le jeton), ou null. */
function savedProfile() {
  const auth = readAuth();
  return auth ? { discordUsername: auth.discordUsername, masterApiId: auth.masterApiId } : null;
}

function readAuth() {
  try {
    const raw = fs.readFileSync(STORE, "utf8").replace(/^﻿/, "");
    const auth = JSON.parse(raw);
    return auth && auth.token ? auth : null;
  } catch (e) {
    return null;
  }
}

function logout() {
  fs.rmSync(STORE, { force: true });
}

/**
 * Connexion Discord : openUrl(url) ouvre le navigateur ; attend 3 min max.
 * @returns {Promise<{discordUsername, masterApiId}>}
 */
async function login(master, openUrl, isCancelled) {
  const state = crypto.randomBytes(16).toString("hex");
  openUrl(`${master}/api/users/login-discord?state=${state}`);
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error("connexion annulée");
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${master}/api/users/login-discord/status?state=${state}`);
      if (res.ok) {
        const auth = await res.json();
        if (auth && auth.token) {
          fs.mkdirSync(path.dirname(STORE), { recursive: true });
          fs.writeFileSync(STORE, JSON.stringify(auth, null, 2));
          return { discordUsername: auth.discordUsername, masterApiId: auth.masterApiId };
        }
      }
    } catch (e) {
      // master pas encore prêt : on réessaie
    }
  }
  throw new Error("connexion Discord non terminée (3 min écoulées)");
}

/**
 * Demande une session de jeu au master. Réponses :
 *  - { auth, play } : place accordée ;
 *  - { queued: true, position, size } : serveur complet, en file d'attente
 *    (redemander toutes les quelques secondes pour garder sa place) ;
 *  - erreur : connexion Discord expirée, mode développement (423, admins
 *    seulement), rôles Discord manquants (422).
 */
async function requestPlaySession(master, serverKey) {
  const auth = readAuth();
  if (!auth) throw new Error("connecte-toi d'abord avec Discord");
  const res = await fetch(`${master}/api/users/me/play/${encodeURIComponent(serverKey)}`, {
    method: "POST",
    headers: { authorization: auth.token, "content-type": "application/json" },
    body: "{}",
  });
  if (res.status === 423) {
    // Mode développement : la connexion Discord reste valable, on ne déconnecte pas.
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "le serveur est en mode développement : accès réservé aux admins");
  }
  if (res.status === 401 || res.status === 403) {
    logout();
    throw new Error("connexion Discord expirée : reconnecte-toi");
  }
  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "rôles Discord manquants");
  }
  if (res.status === 202) {
    const body = await res.json().catch(() => ({}));
    return { queued: true, position: body.position || 0, size: body.size || 0 };
  }
  if (!res.ok) throw new Error(`le master a refusé la session (HTTP ${res.status})`);
  return { auth, play: await res.json() };
}

/** Quitte la file d'attente (sinon la place expire seule en 20 s). */
async function leaveQueue(master, serverKey) {
  const auth = readAuth();
  if (!auth) return;
  await fetch(`${master}/api/users/me/play/${encodeURIComponent(serverKey)}`, {
    method: "DELETE",
    headers: { authorization: auth.token },
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

/** Écrit pour le client FusPvP la session accordée par requestPlaySession. */
function writePlaySession({ auth, play }, gameDir) {
  const data = {
    session: play.session,
    masterApiId: auth.masterApiId,
    discordUsername: auth.discordUsername,
    discordDiscriminator: auth.discordDiscriminator,
    discordAvatar: auth.discordAvatar,
  };
  const dir = path.join(gameDir, "Data", "Platform", "PluginsNoLoad");
  fs.mkdirSync(dir, { recursive: true });
  // Format attendu par le client SkyMP : "//" + JSON, UTF-8 sans BOM.
  fs.writeFileSync(path.join(dir, "auth-data-no-load.js"), "//" + JSON.stringify(data));
}

module.exports = { savedProfile, login, logout, requestPlaySession, leaveQueue, writePlaySession };
