/**
 * Grand stockage du poste : les collections trop grosses pour le stockage
 * local du navigateur.
 *
 * Les Chats vivaient dans `localStorage`, limité par Chromium à quelques Mo
 * par origine ; une écriture qui dépassait était ignorée sans erreur, et un
 * import ChatGPT ou Claude s'y heurtait vite. Ici, un fichier par collection,
 * chiffré comme le coffre (`safeStorage`, clé du trousseau du compte), en 0600,
 * écrit de façon atomique (fichier temporaire puis renommage).
 *
 * Seules les clés listées passent par ici. Sans chiffrement disponible, on le
 * dit à l'interface, qui garde son stockage habituel.
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


const CLES = new Set(["sessions"]);
/** Copies gardées quand une collection rétrécit brutalement (voir `poser`). */
const COPIES_MAX = 3;

const dossier = () => path.join(process.env.OXOAI_DATA_DIR ?? path.join(os.homedir(), ".oxoai"), "poste");
const chemin = (cle) => path.join(dossier(), `${cle}.enc`);

// Pas le chiffrement de Chromium à clé connue de tous (Linux sans trousseau) : voir chiffrementPoste.cjs.
const disponible = () => chiffrementSur();

/*
 * Clés dont le fichier existe mais n'a pas pu être lu au démarrage (trousseau
 * refusé ou verrouillé, clé du trousseau changée, fichier abîmé). Ce cas était
 * confondu avec « pas encore écrite » : l'interface partait d'une liste vide,
 * et la première écriture (un Chat neuf) remplaçait le fichier illisible, donc
 * les Chats, sans copie, puis les effaçait de l'instance.
 */
const illisibles = new Set();
/** Clés dont le fichier illisible a déjà été mis de côté pendant cette séance (voir `garderSiReduction`). */
const copieIllisibleFaite = new Set();
/**
 * Pour le bandeau de l'interface (AvisChatsIllisibles) : pourquoi le fichier
 * n'a pas été lu, et où sa copie a été gardée. `chiffrement` : le système ne
 * sait pas déchiffrer en ce moment (trousseau refusé ou verrouillé) ;
 * `dechiffrement` : il sait, mais pas ce fichier (clé du trousseau changée,
 * fichier abîmé) ; `lecture` : le fichier lui-même ne s'ouvre pas (droits).
 */
const details = new Map();

/**
 * Met le fichier illisible de côté dès sa lecture, sans attendre la première
 * écriture : le bandeau peut ainsi dire où il est, et rien ne dépend plus de
 * ce que fera la suite. Une fois par séance, hors de la rotation des copies.
 */
function mettreDeCote(cle, brut) {
  if (copieIllisibleFaite.has(cle)) return details.get(cle)?.copie ?? null;
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  const cible = path.join(dossier(), `${cle}.${date}.illisible.enc`);
  try {
    fs.writeFileSync(cible, brut, { mode: 0o600 });
    copieIllisibleFaite.add(cle);
    return cible;
  } catch {
    return null;
  }
}

function noterIllisible(cle, raison, brut) {
  illisibles.add(cle);
  const copie = brut ? mettreDeCote(cle, brut) : null;
  details.set(cle, { raison, fichier: chemin(cle), copie, relue: false });
}

/** Toutes les valeurs rangées, déchiffrées. Illisible : absente (l'instance la rendra), et notée. */
function lire() {
  const valeurs = {};
  const chiffrement = disponible();
  for (const cle of CLES) {
    let brut;
    try {
      brut = fs.readFileSync(chemin(cle));
    } catch (err) {
      if (err && err.code !== "ENOENT") noterIllisible(cle, "lecture", null);
      continue;
    }
    if (!chiffrement) {
      noterIllisible(cle, "chiffrement", brut);
      continue;
    }
    try {
      valeurs[cle] = safeStorage.decryptString(brut);
      /*
       * Lisible, mais peut-être parce que cette séance l'a réécrit après
       * l'avoir trouvé illisible (fenêtre rechargée) : il ne contient alors que
       * ce que ce poste a fait depuis. Tant que l'instance n'a pas rendu la
       * collection (`relu`), elle reste tenue pour illisible, et l'interface
       * ne la pousse pas.
       */
      const incident = details.get(cle);
      if (!incident || incident.relue) illisibles.delete(cle);
    } catch {
      noterIllisible(cle, "dechiffrement", brut);
    }
  }
  return valeurs;
}

