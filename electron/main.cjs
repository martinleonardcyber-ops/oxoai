const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell, systemPreferences } = require("electron");

/*
 * Lancée depuis le terminal de VS Code, qui définit ELECTRON_RUN_AS_NODE=1,
 * l'application démarrait en mode Node et se fermait aussitôt (signalé le
 * 28/09/2026). Le fusible RunAsNode est fermé : Electron ignore désormais la
 * variable. On la retire quand même de l'environnement, pour qu'elle ne passe
 * pas à tout ce que Helix lance (un éditeur construit sur Electron, ouvert
 * depuis Helix, démarrerait sinon en mode Node).
 */
delete process.env.ELECTRON_RUN_AS_NODE;
const { demarrerMiseAJour, changerLangue: changerLangueMaj, releverLancement } = require("./miseAJour.cjs");
const coffre = require("./coffre.cjs");
const grandStockage = require("./grandStockage.cjs");
const ligneDeCommande = require("./ligneDeCommande.cjs");
const { demarrerRendu } = require("./rendu.cjs");
const { installerBotReunion, arreterTousLesBots, botsActifs } = require("./botReunion.cjs");
const { installerZoneNotification } = require("./zoneNotification.cjs");
const { preparerNom, transfererCle } = require("./nomTrousseau.cjs");
const { installerPressePapiers } = require("./pressePapiers.cjs");
const { installerMotDePasseOublie } = require("./motDePasseOublie.cjs");
const repartirDeZero = require("./repartirDeZero.cjs");

/*
 * Profil d'essai : un paquet de test lancé sur la machine d'un intégrateur ne
 * doit ni lire ni écrire le profil de l'application réellement utilisée
 * (séance, préférences). Sans la variable, rien ne change.
 */
if (process.env.HELIX_PROFIL_ESSAI) app.setPath("userData", process.env.HELIX_PROFIL_ESSAI);
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const moteurWindows = require("./moteurWindows.cjs");
const { pathToFileURL } = require("node:url");
const { lancerPasserelle, envoyerALaPasserelle, arreterPasserelle } = require("./passerelle.cjs");

/**
 * Processus principal Helix.
 *
 * L'application embarque son propre moteur : au démarrage elle lance la
 * passerelle modèles, attend qu'elle réponde, puis ouvre la fenêtre. À la
 * fermeture, tout est arrêté proprement — l'utilisateur n'a jamais deux
 * terminaux à gérer.
 */

const GATEWAY_PORT = Number(process.env.HELIX_GATEWAY_PORT ?? 8787);
const DEV_URL = process.env.HELIX_DEV_URL ?? "http://localhost:5173";
const isDev = !app.isPackaged;

/**
 * Schéma propre de l'interface livrée.
 *
 * L'application se chargeait depuis le disque, en `file://`. Trois défauts
 * venaient de là :
 *
 *  - **toutes** les pages `file:` partagent la même origine, dont la chaîne
 *    vaut « null » : le stockage local de Helix — jetons compris avant 0.22.0 —
 *    était atteignable par n'importe quelle page HTML du poste ;
 *  - `webRequest` n'intercepte pas `file:`, donc l'en-tête de politique de
 *    sécurité ne s'appliquait à rien dans l'application livrée ;
 *  - une origine « null » n'est pas un contexte sécurisé, ce qui ferme des
 *    interfaces du navigateur sans raison.
 *
 * `helix://app/…` est une vraie origine, déclarée sûre, servie depuis le même
 * dossier `dist`. La politique de sécurité est posée par la réponse elle-même,
 * et peut donc être **calculée** : quand l'instance est connue, elle nomme son
 * adresse au lieu d'ouvrir tout le HTTPS.
 */
const SCHEMA = "helix";
const ORIGINE_APP = `${SCHEMA}://app`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEMA,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/**
 * Une seule application à la fois, et pourquoi.
 *
 * Ce n'est pas du confort : un lien `helix://rejoindre` cliqué sous Windows ou
 * Linux arrive en argument d'un **second** lancement, et c'est le verrou qui
 * le renvoie à l'application déjà ouverte. Sans lui, le lien ouvrirait une
 * deuxième copie, avec une deuxième passerelle sur le même port et les mêmes
 * données.
 *
 * `HELIX_INSTANCES_MULTIPLES=1` lève le verrou : c'est ainsi qu'on fait
 * tourner deux postes sur une même machine pour éprouver le rattachement.
 */
/*
 * macOS : la clé du trousseau au nom de « Helix », avec le transfert des
 * données chiffrées sous l'ancien nom (nomTrousseau.cjs). Avant le verrou
 * d'instance unique : il dépend du dossier du profil, que ceci fixe.
 */
const DONNEES_POSTE = process.env.HELIX_DATA_DIR ?? path.join(os.homedir(), ".helix");
/*
 * « Repartir de zéro sur cet ordinateur », demandé au lancement précédent
 * (electron/repartirDeZero.cjs) : `~/.helix` est mis de côté ici, avant que
 * quoi que ce soit ne l'ouvre (nomTrousseau le lit juste après), et le profil
 * de l'application juste après, quand son chemin est fixé. Rien n'est effacé.
 */
try {
  repartirDeZero.appliquer(DONNEES_POSTE, "donnees");
} catch (err) {
  console.error("[helix] repartir de zéro :", err?.message ?? err);
}
const etapeTrousseau = preparerNom(app, {
  nomHistorique: "helix-plateforme",
  nom: (() => {
    try {
      return require("../package.json").nomAffiche || "Helix";
    } catch {
      return "Helix";
    }
  })(),
  dossier: DONNEES_POSTE,
});

try {
  repartirDeZero.appliquer(DONNEES_POSTE, "profil", app.getPath("userData"));
} catch (err) {
  console.error("[helix] repartir de zéro :", err?.message ?? err);
}

const instanceUnique =
  isDev || process.env.HELIX_INSTANCES_MULTIPLES === "1" || app.requestSingleInstanceLock();
if (!instanceUnique) app.quit();

let gateway = null;
let mainWindow = null;
/** Windows et Linux : l'icône de la zone de notification (zoneNotification.cjs), null sur macOS ou si elle n'a pas pu être posée. */
let zone = null;
/** La fenêtre principale a-t-elle été ouverte au moins une fois ? (voir `window-all-closed`) */
let fenetrePrincipaleOuverte = false;
/** « Quitter » a été demandé : fermer la fenêtre ne doit plus seulement la cacher. */
let quitterVraiment = false;
/** Langue de l'écran, que l'interface donne au démarrage : pour les quelques textes de ce processus. */
// Relue une fois l'application prête (sous Windows, `getLocale` n'est fiable qu'ensuite), puis donnée par l'interface.
let langueEcran = "en";
// Les langues de l'interface (src/lib/i18n.ts) ; l'espagnol, l'allemand et l'arabe depuis le 30/09/2026.
const LANGUES = ["fr", "en", "zh", "ja", "es", "de", "ar"];
/*
 * Le nom affiché : `app.getName()` vaut « helix-plateforme » sous Windows et
 * Linux (le nom du paquet npm ; sur macOS, celui du paquet de l'application).
 * Le nom du produit est lu dans le package.json livré (`nomAffiche`) ; le
 * nom interne reste, lui, celui du dossier du profil (revue Linux du 27/09/2026).
 */
