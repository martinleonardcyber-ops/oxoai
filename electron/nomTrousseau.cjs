/**
 * macOS : la clé du trousseau au nom de « OxoAI ».
 *
 * Pourquoi (27/09/2026) : Electron nomme la clé qui chiffre le coffre et les
 * Chats du poste d'après le nom interne de l'application, celui du
 * package.json (« oxoai-plateforme »). Le trousseau demandait donc l'accès à
 * « oxoai-plateforme Safe Storage », un nom que la personne ne reconnaît pas
 * (vu sur un MacBook). `app.setName` avant le démarrage change ce nom (essai du
 * 27/09/2026 : la clé « <nom> Safe Storage » est créée sous le nouveau nom),
 * mais c'est une **autre clé** : ce qui était chiffré avec l'ancienne ne se lit
 * plus avec la nouvelle (même essai).
 *
 * D'où un transfert, une seule fois, en deux lancements :
 *  1. sous l'ancien nom, les fichiers chiffrés sont lus avec l'ancienne clé, et
 *     confiés au lancement suivant dans un fichier chiffré par une clé tirée au
 *     hasard, qui ne passe que par l'environnement du processus relancé (jamais
 *     sur le disque) ;
 *  2. sous le nouveau nom, chacun est rechiffré avec la nouvelle clé. L'original
 *     est gardé à côté (`.cle-oxoai-plateforme`), toujours lisible par
 *     l'ancienne clé, qui reste dans le trousseau.
 * Un fichier que l'ancienne clé ne lit pas n'est pas touché. Si le transfert
 * échoue deux fois, l'application garde l'ancien nom : un nom peu parlant vaut
 * mieux que des Chats illisibles (règle du projet, pertes du 20/09 et du 24/09).
 *
 * Seulement l'application installée, sur macOS : sous Windows la clé ne dépend
 * pas du nom (DPAPI, rangée dans le profil), sous Linux personne ne voit ce
 * nom, et en développement l'exécutable d'Electron créerait une clé « OxoAI »
 * que l'application installée devrait ensuite demander.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ESSAIS_MAX = 2;

/**
 * Le dossier des données du poste, le fichier témoin, le fichier de transfert.
 * `dossier` : `OXOAI_DATA_DIR`, ou `~/.oxoai` (comme coffre.cjs et grandStockage.cjs).
 */
function emplacements(dossier) {
  const poste = path.join(dossier, "poste");
  return {
    poste,
    temoin: path.join(poste, ".nom-trousseau"),
    transfert: path.join(poste, ".transfert-cle"),
    essais: path.join(poste, ".transfert-cle-essais"),
  };
}

/** Les fichiers chiffrés par la clé du trousseau : le coffre, les Chats du poste et leurs copies. */
function fichiersChiffres(dossier) {
  const { poste } = emplacements(dossier);
  const liste = [];
  const ajouter = (base) => {
    let noms = [];
    try {
      noms = fs.readdirSync(base);
    } catch {
      return;
    }
    for (const nom of noms) {
      if (nom.startsWith(".") || nom.endsWith(".cle-oxoai-plateforme") || nom.endsWith(".tmp")) continue;
      // `x.enc`, `x.<date>.copie.enc`, `x.enc.illisible-<date>` : ce que coffre.cjs et grandStockage.cjs écrivent.
      if (!/\.enc($|\.illisible-)/.test(nom)) continue;
      const chemin = path.join(base, nom);
      try {
        if (fs.statSync(chemin).isFile()) liste.push(chemin);
      } catch {
        /* disparu entre-temps */
      }
    }
  };
  ajouter(dossier);
  ajouter(poste);
  // Le dossier des données contient `poste` : on ne garde de sa racine que le coffre.
  return liste.filter((c) => path.dirname(c) === poste || path.basename(c).startsWith("secrets.enc"));
}

const lireTexte = (f) => {
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return "";
  }
};

function ecrireAtomique(chemin, contenu) {
  const provisoire = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(provisoire, contenu, { mode: 0o600 });
  fs.chmodSync(provisoire, 0o600);
  fs.renameSync(provisoire, chemin);
}

let cleTransfert = null;

/**
 * Avant tout le reste (le nom compte dès la première lecture du trousseau, et
 * le dossier du profil dès le verrou d'instance unique). Rend l'étape à faire
 * une fois l'application prête : `lire`, `reprendre`, ou null.
 */
function preparerNom(app, { nomHistorique, nom, dossier }) {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  // Le profil (préférences, stockage local) reste où il était : il suit sinon le nom.
  if (!process.env.OXOAI_PROFIL_ESSAI) app.setPath("userData", path.join(app.getPath("appData"), nomHistorique));
  cleTransfert = process.env.OXOAI_CLE_TRANSFERT || null;
  // La passerelle et les outils lancés ensuite n'ont pas à la recevoir.
  delete process.env.OXOAI_CLE_TRANSFERT;

  const e = emplacements(dossier);
  const temoin = lireTexte(e.temoin);
  if (temoin === "ancien") return null;
  if (temoin === nom) {
    app.setName(nom);
    return null;
  }
  if (cleTransfert && fs.existsSync(e.transfert)) {
    app.setName(nom);
    return "reprendre";
  }
  /*
   * Un fichier de transfert sans sa clé (arrêt entre les deux lancements, ou
   * second lancement pendant le relancement) n'est pas effacé ici : ce code
   * passe avant le verrou d'instance unique, et l'effacer aurait privé le
   * vrai relancement de son transfert (revue du 27/09/2026). « lire » le
   * remplace de toute façon.
   */
  if (fichiersChiffres(dossier).length === 0) {
    // Rien à transférer (installation neuve) : le nouveau nom tout de suite.
    try {
      fs.mkdirSync(e.poste, { recursive: true, mode: 0o700 });
      ecrireAtomique(e.temoin, nom);
    } catch {
      return null;
    }
    app.setName(nom);
    return null;
  }
  if (Number(lireTexte(e.essais)) >= ESSAIS_MAX) {
    try {
      ecrireAtomique(e.temoin, "ancien");
    } catch {
      /* on réessaiera au prochain lancement */
    }
    console.error("[oxoai] transfert de la clé du trousseau abandonné : l'ancien nom est gardé, les données restent lisibles.");
    return null;
  }
  return "lire";
}

