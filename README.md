# Launcher FusPvP

Launcher officiel de [FusPvP](https://fuspvp.org), serveur Skyrim PvP gratuit sans whitelist (Empire contre Sombrages), basé sur [SkyMP](https://github.com/skyrim-multiplayer/skymp).

Il installe une copie de Skyrim Special Edition 1.6.1170 **à côté** de ta copie Steam (qui n’est pas modifiée), en la téléchargeant via Steam si besoin, la tient à jour, gère la connexion Discord et la file d'attente, puis lance le jeu.

## Ce que fait le launcher

- **Skyrim 1.6.1170** : FusPvP exige cette version précise. Si le Skyrim Steam du joueur est dans cette version, ses fichiers d'origine sont copiés dans le dossier FusPvP. Sinon (Steam en 1.7.x, ou Skyrim pas installé), le launcher demande à Steam les dépôts de la 1.6.1170 (`steam.exe -console +download_depot 489830 <dépôt> <manifeste>`, dépôts 489831 à 489833, plus 489834 pour le français), suit leur téléchargement dans le journal de la console Steam, puis déplace les fichiers dans le dossier FusPvP. Il faut posséder Skyrim Special Edition sur le compte Steam connecté ; le Skyrim Steam n'est jamais modifié.
- **Installation / mise à jour** : télécharge depuis `https://game.fuspvp.org` les fichiers FusPvP (client SkyMP, plugin `FusPvP.esp`…) listés dans un manifeste d'empreintes SHA-256, et vérifie chaque fichier.
- **Mise à jour du launcher lui-même** depuis le même serveur.
- **Connexion** : authentification Discord via `https://account.fuspvp.org` (le launcher ne voit jamais ton mot de passe Discord), vérification des rôles de faction, file d'attente quand le serveur est plein.
- **Réglages** : écrit la configuration du client SkyMP dans le dossier du jeu installé, et active `FusPvP.esp` dans `Plugins.txt` (fichier partagé avec le Skyrim normal : le launcher le remet en état pour FusPvP au lancement).
- **Liens** : Discord, YouTube et TikTok de FusPvP, ouverts dans le navigateur.

Données échangées et conservation : voir la [politique de confidentialité](https://fuspvp.org/confidentialite/).

## Développement

```sh
npm ci
npm start        # lance le launcher (Electron)
npm test         # tests
npm run dist     # exécutable portable Windows dans dist/
```

Les builds officiels sont produits par GitHub Actions à partir de ce dépôt (`.github/workflows/build.yml`).

## Ce dépôt ne contient pas

Le serveur de jeu, le gamemode FusPvP et les services en ligne ne font pas partie de ce dépôt. Le client et le serveur SkyMP modifiés sont publiés dans [FusPVP/fuspvp](https://github.com/FusPVP/fuspvp/tree/fuspvp/main).

## Licence

Code : [GNU GPL v3.0 ou ultérieure](LICENSE).

- Police Montserrat : SIL Open Font License 1.1 (`renderer/fonts/OFL.txt`).
- Le nom « FusPvP », le logo et l'icône ne sont pas couverts par la licence du code : ils ne peuvent pas être utilisés pour présenter un autre projet comme étant FusPvP.
- Skyrim est une marque de Bethesda Softworks / ZeniMax Media. Ce projet n'est ni affilié ni approuvé par eux ; une copie légale de Skyrim Special Edition est nécessaire pour jouer.