const NOM_AFFICHE = (() => {
  try {
    const nom = require("../package.json").nomAffiche;
    if (typeof nom === "string" && nom.trim()) return nom.trim();
  } catch {
    /* paquet sans nom affiché : le nom de l'application */
  }
  return app.getName();
})();
/** Arrêt volontaire : empêche le redémarrage automatique à la fermeture. */
let arretDemande = false;
let redemarrages = 0;

/** Vérifie que la passerelle répond. */
function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Le superviseur n'abandonne jamais définitivement.
 *
 * Les causes d'échec sont presque toujours passagères : port occupé par un
 * autre processus, machine qui sort de veille, disque momentanément lent. Une
 * fenêtre ouverte sur une coquille vide et un message « il redémarre tout
 * seul » qui a cessé d'être vrai, c'est le pire des deux mondes.
 *
 * On espace donc les tentatives au lieu de s'arrêter : rapides au début pour
 * un incident bref, puis toutes les 30 secondes, indéfiniment.
 */
const ATTENTE_MAX_MS = 30_000;

/** Banc d'essai des pages de Helix Code (electron/rendu.cjs), démarré une fois, prêté à la passerelle. */
let rendu = null;
/** Le journal de la passerelle (passerelle.log, dossier des journaux de l'application). */
let journalPasserelle = null;