/**
 * Une fois l'application prête, avant toute lecture du coffre ou des Chats.
 * Rend true quand l'application se relance (l'appelant s'arrête là).
 */
function transfererCle(app, safeStorage, etape, { dossier }) {
  const e = emplacements(dossier);
  if (etape === "lire") {
    // Trousseau verrouillé ou refusé : rien n'est touché, on réessaiera.
    if (!safeStorage.isEncryptionAvailable()) return false;
    const contenus = {};
    for (const chemin of fichiersChiffres(dossier)) {
      try {
        contenus[chemin] = safeStorage.decryptString(fs.readFileSync(chemin));
      } catch {
        /* déjà illisible avec cette clé : laissé tel quel */
      }
    }
    try {
      fs.writeFileSync(e.essais, String(Number(lireTexte(e.essais)) + 1), { mode: 0o600 });
    } catch {
      return false;
    }
    /*
     * Rien de lu alors qu'il y a des fichiers : le plus souvent, « Refuser » à
     * la demande du trousseau. Passer au nouveau nom rendrait tout illisible :
     * on garde l'ancien pour cette fois (après deux essais, pour de bon).
     */
    if (Object.keys(contenus).length === 0) return false;
    try {
      const cle = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const chiffreur = crypto.createCipheriv("aes-256-gcm", cle, iv);
      const corps = Buffer.concat([chiffreur.update(JSON.stringify(contenus), "utf8"), chiffreur.final()]);
      ecrireAtomique(e.transfert, Buffer.concat([iv, chiffreur.getAuthTag(), corps]));
      process.env.OXOAI_CLE_TRANSFERT = cle.toString("hex");
    } catch (err) {
      console.error("[oxoai] transfert de la clé du trousseau impossible :", err instanceof Error ? err.message : err);
      return false;
    }
    console.log(`[oxoai] clé du trousseau : ${Object.keys(contenus).length} fichier(s) à rechiffrer, relancement.`);
    app.relaunch();
    app.exit(0);
    return true;
  }

  if (etape === "reprendre") {
    let contenus;
    try {
      const brut = fs.readFileSync(e.transfert);
      const dechiffreur = crypto.createDecipheriv("aes-256-gcm", Buffer.from(cleTransfert, "hex"), brut.subarray(0, 12));
      dechiffreur.setAuthTag(brut.subarray(12, 28));
      contenus = JSON.parse(Buffer.concat([dechiffreur.update(brut.subarray(28)), dechiffreur.final()]).toString("utf8"));
    } catch {
      contenus = null;
    }
    cleTransfert = null;
    if (!contenus || !safeStorage.isEncryptionAvailable()) {
      // Sous le nouveau nom, les originaux ne se lisent pas : on relance sous l'ancien plutôt que d'ouvrir des Chats vides.
      fs.rmSync(e.transfert, { force: true });
      app.relaunch();
      app.exit(0);
      return true;
    }
    let echecs = 0;
    for (const [chemin, texte] of Object.entries(contenus)) {
      if (typeof texte !== "string" || (path.dirname(chemin) !== e.poste && path.dirname(chemin) !== dossier)) continue;
      try {
        const nouveau = safeStorage.encryptString(texte);
        const garde = `${chemin}.cle-oxoai-plateforme`;
        if (!fs.existsSync(garde)) {
          fs.copyFileSync(chemin, garde);
          fs.chmodSync(garde, 0o600);
        }
        ecrireAtomique(chemin, nouveau);
      } catch (err) {
        echecs++;
        console.error("[oxoai] rechiffrement impossible :", path.basename(chemin), err instanceof Error ? err.message : err);
      }
    }
    fs.rmSync(e.transfert, { force: true });
    /*
     * Un fichier resté sous l'ancienne clé : pas de témoin, le prochain
     * lancement repart sous l'ancien nom et ne transfère que lui (ceux déjà
     * rechiffrés ne se lisent plus avec l'ancienne clé, et sont laissés tels
     * quels). Avant, le témoin était écrit quand même, et ce fichier restait
     * illisible (revue du 27/09/2026).
     */
    if (echecs > 0) {
      /*
       * Compteur remis à zéro : une partie des fichiers est déjà sous la
       * nouvelle clé, garder l'ancien nom « pour de bon » après deux essais
       * les rendrait illisibles (relu le 27/09/2026).
       */
      try {
        fs.writeFileSync(e.essais, "0", { mode: 0o600 });
      } catch {
        /* au pire, le compteur continue */
      }
      return false;
    }
    fs.rmSync(e.essais, { force: true });
    try {
      ecrireAtomique(e.temoin, app.getName());
    } catch {
      /* le prochain lancement reprendra sous l'ancien nom, et les copies gardées se relisent */
    }
    console.log(`[oxoai] clé du trousseau : ${Object.keys(contenus).length} fichier(s) rechiffré(s) sous le nom ${app.getName()}.`);
  }
  return false;
}

module.exports = { preparerNom, transfererCle };
