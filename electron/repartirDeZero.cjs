/**
 * « Repartir de zéro sur cet ordinateur » (demandé par Medhi le 23/10/2026).
 *
 * Pour un particulier seul sur son ordinateur qui ne s'en sort vraiment pas
 * (mot de passe oublié, pas de code de récupération) : désinstaller puis
 * réinstaller retrouvait le même compte, parce que les données restent dans
 * `~/.helix` et dans le profil de l'application. Cette porte, derrière la
 * même reconnaissance par l'ordinateur que « Mot de passe oublié ? »
 * (motDePasseOublie.cjs) et un mot à taper :
 *
 *  - **ne supprime rien**. Elle **déplace** deux dossiers à côté d'eux, sous
 *    un nom daté que l'écran donne avant de confirmer :
 *    `~/.helix` devient `~/.helix-ancien-AAAA-MM-JJ-hhmm`, et le profil de
 *    l'application (Chats gardés sur le poste, préférences, coffre) devient
 *    `<profil>-ancien-AAAA-MM-JJ-hhmm` ;
 *  - puis relance l'application, qui démarre comme au premier lancement.
 *
 * Le déplacement se fait **au lancement suivant, avant tout le reste**
 * (`appliquerAvantNom`, `appliquerApresNom`, appelés tout en haut de
 * main.cjs) : à ce moment, ni la passerelle, ni Chromium, ni le coffre n'ont
 * ouvert un fichier de ces dossiers. Demander le départ ne fait qu'écrire un
 * témoin à côté de `~/.helix` (`~/.helix-repartir.json`), puis quitter
 * proprement (la passerelle arrête ce qu'elle a lancé).
 *
 * Les clés : rien n'est effacé ni remplacé. Sous Windows et Linux, la clé des
 * données est un fichier du dossier de données : elle part avec lui. Sous
 * macOS, elle est dans le trousseau, que ni ce module ni la passerelle
 * n'écrasent (secret.ts n'écrit une clé que si aucune n'existe) : l'ancien
 * dossier reste lisible s'il est remis à sa place. Le coffre de l'application
 * (`safeStorage`) suit la même règle.
 *
 * Jamais touchés : les modèles et l'application LM Studio (`~/.lmstudio`),
 * OpenClaw de la personne (`~/.openclaw`), ses documents. Aucun réseau.
 *
 * Un dossier qui refuse de bouger (Windows : un programme le tient ouvert) :
 * on réessaie quelques secondes, puis on remet en place ce qui a déjà bougé
 * et l'application démarre comme avant, en le disant. Jamais à moitié.
 */

const fs = require("node:fs");


const deux = (n) => String(n).padStart(2, "0");

/** `AAAA-MM-JJ-hhmm`, à l'heure locale : le nom que la personne lira. */
function horodatage(d = new Date()) {
  return `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}`;
}

/** Un nom libre : `-2`, `-3`… si le même existe déjà (deux départs dans la même minute). */
function libre(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 100; i++) if (!fs.existsSync(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

const temoinDe = (donnees) => `${donnees}-repartir.json`;

function lireJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function ecrireJson(f, v) {
  const temp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(temp, f);
}

/** Attente bloquante courte : ce code tourne avant que l'application ne démarre. */
function patienter(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Renomme, en réessayant une dizaine de secondes (Windows : fichier encore tenu). */
function deplacer(de, vers) {
  let derniere = null;
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(de, vers);
      return null;
    } catch (err) {
      derniere = err;
      if (!["EPERM", "EBUSY", "EACCES"].includes(err?.code)) break;
      patienter(500);
    }
  }
  return derniere?.code || String(derniere?.message ?? derniere);
}

/** Ce qui sera déplacé, et où : pour l'écran, avant de confirmer. */
function apercu({ donnees, profil, maintenant = new Date() }) {
  const h = horodatage(maintenant);
  const dossiers = [];
  if (fs.existsSync(donnees)) dossiers.push({ de: donnees, vers: libre(`${donnees}-ancien-${h}`) });
  if (profil && fs.existsSync(profil)) dossiers.push({ de: profil, vers: libre(`${profil}-ancien-${h}`) });
  return dossiers;
}

/** Écrit la demande ; le départ se fera au lancement suivant. */
function demander({ donnees, profil }) {
  const dossiers = apercu({ donnees, profil });
  ecrireJson(temoinDe(donnees), { etat: "demande", demandeLe: new Date().toISOString(), dossiers });
  return dossiers;
}

/**
 * Au lancement : une étape `donnees` (avant nomTrousseau, qui lit `~/.helix`)
 * puis une étape `profil` (après, quand le chemin du profil est fixé). Rend
 * l'état du témoin, ou null.
 */
function appliquer(donnees, etape, profil) {
  const temoin = temoinDe(donnees);
  const t = lireJson(temoin);
  if (!t || (t.etat !== "demande" && t.etat !== "donnees-deplacees")) return null;
  const dossiers = Array.isArray(t.dossiers) ? t.dossiers : [];

  if (etape === "donnees" && t.etat === "demande") {
    const d = dossiers.find((x) => x.de === donnees);
    if (d && fs.existsSync(d.de)) {
      const erreur = deplacer(d.de, d.vers);
      if (erreur) {
        ecrireJson(temoin, { ...t, etat: "echec", erreur, le: new Date().toISOString() });
        return "echec";
      }
    }
    ecrireJson(temoin, { ...t, etat: "donnees-deplacees" });
    return "donnees-deplacees";
  }

  if (etape === "profil" && t.etat === "donnees-deplacees") {
    // Le profil prévu, ou celui que l'application utilise maintenant s'il diffère (nom changé entre-temps).
    const prevu = dossiers.find((x) => x.de !== donnees);
    const de = profil ?? prevu?.de;
    if (de && fs.existsSync(de)) {
      const vers = prevu && prevu.de === de ? prevu.vers : libre(`${de}-ancien-${horodatage()}`);
      const erreur = deplacer(de, vers);
      if (erreur) {
        // Jamais à moitié : `~/.helix` revient à sa place, rien n'a changé.
        const d = dossiers.find((x) => x.de === donnees);
        if (d && fs.existsSync(d.vers) && !fs.existsSync(d.de)) deplacer(d.vers, d.de);
        ecrireJson(temoin, { ...t, etat: "echec", erreur, le: new Date().toISOString() });
        return "echec";
      }
      if (prevu) prevu.vers = vers;
    }
    ecrireJson(temoin, { ...t, dossiers: dossiers.filter((x) => fs.existsSync(x.vers)), etat: "fait", le: new Date().toISOString() });
    return "fait";
  }
  return t.etat;
}

/** Ce que l'écran dit après coup : où sont les anciennes données, ou pourquoi rien n'a bougé. */
function bilan(donnees) {
  const t = lireJson(temoinDe(donnees));
  if (!t || (t.etat !== "fait" && t.etat !== "echec")) return null;
  return { etat: t.etat, dossiers: (t.dossiers ?? []).map((x) => x.vers), ...(t.erreur ? { erreur: String(t.erreur) } : {}) };
}

function oublierBilan(donnees) {
  try {
    fs.rmSync(temoinDe(donnees), { force: true });
  } catch {
    /* déjà parti */
  }
}

module.exports = { apercu, demander, appliquer, bilan, oublierBilan, horodatage, temoinDe };