async function startGateway() {
  if (!rendu && app.isReady()) rendu = await demarrerRendu().catch(() => null);
  /*
   * En développement, une passerelle lancée à la main est réutilisée : c'est
   * pratique pour itérer. Dans l'application livrée, jamais — l'application
   * ferait confiance à n'importe quel programme occupant le port, et lui
   * enverrait les données de l'entreprise.
   */
  if (isDev && (await ping(GATEWAY_PORT))) {
    console.log("[helix] passerelle déjà active, réutilisée (développement).");
    return;
  }

  /*
   * La passerelle est compilée en JavaScript (dist-gateway) : le runtime Node
   * embarqué dans Electron n'exécute pas TypeScript, et surtout le poste client
   * n'a pas à disposer d'une installation de Node.
   */
  const entry = isDev
    ? path.join(__dirname, "..", "dist-gateway", "index.cjs")
    : path.join(process.resourcesPath, "dist-gateway", "index.cjs");

  /*
   * Un `utilityProcess` d'Electron depuis le 28/09/2026 (electron/passerelle.cjs,
   * pour le pourquoi) : l'application ne relance plus son binaire en mode
   * Node, et le fusible RunAsNode est fermé.
   */
  const enfant = lancerPasserelle({
    entry,
    nom: NOM_AFFICHE,
    env: {
      ...process.env,
      HELIX_GATEWAY_PORT: String(GATEWAY_PORT),
      // Marque blanche : les messages de la passerelle disent le nom du produit livré.
      HELIX_NOM_PRODUIT: NOM_AFFICHE,
      // Installation de bureau : Codex n'est proposé qu'ici, au propriétaire du poste (gateway/src/codex.ts, 27/09/2026).
      HELIX_BUREAU: "1",
      // Le banc d'essai des pages : adresse sur la boucle locale et clé, pour la passerelle seule.
      ...(rendu ? { HELIX_RENDU_URL: rendu.url, HELIX_RENDU_CLE: rendu.cle } : {}),
    },
  });
  // Erreur fatale du processus (plantage) : notée ; `exit` suit toujours, et le superviseur relance.
  enfant.on("error", (type, lieu) => console.error("[helix] passerelle :", type, lieu ?? ""));
  /*
   * macOS : l'autorisation d'enregistrer l'écran, lue sans la demander. La
   * passerelle prenait une vraie capture pour la connaître, et macOS ouvrait
   * sa demande à chaque lancement, même sans se servir du contrôle de
   * l'écran (vu le 27/09/2026). Seul ce processus sait la lire sans capture.
   */
  enfant.on("message", (m) => {
    if (!m || typeof m !== "object" || enfant.helixArretee) return;
    if (m.type === "node-prive") {
      reponsesPasserelle.get(m.id)?.(m);
      return;
    }
    // Mot de passe oublié : la passerelle dit si le nouveau est enregistré (electron/motDePasseOublie.cjs).
    if (m.type === "mot-de-passe-local") {
      motDePasseOublie.recevoir(m);
      return;
    }
    // Windows : le service de LM Studio lancé d'ici, comme avant la 2026.928.6 (electron/moteurWindows.cjs).
    if (m.type === "lancer-lms") {
      void moteurWindows.lancerLms(m).then((r) => envoyerALaPasserelle(enfant, { type: "lancer-lms", id: m.id, ...r }));
      return;
    }
    if (m.type !== "permission-ecran") return;
    let statut = "inconnu";
    try {
      if (process.platform === "darwin") statut = systemPreferences.getMediaAccessStatus("screen");
    } catch {
      /* inconnu : la passerelle fait comme avant */
    }
    envoyerALaPasserelle(enfant, { type: "permission-ecran", id: m.id, statut });
  });
  gateway = enfant;

  // Gardée aussi dans un fichier : la console de l'application ne se voit pas sur un poste (electron/moteurWindows.cjs).
  journalPasserelle ??= moteurWindows.ouvrirJournal(app.getPath("logs"));
  const noter = (b) => journalPasserelle?.write(`${new Date().toISOString()} ${b}${String(b).endsWith("\n") ? "" : "\n"}`);
  enfant.stdout?.on("data", (b) => {
    process.stdout.write(`[passerelle] ${b}`);
    noter(b);
  });
  enfant.stderr?.on("data", (b) => {
    const texte = String(b);
    process.stderr.write(`[passerelle] ${texte}`);
    noter(b);
    /*
     * Port déjà pris : le diagnostic doit être explicite. C'est le cas d'un
     * second Helix ouvert, ou d'un serveur de développement laissé en marche.
     */
    if (texte.includes("EADDRINUSE")) {
      console.error(
        `[helix] le port ${GATEWAY_PORT} est occupé par un autre programme. ` +
          "Helix réessaiera ; fermez l'autre instance pour reprendre la main.",
      );
    }
  });

  /*
   * Si le moteur s'arrête tout seul, on le relance : sans cela l'application
   * reste ouverte sur une coquille vide, et l'utilisateur n'a d'autre recours
   * que de quitter et rouvrir.
   */
  enfant.on("exit", (code) => {
    /*
     * Seul l'arrêt de la passerelle EN COURS compte (revue du 26/09/2026) :
     * au redémarrage demandé par l'écran, l'ancienne s'arrêtait après que la
     * nouvelle était lancée, effaçait sa référence et relançait une troisième
     * copie, qui échouait sur le port pris, et ainsi de suite chaque seconde ;
     * la passerelle servante n'était plus connue de personne et survivait à
     * la fermeture de l'application.
     */
    if (gateway !== enfant) return;
    gateway = null;
    if (arretDemande) return;

    console.error(`[helix] passerelle arrêtée (code ${code}).`);
    redemarrages += 1;
    const attente = Math.min(1000 * 2 ** (redemarrages - 1), ATTENTE_MAX_MS);
    console.error(`[helix] nouvelle tentative dans ${attente} ms (${redemarrages}).`);
    setTimeout(() => {
      void startGateway();
    }, attente);
  });

  for (let i = 0; i < 40; i++) {
    if (await ping(GATEWAY_PORT)) {
      // Un démarrage réussi solde les échecs précédents.
      redemarrages = 0;
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.error("[helix] la passerelle n'a pas démarré à temps.");
}

/** Réponses attendues de la passerelle, par numéro de demande. */
const reponsesPasserelle = new Map();
let numeroDemande = 0;

/**
 * Le Node de Helix, posé par la passerelle (gateway/src/installationOpenClaw.ts :
 * version épinglée, empreinte vérifiée), pour la commande `helix`. Par le
 * canal de la passerelle : ce processus n'a pas à refaire le téléchargement,
 * et aucune route HTTP n'y mène. Rend `{ ok, erreur? }`.
 */
function demanderNodePrive() {
  const enfant = gateway;
  if (!enfant || enfant.helixArretee) return Promise.resolve({ ok: false, erreur: "passerelle" });
  const id = ++numeroDemande;
  return new Promise((resolve) => {
    const repondre = (m) => {
      clearTimeout(fin);
      reponsesPasserelle.delete(id);
      enfant.removeListener("exit", surArret);
      resolve({ ok: m.ok === true, erreur: typeof m.erreur === "string" ? m.erreur : undefined });
    };
    /*
     * La passerelle qui s'arrête pendant le téléchargement (plantage, relance
     * par le superviseur) ne répondra jamais (relecture du 28/09/2026) : sans
     * cela, l'écran de la ligne de commande attendait les quinze minutes du
     * délai, bouton en « Installation... ».
     */
    const surArret = () => repondre({ ok: false, erreur: "passerelle" });
    const fin = setTimeout(() => repondre({ ok: false, erreur: "délai" }), 15 * 60_000);
    reponsesPasserelle.set(id, repondre);
    enfant.once("exit", surArret);
    if (!envoyerALaPasserelle(enfant, { type: "node-prive", id })) repondre({ ok: false, erreur: "passerelle" });
  });
}

/** Arrête la passerelle ; la promesse se résout quand elle est vraiment arrêtée (port libéré), 5 s au plus. */
function stopGateway() {
  // Arrêt voulu : le superviseur ne doit pas la relancer derrière nous.
  arretDemande = true;
  const enfant = gateway;
  gateway = null;
  return arreterPasserelle(enfant);
}

/**
 * Ce poste dépend-il de l'instance d'une autre machine ?
 *
 * Lu dans le coffre, que l'interface remplit à la mise en route
 * (electron/coffre.cjs). Sans réponse — premier lancement, coffre illisible —
 * on suppose un poste autonome : c'est le cas qui a besoin d'un moteur.
 */
function posteRattache() {
  try {
    const brut = coffre.lire()["helix:instance"];
    if (!brut) return false;
    const config = JSON.parse(brut);
    return Boolean(config && config.remote === true && typeof config.url === "string");
  } catch {
    return false;
  }
}

/** Jeton de l'instance locale, écrit par la passerelle à son premier démarrage. */
function readInstanceToken() {
  const file =
    process.env.HELIX_TOKEN_FILE ??
    path.join(os.homedir(), ".helix", "data", "instance-token");
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/*
 * Couleur peinte par la fenêtre elle-même, avant et autour du rendu web :
 * pendant le chargement, et dans la bande découverte lors d'un redimensionnement.
 * Ce sont les deux tokens `--background` convertis en hexadécimal.
 */
const FOND_FENETRE = { clair: "#F9F6EF", sombre: "#161413" };

/** Fichier où l'on retient le dernier thème réellement affiché. */
function fichierTheme() {
  return path.join(os.homedir(), ".helix", "theme");
}

/**
 * Thème à peindre au démarrage.
 *
 * L'interface garde son choix dans le stockage local du rendu, auquel le
 * processus principal n'a pas accès avant d'avoir ouvert une fenêtre — d'où ce
 * petit fichier, écrit après chaque chargement. Au tout premier lancement il
 * n'existe pas : on suit alors l'apparence du système, qui est le meilleur
 * pari disponible. Sans cela l'application s'ouvre sur un rectangle crème en
 * pleine nuit, exactement l'éclair blanc que le thème sombre évite.
 */
function themeDemarrage() {
  try {
    const retenu = fs.readFileSync(fichierTheme(), "utf8").trim();
    if (retenu === "clair" || retenu === "sombre") return retenu;
  } catch {
    /* premier lancement, ou dossier illisible : on retombe sur le système */
  }
  return nativeTheme.shouldUseDarkColors ? "sombre" : "clair";
}

/** Retient le thème affiché, pour que le prochain démarrage peigne juste. */
function retenirTheme(theme) {
  try {
    fs.mkdirSync(path.dirname(fichierTheme()), { recursive: true });
    fs.writeFileSync(fichierTheme(), theme, "utf8");
  } catch {
    /* sans persistance, le prochain démarrage suivra le système */
  }
}

/**
 * Sélecteur de dossier du système.
 *
 * C'est la personne qui choisit, dans une fenêtre que l'application ne
 * contrôle pas : rien de ce que la page envoie n'influence le résultat, et
 * aucun chemin ne peut être imposé depuis le contenu affiché. Le chemin
 * retourné est ensuite soumis à la passerelle, qui le valide à son tour.
 */
/**
 * Seule la fenêtre de l'application parle au processus principal.
 *
 * Aucune autre `webContents` ne dispose aujourd'hui de `ipcRenderer` : la
 * fenêtre du bot l'enferme dans une fermeture, celle de connexion Google n'a
 * pas de préchargement. Le contrôle est là pour que cela reste vrai le jour
 * où une fenêtre de plus partagera ce préchargement.
 */
function depuisLaFenetre(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

/*
 * Les boutons « Copier » passent par ici (electron/pressePapiers.cjs) : la
 * permission du presse-papiers reste refusée à la page, qui ne copiait donc
 * rien (vu sous Windows le 27/09/2026).
 */
installerPressePapiers({ ipcMain, clipboard, depuisLaFenetre });

/*
 * « Mot de passe oublié ? » sur l'écran de connexion (23/10/2026,
 * electron/motDePasseOublie.cjs) : seulement quand ce poste fait tourner
 * l'instance, par la passerelle qu'il a lancée lui-même. Une passerelle de
 * développement réutilisée (lancée à la main) n'a pas de canal : `gateway`
 * reste nul, la porte reste fermée.
 */
const motDePasseOublie = installerMotDePasseOublie({
  ipcMain,
  systemPreferences,
  shell,
  dossier: () => app.getPath("userData"),
  depuisLaFenetre,
  disponible: () => !posteRattache() && Boolean(gateway && !gateway.helixArretee),
  envoyer: (message) => envoyerALaPasserelle(gateway, message),
  langue: () => langueEcran,
  nom: NOM_AFFICHE,
  // Repartir de zéro : les deux dossiers mis de côté au lancement suivant, puis la relance.
  donnees: DONNEES_POSTE,
  profil: () => app.getPath("userData"),
  relancer: () => {
    quitterVraiment = true;
    app.relaunch();
    app.quit();
  },
});

/* ------------------------- invitation par lien ---------------------------- */

/**
 * Rejoindre une instance en un clic.
 *
 * Le mail d'invitation porte un lien `helix://rejoindre#a=…&c=…`. Le système
 * réveille l'application, qui remplit elle-même l'adresse et le code : le
 * collègue n'a plus rien à recopier. C'est la marche que les gens ratent, et
 * la seule façon de ne plus la rater est de l'enlever.
 *
 * Trois précautions, parce qu'un lien vient de l'extérieur :
 *
 *  1. seul l'hôte `rejoindre` est accepté — `helix://app/…` sert l'interface
 *     et n'a rien à faire ici ;
 *  2. l'adresse doit être en `http`/`https`, et rien d'autre : un lien ne
 *     choisit pas le protocole que l'application ira parler ;
 *  3. le lien ne **décide** de rien. Il pré-remplit un écran, que la personne
 *     valide. Ni jeton, ni compte, ni mot de passe ne s'en déduisent.
 *
 * Les paramètres voyagent dans le fragment (`#`) : il ne franchit pas les
 * serveurs et ne se retrouve dans aucun journal.
 */
function lireLienInvitation(lien) {
  try {
    const url = new URL(lien);
    if (url.protocol !== `${SCHEMA}:` || url.host !== "rejoindre") return null;
    const champs = new URLSearchParams(url.hash.replace(/^#/, ""));
    const adresse = (champs.get("a") ?? "").trim();
    const code = (champs.get("c") ?? "").trim();
    if (!adresse || !code) return null;
    const cible = new URL(adresse);
    if (cible.protocol !== "http:" && cible.protocol !== "https:") return null;
    return { adresse: cible.origin, code };
  } catch {
    return null;
  }
}

/** Lien reçu avant que la page soit prête à l'entendre. */
let invitationEnAttente = null;
let interfacePrete = false;

function transmettreInvitation() {
  if (!invitationEnAttente || !interfacePrete) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("helix:invitation", invitationEnAttente);
  invitationEnAttente = null;
}

/** Point d'entrée unique : un lien arrive, d'où qu'il vienne. */
function recevoirLien(lien) {
  const invitation = lireLienInvitation(lien);
  if (!invitation) return;
  invitationEnAttente = invitation;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  transmettreInvitation();
}

/** La page s'abonne : on lui remet ce qui attendait. */
ipcMain.on("helix:invitation-prete", (event) => {
  if (!depuisLaFenetre(event)) return;
  interfacePrete = true;
  transmettreInvitation();
});

/** macOS : le lien arrive par le système, l'application étant déjà lancée ou non. */
app.on("open-url", (evenement, lien) => {
  evenement.preventDefault();
  recevoirLien(lien);
});

/**
 * Windows et Linux : le lien arrive en argument d'un **second** lancement, que
 * le verrou d'instance unique renvoie à celle qui tourne déjà.
 */
app.on("second-instance", (_evenement, argv) => {
  const lien = argv.find((a) => typeof a === "string" && a.startsWith(`${SCHEMA}://`));
  if (lien) recevoirLien(lien);
  // Relancer l'application rouvre sa fenêtre, même cachée dans la zone de notification.
  else montrerFenetre();
});

ipcMain.on("helix:langue", (evenement, code) => {
  // Comme les autres canaux : la fenêtre principale seulement, pas celle d'un bot de réunion qui partage le monde de Google Meet (28/09/2026).
  if (!depuisLaFenetre(evenement)) return;
  if (!LANGUES.includes(code)) return;
  langueEcran = code;
  zone?.changerLangue(code);
  changerLangueMaj(code);
});

/*
 * Coffre : le rendu y range son jeton de séance et, pour un poste rattaché, le
 * jeton d'instance. Ils vivaient en clair dans le stockage du navigateur.
 *
 * La lecture est **synchrone**, et c'est voulu : le préchargement la fait une
 * fois, avant le premier script de la page, pour que l'interface trouve ses
 * jetons là où elle les cherche aujourd'hui, sans réécrire chaque appel. Un
 * seul aller-retour au démarrage.
 */
ipcMain.on("helix:coffre-initial", (event) => {
  if (!depuisLaFenetre(event)) {
    event.returnValue = { disponible: false, valeurs: {} };
    return;
  }
  event.returnValue = {
    disponible: coffre.disponible(),
    valeurs: coffre.lire(),
    // Préférences de l'ancienne origine, à appliquer une fois (voir reprise.cjs).
    reprise: valeursReprises,
  };
});

ipcMain.handle("helix:coffre-poser", (event, cle, valeur) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  return coffre.poser(cle, valeur);
});

/**
 * Grand stockage (electron/grandStockage.cjs) : les Chats, trop gros pour le
 * stockage local du navigateur. Même principe que le coffre : une lecture
 * synchrone au démarrage, des écritures asynchrones.
 */
ipcMain.on("helix:grand-initial", (event) => {
  if (!depuisLaFenetre(event)) {
    event.returnValue = { disponible: false, cles: [], valeurs: {} };
    return;
  }
  const valeurs = grandStockage.lire();
  event.returnValue = {
    disponible: grandStockage.disponible(),
    cles: [...grandStockage.CLES],
    valeurs,
    // Présentes sur le disque mais illisibles : l'interface ne pousse pas une liste vide à l'instance (sync.ts).
    illisibles: grandStockage.clesIllisibles(),
    // Pour le bandeau qui le dit : pourquoi, et où la copie a été gardée.
    incidents: grandStockage.incidents(),
  };
});

ipcMain.handle("helix:grand-poser", (event, cle, valeur) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  return grandStockage.poser(cle, valeur);
});

ipcMain.handle("helix:grand-relu", (event, cle) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  grandStockage.relu(String(cle));
  return true;
});

ipcMain.handle("helix:coffre-vider", (event) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  return coffre.vider();
});

/**
 * Relance la passerelle de cette machine.
 *
 * Un seul usage : l'ouverture de l'instance aux collègues. L'adresse d'écoute
 * se choisit à l'ouverture du serveur ; la changer demande donc de le
 * relancer, et c'est l'application qui en est responsable, pas la passerelle
 * elle-même. Sans effet sur un poste rattaché, qui n'en a pas.
 */
ipcMain.handle("helix:passerelle-redemarrer", async (event) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  if (posteRattache()) return { ok: false, motif: "poste rattaché" };
  // L'ancienne libère d'abord le port : sans cela la nouvelle échouait dessus.
  await stopGateway();
  // `stopGateway` a posé l'arrêt volontaire : on le lève pour le redémarrage.
  arretDemande = false;
  const vivante = await startGateway();
  return { ok: vivante !== false };
});

/** La ligne de commande `helix` dans le PATH (electron/ligneDeCommande.cjs). */
ipcMain.handle("helix:cli-etat", (event) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  return ligneDeCommande.etat();
});
ipcMain.handle("helix:cli-installer", (event) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  // Sans Node sur le poste, la passerelle pose celui de Helix (demanderNodePrive).
  return ligneDeCommande.installer({ demanderNodePrive });
});
ipcMain.handle("helix:cli-retirer", (event) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  return ligneDeCommande.retirer();
});

