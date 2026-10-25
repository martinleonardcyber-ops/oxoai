/**
 * Les publications GitHub du dépôt, source des mises à jour d'un poste installé
 * seul (ni serveur de l'agence inscrit dans le paquet, ni instance à laquelle
 * il est rattaché).
 *
 * Décidé par Medhi le 27/09/2026 : « les autres PC » (qui téléchargent OxoAI
 * depuis GitHub) doivent voir la fenêtre « Nouvelle version », et le dépôt
 * devient public. Ce qui revient sur la décision du 26/09 (« aucun GitHub »)
 * pour ces postes seulement ; les postes rattachés suivent toujours leur
 * instance.
 *
 * Pourquoi ce n'est pas un risque de plus : l'archive d'une mise à jour macOS
 * n'est installée qu'après vérification de la signature de l'éditeur, avec la
 * clé de l'application déjà installée (signatureEditeur.cjs) ; une publication
 * remplacée par un tiers ne passerait pas. Sous Windows (27/09/2026), de même
 * pour l'installateur : le manifeste en porte la signature de l'éditeur,
 * vérifiée avec la clé de l'application installée (`lireManifesteWindows`).
 * Sous Linux, rien ne s'installe : la fenêtre propose le paquet, que la
 * personne installe.
 *
 * Ce module ne fait aucun appel réseau : il lit ce que l'API de GitHub rend, et
 * se vérifie sans Electron (scripts/essai-source-github.mjs).
 */

/** « 0.27.1 » est-elle plus récente que « 0.27.0 » ? Numéros seulement ; une préversion (« -beta ») n'est jamais proposée. */
function plusRecente(proposee, installee) {
  const lire = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
    return m ? m.slice(1).map(Number) : null;
  };
  const a = lire(proposee);
  const b = lire(installee);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Le paquet qui convient à ce poste, parmi les fichiers de la publication :
 * macOS l'image disque (lien de secours), Windows l'installateur, Linux
 * l'AppImage si c'est ainsi que OxoAI tourne, sinon le paquet Debian.
 */
function choisirPaquet(fichiers, { plateforme, arch, appImage }) {
  const noms = (fichiers ?? []).filter((f) => f && typeof f.name === "string" && typeof f.browser_download_url === "string");
  const trouver = (motif) => noms.find((f) => motif.test(f.name)) ?? null;
  if (plateforme === "darwin") return trouver(arch === "arm64" ? /-arm64\.dmg$/i : /-x64\.dmg$/i);
  if (plateforme === "win32") return trouver(arch === "arm64" ? /Setup-.*-arm64\.exe$/i : /Setup-.*-x64\.exe$/i);
  if (plateforme === "linux") {
    if (appImage) return trouver(arch === "arm64" ? /-arm64\.AppImage$/i : /\d\.AppImage$/i);
    return trouver(arch === "arm64" ? /_arm64\.deb$/i : /_amd64\.deb$/i);
  }
  return null;
}

/*
 * Taille maximale du manifeste (test d'intrusion du 27/09/2026). Il est lu en
 * entier en mémoire par le processus principal (`text()`, puis `JSON.parse`) :
 * une publication remplacée par un fichier de plusieurs gigaoctets sous ce nom
 * faisait tomber l'application à chaque vérification, toutes les six heures.
 * Le vrai pèse quelques centaines d'octets (533 pour 2026.927.4).
 */
const TAILLE_MANIFESTE_MAX = 64 * 1024;

/**
 * Le manifeste parmi les fichiers de la publication, seulement s'il a une
 * taille de manifeste (celle que donne GitHub, `size`) et une adresse https ;
 * sinon null, et l'écran garde « Télécharger ».
 */
function manifesteDe(fichiers) {
  const f = (fichiers ?? []).find((x) => x && x.name === "oxoai-mise-a-jour.json");
  if (!f || !Number.isInteger(f.size) || f.size <= 0 || f.size > TAILLE_MANIFESTE_MAX) return null;
  return typeof f.browser_download_url === "string" && /^https:\/\//i.test(f.browser_download_url) ? f : null;
}

/** Le texte du manifeste en objet, ou null (illisible, ou plus gros qu'un manifeste). */
function analyser(brut) {
  if (typeof brut !== "string") return brut;
  if (brut.length > TAILLE_MANIFESTE_MAX) return null;
  try {
    return JSON.parse(brut);
  } catch {
    return null;
  }
}

