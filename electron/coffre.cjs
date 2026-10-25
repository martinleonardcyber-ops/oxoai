/**
 * Coffre des secrets du poste.
 *
 * Le jeton de séance et le jeton d'instance vivaient dans le stockage local du
 * rendu, en clair. Ce n'est pas une faille réseau : c'est le risque « poste
 * volé, ou sauvegarde exfiltrée ». Sur macOS, `safeStorage` chiffre avec une
 * clé du trousseau du compte, protégée par le système : le fichier recopié
 * ailleurs ne s'ouvre plus.
 *
 * Ce module ne connaît pas le sens de ce qu'il garde. Il range des chaînes par
 * nom, dans un seul fichier chiffré, en 0600. Rien n'est conservé en clair.
 *
 * Si le système ne sait pas chiffrer (trousseau verrouillé, plateforme sans
 * équivalent), on le dit à l'interface, qui retombe sur son stockage habituel.
 * Mieux vaut un repli annoncé qu'un fichier « chiffré » qui ne l'est pas.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeStorage } = require("electron");
const { chiffrementSur } = require("./chiffrementPoste.cjs");

/** Renomme, en réessayant sous Windows quand un antivirus tient le fichier un instant (EPERM, EBUSY). */
function renommer(de, vers) {
  const attente = new Int32Array(new SharedArrayBuffer(4));
  for (let essai = 0; ; essai++) {
    try {
      fs.renameSync(de, vers);
      return;
    } catch (err) {
      if (process.platform !== "win32" || essai >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(err && err.code)) throw err;
      Atomics.wait(attente, 0, 0, 50 * Math.min(essai + 1, 10));
    }
  }
}


function fichier() {
  return path.join(process.env.OXOAI_DATA_DIR ?? path.join(os.homedir(), ".oxoai"), "secrets.enc");
}

/** Le système sait-il chiffrer pour ce compte ? */
// Pas le chiffrement de Chromium à clé connue de tous (Linux sans trousseau) : voir chiffrementPoste.cjs.
const disponible = () => chiffrementSur();

/**
 * Le coffre tel qu'il est : `illisible` quand le fichier existe mais ne se
 * déchiffre pas (autre compte, autre identité d'application, trousseau qui
 * refuse). À distinguer d'un coffre absent : écrire par-dessus un coffre
 * illisible effaçait la séance et l'adresse de l'instance (revue du
 * 26/09/2026, règle du projet : ne jamais écrire du vide sur ce qu'on n'a pas
 * pu lire).
 */
function lireEtat() {
  if (!disponible()) return { valeurs: {}, illisible: false };
  let brut;
  try {
    brut = fs.readFileSync(fichier());
  } catch {
    return { valeurs: {}, illisible: false };
  }
  try {
    const valeurs = JSON.parse(safeStorage.decryptString(brut));
    return { valeurs: valeurs && typeof valeurs === "object" && !Array.isArray(valeurs) ? valeurs : {}, illisible: false };
  } catch {
    return { valeurs: {}, illisible: true };
  }
}

function lire() {
  return lireEtat().valeurs;
}

function ecrire(valeurs) {
  if (!disponible()) return false;
  try {
    const chemin = fichier();
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    // Écrit à côté puis renommé : une coupure en pleine écriture ne laisse pas un coffre à moitié écrit.
    const provisoire = `${chemin}.${process.pid}.tmp`;
    fs.writeFileSync(provisoire, safeStorage.encryptString(JSON.stringify(valeurs)), { mode: 0o600 });
    fs.chmodSync(provisoire, 0o600);
    renommer(provisoire, chemin);
    return true;
  } catch (err) {
    console.error("[oxoai] coffre non écrit :", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Range une valeur, ou l'efface (`valeur` nulle). */
function poser(cle, valeur) {
  if (typeof cle !== "string" || !cle) return false;
  const { valeurs, illisible } = lireEtat();
  if (illisible) {
    /*
     * On ne sait pas le relire, mais un autre lancement le pourra peut-être
     * (l'application empaquetée, quand c'est le développement qui écrit) : il
     * est mis de côté, jamais écrasé.
     */
    try {
      fs.renameSync(fichier(), `${fichier()}.illisible-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    } catch {
      return false;
    }
  }
  if (valeur === null || valeur === undefined) delete valeurs[cle];
  else if (typeof valeur === "string") valeurs[cle] = valeur;
  else return false;
  return ecrire(valeurs);
}

/** Vide le coffre : déconnexion complète, ou effacement des données du poste. */
function vider() {
  try {
    fs.rmSync(fichier(), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { disponible, lire, poser, vider };