ipcMain.handle("helix:choisir-dossier", async (event, options) => {
  if (!depuisLaFenetre(event)) throw new Error("Refusé.");
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  /*
   * Les libellés viennent de l'écran, dans sa langue (l'emplacement des
   * modèles a les siens, 28/09/2026). Seulement du texte court : ils ne font
   * qu'étiqueter la fenêtre du système, le chemin choisi reste celui que la
   * personne désigne.
   */
  const texte = (v, defaut) => (typeof v === "string" && v.trim() && v.length <= 200 ? v : defaut);
  const o = options && typeof options === "object" ? options : {};
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: texte(o.titre, "Dossier de travail"),
    message: texte(o.message, "Choisissez le dossier sur lequel l'agent doit travailler."),
    buttonLabel: texte(o.bouton, "Travailler ici"),
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
});

/**
 * Adresse de l'instance connue du poste, s'il y en a une.
 *
 * Elle est rangée dans le coffre (electron/coffre.cjs) par l'interface. La
 * relire ici sert à **resserrer** la politique de sécurité : tant qu'aucune
 * instance n'est configurée, l'écran de mise en route doit pouvoir sonder
 * l'adresse que la personne saisit, donc tout HTTPS ; une fois l'instance
 * choisie, seule la sienne reste ouverte.
 */