/** Les clés présentes sur le disque mais illisibles à la dernière lecture. */
const clesIllisibles = () => [...illisibles];

/**
 * Les fichiers trouvés illisibles pendant cette séance de l'application : pourquoi, le
 * fichier, sa copie gardée (null si elle n'a pas pu être faite), et si
 * l'instance a rendu la collection depuis.
 */
const incidents = () =>
  Object.fromEntries(
    [...new Set([...illisibles, ...details.keys()])].map((cle) => [
      cle,
      { raison: "lecture", fichier: chemin(cle), copie: null, relue: false, ...(details.get(cle) ?? {}) },
    ]),
  );

/** L'interface a relu la collection depuis l'instance (sync.ts) : ce poste en a de nouveau une copie sûre. */
function relu(cle) {
  if (!CLES.has(cle)) return;
  illisibles.delete(cle);
  const incident = details.get(cle);
  if (incident) incident.relue = true;
}

function poser(cle, valeur) {
  if (!CLES.has(cle) || !disponible()) return false;
  fs.mkdirSync(dossier(), { recursive: true, mode: 0o700 });
  /*
   * Fichier illisible dont aucune copie n'a pu être faite (il ne s'ouvrait
   * même pas, ou le disque a refusé la copie) : on ne le remplace pas.
   * L'interface repasse au stockage du navigateur (grandStockage.ts) ; le
   * fichier reste tel quel, pour l'administrateur.
   */
  if ((illisibles.has(cle) || details.has(cle)) && !copieIllisibleFaite.has(cle)) {
    let brut;
    try {
      brut = fs.readFileSync(chemin(cle));
    } catch (err) {
      if (!err || err.code !== "ENOENT") return false;
    }
    if (brut) {
      const copie = mettreDeCote(cle, brut);
      if (!copie) return false;
      details.set(cle, { ...(details.get(cle) ?? { raison: "lecture", fichier: chemin(cle), relue: false }), copie });
    }
  }
  if (valeur === null) {
    // Effacer une liste pleine, ou illisible, en garde d'abord une copie.
    garderSiReduction(cle, "");
    fs.rmSync(chemin(cle), { force: true });
    return true;
  }
  const texte = String(valeur);
  garderSiReduction(cle, texte);
  const tmp = `${chemin(cle)}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(texte), { mode: 0o600 });
  renommer(tmp, chemin(cle));
  return true;
}

/**
 * Une liste de Chats qui fond d'un coup (moins de la moitié de la précédente,
 * ou vide) peut être une suppression voulue, ou une perte. Le 24/09/2026, au
 * passage à ce stockage, une liste pleine a été remplacée par « [] » sur le
 * poste du client, dans un démarrage perturbé (application reconstruite
 * pendant qu'elle tournait) ; seul le journal du navigateur gardait l'ancienne.
 * On garde donc l'ancienne version à côté, chiffrée pareil, trois au plus.
 */
function garderSiReduction(cle, texte) {
  let ancien;
  try {
    ancien = fs.readFileSync(chemin(cle));
  } catch {
    return;
  }
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  let avant;
  try {
    avant = safeStorage.decryptString(ancien);
  } catch {
    /*
     * Illisible aujourd'hui ne veut pas dire perdu : le trousseau peut
     * revenir. On ne l'écrase jamais sans en garder une copie, hors de la
     * rotation des trois copies (elle ne doit pas en chasser une lisible).
     * Une fois par séance : ensuite, le fichier est celui que cette séance a
     * écrit, et un déchiffrement durablement en panne ferait une copie à
     * chaque message.
     */
    if (copieIllisibleFaite.has(cle)) return;
    copieIllisibleFaite.add(cle);
    fs.writeFileSync(path.join(dossier(), `${cle}.${date}.illisible.enc`), ancien, { mode: 0o600 });
    return;
  }
  if (avant.length < 200 || texte.length * 2 >= avant.length) return;
  fs.writeFileSync(path.join(dossier(), `${cle}.${date}.copie.enc`), ancien, { mode: 0o600 });
  const copies = fs
    .readdirSync(dossier())
    .filter((f) => f.startsWith(`${cle}.`) && f.endsWith(".copie.enc"))
    .sort();
  for (const f of copies.slice(0, Math.max(0, copies.length - COPIES_MAX))) fs.rmSync(path.join(dossier(), f), { force: true });
}

module.exports = { CLES, disponible, lire, poser, clesIllisibles, incidents, relu };