/**
 * Le manifeste de la mise à jour macOS (`oxoai-mise-a-jour.json`, écrit à la
 * publication par scripts/manifeste-mise-a-jour.mjs), vérifié champ par champ :
 * version, archive .zip, empreinte SHA-512 (base64), taille.
 *
 * Deux parties depuis le 28/09/2026 : `mac` pour les puces Apple, `macIntel`
 * pour les Mac Intel (première version publiée pour eux, avec le moteur
 * llama.cpp). Un Mac ne lit que la sienne : l'archive de l'autre processeur ne
 * démarrerait pas (Intel) ou passerait par Rosetta (puce Apple).
 */
function lireManifeste(brut, versionAttendue, arch = "arm64") {
  const m = analyser(brut);
  const mac = m && (arch === "x64" ? m.macIntel : m.mac);
  if (!m || m.version !== versionAttendue || !mac) return null;
  if (typeof mac.fichier !== "string" || !/^[\w.-]+\.zip$/.test(mac.fichier)) return null;
  if (typeof mac.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(mac.sha512)) return null;
  if (!Number.isInteger(mac.octets) || mac.octets <= 0) return null;
  // La forme qu'attend installerSansSignature (celle d'electron-updater).
  return { version: m.version, files: [{ url: mac.fichier, sha512: mac.sha512, size: mac.octets }] };
}

/**
 * La partie Windows du manifeste (27/09/2026) : l'installateur NSIS, son
 * empreinte SHA-512 (base64), sa taille, et la signature de l'éditeur sur le
 * tout, vérifiée ici avec la clé de l'application installée
 * (`clePubliquePem`, jamais une clé venue de la publication). Champ par champ
 * comme pour macOS ; rien de bon, rien de rendu : l'écran garde alors
 * « Télécharger ».
 */
function lireManifesteWindows(brut, versionAttendue, clePubliquePem, identifiant) {
  const m = analyser(brut);
  const win = m && m.windows;
  if (!m || m.version !== versionAttendue || !win || !clePubliquePem || typeof identifiant !== "string") return null;
  // Le seul installateur que ce poste sait lancer : celui des processeurs x64.
  if (typeof win.fichier !== "string" || !/^[\w.-]+-x64\.exe$/.test(win.fichier)) return null;
  if (typeof win.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(win.sha512)) return null;
  if (!Number.isInteger(win.octets) || win.octets <= 0) return null;
  const description = { identifiant, version: m.version, fichier: win.fichier, sha512: win.sha512, octets: win.octets };
  const verdict = require("./signatureEditeur.cjs").verifierInstallateur(clePubliquePem, win.signature, description);
  if (!verdict.ok) return null;
  return { ...description, signature: win.signature };
}

/**
 * Les processeurs d'un exécutable macOS (Mach-O), lus dans ses premiers
 * octets : `arm64`, `x64` (noms de `process.arch`). Vide si ce n'en est pas un.
 *
 * Pourquoi (relecture du 28/09/2026) : la première application pour Mac Intel
 * part avec la 2026.928.6. Un Mac Intel rattaché à une instance tournant sur
 * un Mac à puce Apple recevait d'elle l'archive de sa propre application, donc
 * pour puce Apple : identifiant, version et signature de l'éditeur bons, elle
 * s'installait, l'ancienne était effacée, et la nouvelle ne démarrait pas. Le
 * processeur est désormais vérifié avant de rien remplacer (miseAJour.cjs).
 */
function processeursMachO(octets) {
  const nom = (type) => (type === 0x0100000c ? "arm64" : type === 0x01000007 ? "x64" : null);
  const trouves = new Set();
  if (!octets || octets.length < 8) return trouves;
  const magique = octets.readUInt32BE(0);
  if (magique === 0xcffaedfe || magique === 0xcefaedfe) {
    // Un seul processeur (MH_MAGIC_64 ou MH_MAGIC, écrits en petit-boutiste).
    const n = nom(octets.readUInt32LE(4));
    if (n) trouves.add(n);
  } else if (magique === 0xcafebabe || magique === 0xcafebabf) {
    // Binaire universel : l'en-tête est en gros-boutiste, une entrée par processeur (20 octets, 32 en 64 bits).
    const taille = magique === 0xcafebabf ? 32 : 20;
    const nombre = Math.min(octets.readUInt32BE(4), 16);
    for (let i = 0; i < nombre && 8 + (i + 1) * taille <= octets.length; i++) {
      const n = nom(octets.readUInt32BE(8 + i * taille));
      if (n) trouves.add(n);
    }
  }
  return trouves;
}

/** Le dépôt `propriétaire/nom`, s'il a la bonne forme. */
function depotValide(depot) {
  return typeof depot === "string" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(depot) ? depot : null;
}

module.exports = { plusRecente, choisirPaquet, manifesteDe, lireManifeste, lireManifesteWindows, processeursMachO, depotValide, TAILLE_MANIFESTE_MAX };