function origineInstance() {
  try {
    const brut = coffre.lire()["helix:instance"];
    if (!brut) return null;
    const config = JSON.parse(brut);
    if (!config || typeof config.url !== "string") return null;
    return new URL(config.url).origin;
  } catch {
    return null;
  }
}

/** Politique de sécurité du contenu de l'interface livrée. */
function politiqueDeContenu() {
  const instance = origineInstance();
  const connexions = instance
    ? `'self' ${instance} http://localhost:* http://127.0.0.1:* blob: data:`
    : "'self' https: http://localhost:* http://127.0.0.1:* blob: data:";
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Les styles compilés sont injectés dans la page par le bundle.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    `connect-src ${connexions}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Sert l'interface sous `helix://app/…`, depuis le dossier `dist`.
 *
 * Deux règles, et elles suffisent : on ne sort jamais de `dist` (le chemin est
 * résolu puis comparé à la racine réelle), et tout chemin inconnu rend
 * `index.html` — l'application est une page unique, ses routes ne sont pas des
 * fichiers.
 */
function servirInterface() {
  const racine = fs.realpathSync(path.join(__dirname, "..", "dist"));

  protocol.handle(SCHEMA, async (requete) => {
    const adresse = new URL(requete.url);
    if (adresse.host !== "app") return new Response("Introuvable", { status: 404 });

    const demande = decodeURIComponent(adresse.pathname).replace(/^\/+/, "") || "index.html";
    let cible = path.join(racine, demande);
    try {
      cible = fs.realpathSync(cible);
      if (cible !== racine && !cible.startsWith(racine + path.sep)) throw new Error("hors racine");
      if (!fs.statSync(cible).isFile()) throw new Error("pas un fichier");
    } catch {
      // Route de l'application, ou fichier absent : la page unique répond.
      cible = path.join(racine, "index.html");
    }

    // `pathToFileURL` : sous Windows, `file://C:\…` n'est pas une adresse valide (audit du 27/09/2026).
    const reponse = await net.fetch(pathToFileURL(cible).toString());
    const entetes = new Headers(reponse.headers);
    entetes.set("X-Content-Type-Options", "nosniff");
    entetes.set("Referrer-Policy", "no-referrer");
    // Seule la page porte la politique ; l'imposer aux images et aux scripts
    // n'apporte rien et brouille le diagnostic.
    if (cible.endsWith(".html")) entetes.set("Content-Security-Policy", politiqueDeContenu());
    return new Response(reponse.body, { status: reponse.status, headers: entetes });
  });
}

/**
 * Reprise unique de l'ancien stockage « file:// ».
 *
 * L'interface change d'origine en 0.22.0 : `helix://app` au lieu du disque.
 * Une origine, c'est un stockage — le nouveau est vide. Sans cette reprise, la
 * personne retrouverait l'écran de mise en route, devrait se reconnecter, et
 * perdrait ses préférences, alors que rien de tout cela n'a disparu : c'est
 * seulement rangé sous l'ancienne adresse.
 *
 * On ouvre donc une fenêtre cachée sur une page vide du disque, le temps d'un
 * aller-retour (public/migration.html + electron/reprise.cjs), et on garde ce
 * qu'elle rend pour le transmettre à la nouvelle origine. Un fichier témoin
 * empêche de recommencer, y compris si la personne a depuis tout effacé
 * exprès : on ne ressuscite rien deux fois.
 */
let valeursReprises = {};

function temoinDeReprise() {
  return path.join(process.env.HELIX_DATA_DIR ?? path.join(os.homedir(), ".helix"), "reprise-origine");
}

async function reprendreAncienStockage() {
  const temoin = temoinDeReprise();
  if (fs.existsSync(temoin)) return;

  const page = path.join(__dirname, "..", "dist", "migration.html");
  if (!fs.existsSync(page)) return;

  const fenetre = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  /*
   * Lu par `executeJavaScript`, et non par un préchargement : sur une origine
   * `file://`, un monde isolé se voit refuser l'accès au stockage (mesuré :
   * la lecture depuis un préchargement rendait toujours un objet vide). Le
   * code ci-dessous s'exécute dans la page elle-même, qui est la nôtre et ne
   * contient rien d'autre.
   */
  const lecture = `(() => {
    const valeurs = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const cle = localStorage.key(i);
        if (!cle || cle.indexOf("helix:") !== 0) continue;
        const v = localStorage.getItem(cle);
        if (typeof v === "string" && v.length < 2000000) valeurs[cle] = v;
      }
    } catch (e) {}
    return valeurs;
  })()`;

  try {
    await fenetre.loadFile(page);
    const lues = await fenetre.webContents.executeJavaScript(lecture);
    valeursReprises = lues && typeof lues === "object" ? lues : {};
  } catch {
    valeursReprises = {};
  } finally {
    if (!fenetre.isDestroyed()) fenetre.destroy();
  }

  /*
   * Les deux valeurs sensibles rejoignent le coffre tout de suite : la
   * nouvelle origine ne doit jamais les revoir en clair, même le temps d'un
   * démarrage.
   */
  for (const cle of ["helix:session-token", "helix:instance", "helix:identity:current"]) {
    if (typeof valeursReprises[cle] === "string") {
      coffre.poser(cle, valeursReprises[cle]);
      delete valeursReprises[cle];
    }
  }

  try {
    fs.mkdirSync(path.dirname(temoin), { recursive: true });
    fs.writeFileSync(temoin, new Date().toISOString(), "utf8");
  } catch {
    /* témoin non écrit : la reprise se refera, sans dommage */
  }
  const reste = Object.keys(valeursReprises).length;
  if (reste > 0) console.log(`[helix] ${reste} préférence(s) reprises de l'ancienne origine.`);
}

function createWindow() {
  const theme = themeDemarrage();
  fenetrePrincipaleOuverte = true;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: FOND_FENETRE[theme],
    /*
     * L'icône de la fenêtre est celle de la barre des tâches sous Windows et
     * Linux : l'image de macOS, avec sa marge, y paraissait minuscule (vu sur
     * un PC le 27/09/2026). Chacun la sienne (scripts/icones).
     */
    icon: path.join(
      __dirname,
      "..",
      "build",
      process.platform === "win32" ? "icon.ico" : process.platform === "linux" ? path.join("icons", "512x512.png") : "icon.png",
    ),
    // Barre de titre native discrète : les commandes de fenêtre restent celles
    // du système, l'interface Helix occupe toute la surface.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Windows et Linux : le menu (zoneNotification.cjs) se cache ; la touche Alt l'affiche.
    autoHideMenuBar: true,
    /*
     * Les trois pastilles macOS flottent au-dessus de la barre latérale et
     * occupent 52 px. Ce calage leur laisse 12 px de marge de part et d'autre
     * du rail replié (76 px), et les place au même endroit que les captures de
     * référence quand le panneau est déplié.
     */
    trafficLightPosition: process.platform === "darwin" ? { x: 12, y: 16 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /*
       * Le préchargement n'ouvre qu'une porte : le sélecteur de dossier du
       * système. Sans lui, choisir un dossier de travail obligeait à remonter
       * l'arborescence clic par clic dans une liste maison, alors que macOS
       * sait le faire depuis toujours.
       */
      preload: path.join(__dirname, "preload.cjs"),
      // Rien de ce que l'application affiche n'a besoin d'un accès au disque
      // par une URL `file:` fabriquée, ni de sortir de son origine.
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  /*
   * Politique de sécurité du contenu, second exemplaire.
   *
   * Le premier est dans la page elle-même (balise `meta`, posée à la
   * construction par vite.config.ts), et c'est lui qui compte : l'application
   * livrée charge `index.html` depuis le disque, et les requêtes `file:` ne
   * passent pas par `webRequest`. Cet en-tête ne s'applique donc qu'à une
   * interface servie en HTTP. Les deux doivent rester d'accord.
   *
   * `connect-src` reste ouvert aux adresses d'instance en HTTPS : le poste
   * d'un collègue vise le serveur de l'entreprise, qui n'est pas connu
   * d'avance. Le HTTP distant, lui, a disparu : un poste ne se rattache plus
   * à une instance en clair (src/lib/instance.ts).
   */
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    /*
     * En développement, l'interface vient du serveur Vite, qui injecte des
     * scripts en ligne et recompile à chaud : une politique stricte la rendrait
     * inutilisable. Elle ne s'applique donc qu'à l'application livrée, la seule
     * qui parte chez un client.
     */
    const politique = isDev
      ? null
      : [
          "default-src 'self'",
          "script-src 'self'",
          // Les styles compilés sont injectés dans la page par le bundle.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "media-src 'self' blob: data:",
          // L'adresse de l'instance n'est pas connue d'avance : c'est celle du
          // serveur de l'entreprise, saisie à la mise en route.
          "connect-src 'self' https: http://localhost:* http://127.0.0.1:* blob: data:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "frame-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...(politique ? { "Content-Security-Policy": [politique] } : {}),
        "X-Content-Type-Options": ["nosniff"],
        "Referrer-Policy": ["no-referrer"],
      },
    });
  });

  /*
   * Une seule permission navigateur est accordée : le **micro**, pour la
   * dictée. Caméra, géolocalisation, notifications, presse-papiers et le reste
   * sont refusés d'office. Copier du texte ne demande donc pas la permission
   * du presse-papiers : les boutons « Copier » passent par un canal du
   * processus principal (electron/pressePapiers.cjs, 27/09/2026).
   *
   * Trois conditions, toutes nécessaires :
   *  - la demande vient de la fenêtre de l'application elle-même, pas d'un
   *    contenu qu'elle afficherait ;
   *  - elle porte sur `media`, et ne demande QUE de l'audio : une demande qui
   *    réclame aussi la vidéo est refusée en entier, pas accordée à moitié ;
   *  - la page qui la fait est celle de Helix (`file://` une fois empaqueté,
   *    la boucle locale en développement).
   *
   * Le son capté ne quitte pas le poste : il part vers la passerelle locale,
   * qui le transcrit avec Whisper sur la machine. La reconnaissance vocale du
   * navigateur, elle, n'est jamais utilisée : dans Chromium, elle envoie
   * l'audio aux serveurs de Google.
   */
  const pageDeHelix = (url) => {
    try {
      const { protocol, hostname } = new URL(url);
      /*
       * `helix://app` : l'origine de l'interface livrée depuis la 0.23.0. Elle
       * manquait ici (revue du 26/09/2026) : la dictée et l'enregistrement
       * d'une réunion au micro étaient refusés dans l'application empaquetée.
       */
      if (protocol === "helix:") return hostname === "app";
      return protocol === "file:" || hostname === "localhost" || hostname === "127.0.0.1";
    } catch {
      return false;
    }
  };

  mainWindow.webContents.session.setPermissionRequestHandler(
    (wc, permission, callback, details) => {
      const audioSeul =
        permission === "media" &&
        Array.isArray(details?.mediaTypes) &&
        details.mediaTypes.length > 0 &&
        details.mediaTypes.every((t) => t === "audio");
      const depuisHelix =
        wc === mainWindow.webContents && pageDeHelix(details?.requestingUrl ?? wc.getURL());
      callback(audioSeul && depuisHelix);
    },
  );

  // Le contrôle préalable suit la même règle : rien d'autre que l'audio.
  mainWindow.webContents.session.setPermissionCheckHandler(
    (wc, permission, origine, details) =>
      permission === "media" &&
      details?.mediaType === "audio" &&
      wc === mainWindow.webContents &&
      pageDeHelix(origine),
  );

  mainWindow.once("ready-to-show", () => mainWindow.show());

  /*
   * Relève le thème effectivement appliqué par l'interface et l'accorde à la
   * fenêtre : le fond peint pendant un redimensionnement cesse ainsi de jurer,
   * et le prochain démarrage s'ouvrira de la bonne couleur.
   *
   * On interroge le rendu au chargement puis à chaque fois que la fenêtre perd
   * le focus. Reste un cas non couvert : changer de thème puis quitter sans
   * jamais quitter la fenêtre des yeux — le démarrage suivant peindra alors
   * l'ancienne couleur, et se corrigera dès ce chargement-là.
   */
  let themeConnu = null;
  const synchroniserTheme = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const applique = await mainWindow.webContents.executeJavaScript(
        'localStorage.getItem("helix:apparence-resolue")',
        true,
      );
      if (applique !== "clair" && applique !== "sombre") return;
      if (applique === themeConnu) return;
      themeConnu = applique;
      retenirTheme(applique);
      mainWindow.setBackgroundColor(FOND_FENETRE[applique]);
    } catch {
      /* page pas encore prête ou fenêtre fermée : sans effet */
    }
  };

  mainWindow.webContents.on("did-finish-load", () => void synchroniserTheme());
  mainWindow.on("blur", () => void synchroniserTheme());

  /*
   * Les liens externes s'ouvrent dans le navigateur, jamais dans l'application.
   * Seuls http(s) sont transmis au système : d'autres schémas (file:, smb:...)
   * permettraient de déclencher des actions locales depuis un contenu affiché.
   * `mailto:` s'y ajoute le 27/09/2026 (« Signaler un problème », lien du
   * support dans l'aide) : il ouvre un brouillon dans la messagerie, que la
   * personne relit et envoie elle-même ; rien ne part sans elle.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol: schemaDuLien } = new URL(url);
      if (schemaDuLien === "http:" || schemaDuLien === "https:" || schemaDuLien === "mailto:") shell.openExternal(url);
    } catch {
      /* adresse illisible, ignorée */
    }
    return { action: "deny" };
  });

  // Empêche l'application de quitter son propre contenu si un lien est suivi.
  /*
   * Comparer les origines ne suffisait pas : sous `file:`, l'origine d'une
   * page vaut la chaîne « null », et toutes les pages du disque la partagent.
   * Une navigation vers un fichier HTML quelconque du poste passait donc, et
   * cette page héritait du préchargement et du stockage local de Helix,
   * jetons compris. On compare maintenant l'adresse elle-même : seule la page
   * en place, rechargée, est admise.
   */
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const actuelle = mainWindow.webContents.getURL();
    const memePage = (a, b) => {
      try {
        const x = new URL(a);
        const y = new URL(b);
        return x.origin === y.origin && x.pathname === y.pathname && x.protocol !== "file:";
      } catch {
        return false;
      }
    };
    if (url === actuelle) return;
    /*
     * Un lien `mailto:` suivi dans la page (celui du support, dans l'aide)
     * était annulé ici comme une navigation ailleurs, et le clic restait sans
     * effet dans l'application de bureau. On le remet à la messagerie du
     * système (27/09/2026, non essayé sur le poste à cette date).
     */
    if (/^mailto:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
      return;
    }
    // Rechargement de la même page : l'adresse porte des paramètres qui varient
    // (jeton passé au démarrage en production, rechargement à chaud en
    // développement). C'est la page elle-même, pas une navigation ailleurs.
    if (memePage(url, actuelle)) return;
    event.preventDefault();
  });

  /*
   * `desktop=1` prévient l'interface qu'elle tourne dans la fenêtre native :
   * la barre de titre étant masquée sur macOS, les commandes de fenêtre flottent
   * au-dessus du contenu et il faut leur réserver la place.
   */
  /*
   * Le jeton de l'instance locale est lu sur le disque et transmis à
   * l'interface : sur son propre poste, l'utilisateur n'a rien à saisir, alors
   * que la passerelle reste fermée à tout appel extérieur non autorisé.
   */
  /*
   * `titre=flottant` : seulement sur macOS, où la barre de titre est masquée.
   * Windows et Linux gardent la barre du système : ni place à réserver, ni
   * bande à glisser (audit du 27/09/2026).
   */
  const query = { desktop: "1", ...(process.platform === "darwin" ? { titre: "flottant" } : {}) };
  const token = readInstanceToken();
  if (token) query.token = token;

  if (isDev) {
    const params = new URLSearchParams(query).toString();
    mainWindow.loadURL(`${DEV_URL}?${params}`);
  } else {
    const params = new URLSearchParams(query).toString();
    mainWindow.loadURL(`${ORIGINE_APP}/index.html?${params}`);
  }

  /*
   * Windows et Linux : fermer cache la fenêtre, l'application continue dans
   * la zone de notification (comme le Dock sur macOS). Voir zoneNotification.cjs.
   */
  mainWindow.on("close", (evenement) => {
    if (process.platform === "darwin" || !zone || quitterVraiment) return;
    evenement.preventDefault();
    mainWindow.hide();
    zone.avertirUneFois();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Rouvre la fenêtre, où qu'elle soit : cachée, réduite, ou fermée (macOS). */
function montrerFenetre() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Encore au démarrage (passerelle en route) : la fenêtre va s'ouvrir d'elle-même, pas deux fois.
    if (!fenetrePrincipaleOuverte) return;
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Instances connues et leur certificat.
 *
 * Une instance d'entreprise chiffre son trafic avec un certificat auto-signé
 * quand l'intégrateur n'en fournit pas : aucune autorité ne le reconnaît, et le
 * poste le refuserait. On applique donc la règle de la première rencontre —
 * celle de SSH : on retient l'empreinte au premier contact, et on refuse ensuite
 * tout certificat différent. Cela n'authentifie pas la première connexion, mais
 * cela rend visible toute interposition ultérieure.
 */
function fichierInstancesConnues() {
  return path.join(os.homedir(), ".helix", "data", "instances-connues.json");
}

function lireInstancesConnues() {
  try {
    return JSON.parse(fs.readFileSync(fichierInstancesConnues(), "utf8"));
  } catch {
    return {};
  }
}

function retenirInstance(origine, empreinte) {
  const connues = lireInstancesConnues();
  connues[origine] = { empreinte, vuLe: new Date().toISOString() };
  try {
    const fichier = fichierInstancesConnues();
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    fs.writeFileSync(fichier, JSON.stringify(connues, null, 2), { mode: 0o600 });
  } catch {
    /* sans écriture, la confiance repartira de zéro au prochain lancement */
  }
}

function installerVerificationCertificats() {
  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    /*
     * La règle de la première rencontre ne vaut que pour la fenêtre de
     * l'application, qui parle à l'instance. Le bot de réunion charge Google
     * Meet : un certificat invalide y est une attaque, jamais une instance à
     * retenir. Refus par défaut.
     */
    if (!mainWindow || webContents !== mainWindow.webContents) return callback(false);
    let origine;
    try {
      origine = new URL(url).origin;
    } catch {
      return callback(false);
    }

    const connue = lireInstancesConnues()[origine];
    const empreinte = certificate?.fingerprint;
    if (!empreinte) return callback(false);

    if (!connue) {
      /*
       * Première rencontre : on demande, on ne suppose pas.
       *
       * Retenir en silence revenait à légitimer n'importe quel certificat
       * présenté au premier contact — le moment exact où quelqu'un
       * s'interposerait. La trace était un `console.log`, invisible dans une
       * application livrée. C'est la personne qui tranche, empreinte sous les
       * yeux, comme le fait ssh.
       */
      void dialog
        .showMessageBox(mainWindow, {
          type: "warning",
          title: "Certificat inconnu",
          message: `Première connexion à ${origine}`,
          detail:
            "Le certificat de cette instance n'est pas reconnu par le système. " +
            "Vérifiez son empreinte auprès de la personne qui administre l'instance :\n\n" +
            `${empreinte}\n\n` +
            "Si elle ne correspond pas, quelqu'un s'interpose entre ce poste et l'instance.",
          buttons: ["Refuser", "Faire confiance à cette instance"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(({ response }) => {
          if (response !== 1) return callback(false);
          retenirInstance(origine, empreinte);
          event.preventDefault();
          callback(true);
        })
        .catch(() => callback(false));
      return;
    }

    if (connue.empreinte === empreinte) {
      event.preventDefault();
      return callback(true);
    }

    // Le certificat a changé : refus. Soit l'instance a été réinstallée, soit
    // quelqu'un s'interpose. Dans les deux cas ce n'est pas au logiciel de
    // trancher silencieusement.
    console.error(
      `[helix] certificat différent pour ${origine} (${error}). Connexion refusée.\n` +
        `        Si l'instance a été réinstallée, supprimez ${fichierInstancesConnues()}.`,
    );
    callback(false);
  });
}

app.whenReady().then(async () => {
  if (!instanceUnique) return;
  // Avant toute lecture du coffre ou des Chats du poste ; rend true quand l'application se relance.
  if (etapeTrousseau && transfererCle(app, safeStorage, etapeTrousseau, { dossier: DONNEES_POSTE })) return;
  // Avant la fenêtre : son premier script crée le stockage local qui distingue une installation neuve d'une mise à jour (miseAJour.cjs, 23/10/2026).
  releverLancement();
  {
    const l = app.getLocale().slice(0, 2);
    if (LANGUES.includes(l) && langueEcran === "en") langueEcran = l;
    changerLangueMaj(langueEcran);
  }
  /*
   * Windows : le même identifiant que les raccourcis posés par l'installateur,
   * sans quoi les notifications ne s'affichent pas et l'icône épinglée se
   * sépare de celle de l'application ouverte (audit du 27/09/2026).
   */
  if (process.platform === "win32") app.setAppUserModelId("fr.helix.plateforme");
  /*
   * L'application se déclare auprès du système comme ouvrant les liens
   * `helix:`. Sur macOS c'est le paquet livré qui le déclare (CFBundleURLTypes,
   * voir `build.protocols` dans package.json) ; ailleurs, c'est cet appel. On
   * s'abstient en développement : l'exécutable Electron s'y enregistrerait à
   * la place de l'application installée.
   */
  if (!isDev) app.setAsDefaultProtocolClient(SCHEMA);
  /*
   * Lancement à froid par un lien : sous Windows et Linux il est déjà dans
   * `argv`. Sur macOS, il arrivera par `open-url`, qui peut se déclencher
   * avant `whenReady` — l'écouteur est posé plus haut, et le lien attend.
   */
  const lienDeDemarrage = process.argv.find(
    (a) => typeof a === "string" && a.startsWith(`${SCHEMA}://`),
  );
  if (lienDeDemarrage) recevoirLien(lienDeDemarrage);
  installerVerificationCertificats();
  // Windows et Linux : l'icône d'abord, avant les étapes qui peuvent ouvrir et fermer des fenêtres de service.
  if (process.platform !== "darwin") {
    zone = installerZoneNotification({
      nom: NOM_AFFICHE,
      icone: path.join(__dirname, "..", "build", "tray.png"),
      langue: langueEcran,
      montrer: montrerFenetre,
      quitter: () => {
        quitterVraiment = true;
        app.quit();
      },
    });
  }
  // En développement, l'interface vient du serveur Vite : rien à servir ici.
  if (!isDev) servirInterface();
  installerBotReunion(() => mainWindow);
  // Avant d'ouvrir la fenêtre : elle lit le coffre à son premier script.
  if (!isDev) await reprendreAncienStockage();
  /*
   * Un poste rattaché ne lance aucun moteur.
   *
   * C'est la promesse faite à un collègue invité : « aucun modèle à installer
   * sur cette machine ». Elle n'était pas tenue — l'application démarrait
   * quand même sa propre passerelle, qui découvrait des moteurs, ouvrait un
   * serveur d'outils et créait un second jeu de données, pour rien : l'écran,
   * lui, parle à l'instance de l'entreprise.
   *
   * Si l'instance est injoignable, l'écran le dira. C'est la bonne réponse :
   * retomber en silence sur une passerelle locale vide donnerait à la
   * personne une application qui a l'air de marcher et qui ne montre aucune
   * de ses données.
   */
  if (posteRattache()) {
    console.log("[helix] poste rattaché à une instance : aucune passerelle locale n'est lancée.");
  } else {
    await startGateway();
  }
  createWindow();
  // Un lanceur `helix` d'avant le 28/09/2026 visait ce binaire en mode Node, qui n'existe plus (ligneDeCommande.cjs).
  if (!isDev && ligneDeCommande.remplacerAncienLanceur()) console.log("[helix] lanceur de la commande helix remis à jour (Node au lieu du mode Node de l'application).");
  void demarrerMiseAJour(depuisLaFenetre);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/*
 * Sur macOS, fermer la fenêtre ne quitte pas l'application : la passerelle
 * reste en marche, et avec elle les employés et leurs missions planifiées.
 * Rouvrir depuis le Dock retrouve tout en l'état. C'est ⌘Q qui arrête tout.
 * (Jusqu'ici la fermeture arrêtait la passerelle sans quitter l'application :
 * la fenêtre rouverte depuis le Dock n'avait plus rien derrière elle.)
 */
app.on("window-all-closed", () => {
  // Windows et Linux : l'icône de la zone de notification tient l'application ouverte ; sans elle, on quitte comme avant.
  if (process.platform === "darwin" || zone) return;
  /*
   * Seulement une fois la fenêtre principale ouverte (essai sous Ubuntu du
   * 27/09/2026) : au démarrage, une fenêtre de service invisible (reprise de
   * l'ancien stockage) s'ouvre puis se ferme, et sa fermeture faisait quitter
   * l'application sous Windows et Linux avant même que la passerelle ne
   * démarre. Sur macOS, cette règle ne s'appliquait pas : rien ne se voyait.
   */
  if (!fenetrePrincipaleOuverte) return;
  app.quit();
});

/*
 * Quitter pendant qu'un bot enregistre : il sort de la réunion, son dernier
 * morceau part, puis l'application s'arrête. La réunion sera transcrite au
 * prochain démarrage.
 */
let sortieDesBots = false;
app.on("before-quit", (event) => {
  // Quitter depuis n'importe où (menu, Ctrl+Q, fin de session) : la fenêtre se ferme pour de bon.
  quitterVraiment = true;
  if (botsActifs() && !sortieDesBots) {
    event.preventDefault();
    sortieDesBots = true;
    void arreterTousLesBots().finally(() => app.quit());
    return;
  }
  /*
   * On attend que la passerelle se soit arrêtée (au plus 5 s). D'abord sous
   * Windows : Electron quittait aussitôt, et l'arrêt de secours (`taskkill` de
   * tout l'arbre) n'avait pas le temps de partir (audit du 27/09/2026). Puis
   * partout, depuis que la passerelle est un `utilityProcess` (28/09/2026) :
   * Electron arrête ses processus utilitaires en quittant, sans leur laisser
   * le temps d'arrêter OpenCode, OpenClaw ou le serveur de modèles (essayé :
   * aucun gestionnaire de sortie n'y tourne).
   */
  if (gateway && !arretPasserelleFait) {
    event.preventDefault();
    arretPasserelleFait = true;
    void stopGateway().finally(() => app.quit());
    return;
  }
  stopGateway();
});
let arretPasserelleFait = false;
process.on("exit", stopGateway);
