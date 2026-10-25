const { BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

/**
 * Bot de réunion, fait maison.
 *
 * Une fenêtre cachée de l'application (Chromium, comme un navigateur)
 * rejoint une réunion Google Meet comme invitée, sous le nom choisi dans les
 * réglages, sans micro ni caméra. Le préchargement (botPreload.cjs) capte le
 * son des participants et en tire des morceaux Opus de dix secondes ; ce
 * processus les envoie un à un à l'instance, qui les chiffre, puis transcrit
 * la réunion sur la machine à la fin. Aucun service tiers, aucun abonnement.
 *
 * Ce que le bot fait, dans l'ordre : ouvrir la page, cliquer « Continuer sans
 * micro ni caméra », écrire son nom, « Demander à participer », attendre
 * qu'un participant l'admette, enregistrer, puis partir quand la réunion se
 * termine, quand il reste seul deux minutes, au bout de quatre heures, ou
 * quand on l'arrête depuis l'application.
 *
 * Il ne lit la page que par son texte et les libellés de ses boutons, en
 * français et en anglais : Google change son code sans prévenir, un sélecteur
 * technique casserait au premier changement.
 *
 * Le son de la réunion n'est pas joué sur la machine (fenêtre muette) : il
 * est seulement capté.
 */

const PARTITION = "persist:oxoai-bot";
const PARTITION_PASSERELLE = "oxoai-passerelle";
const DUREE_MAX_MS = 4 * 3600_000;
const ATTENTE_ADMISSION_MS = 15 * 60_000;
const CHARGEMENT_MAX_MS = 3 * 60_000;
const SEUL_MAX_MS = 2 * 60_000;

/** reunionId → bot */
const bots = new Map();
let fenetrePrincipale = () => null;
let autorisationAuto = null;
let minuterieAuto = null;
const dejaLances = new Set();

/** Le navigateur que Meet s'attend à voir, selon le système réel (il disait « Macintosh » partout). */
function uaChrome() {
  const systeme =
    process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : process.platform === "linux" ? "X11; Linux x86_64" : "Macintosh; Intel Mac OS X 10_15_7";
  return `Mozilla/5.0 (${systeme}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function sessionBot() {
  const s = session.fromPartition(PARTITION);
  if (!s.__oxoaiPrete) {
    s.__oxoaiPrete = true;
    s.setUserAgent(uaChrome());
    // Ni micro, ni caméra, ni notifications : le bot écoute, il ne parle pas.
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
  }
  return s;
}

/* ---- Appels à l'instance ------------------------------------------------ */

function fichierInstancesConnues() {
  return path.join(os.homedir(), ".oxoai", "data", "instances-connues.json");
}

/**
 * Session réseau des envois à l'instance. Un certificat reconnu passe ; un
 * certificat auto-signé passe s'il est celui que la fenêtre principale a
 * retenu à la première connexion (même règle qu'elle, voir main.cjs). Rien
 * d'autre.
 */
function sessionPasserelle() {
  const s = session.fromPartition(PARTITION_PASSERELLE);
  if (!s.__oxoaiPrete) {
    s.__oxoaiPrete = true;
    s.setCertificateVerifyProc((req, callback) => {
      if (req.errorCode === 0) return callback(0);
      let connues = {};
      try {
        connues = JSON.parse(fs.readFileSync(fichierInstancesConnues(), "utf8"));
      } catch {
        /* aucune instance retenue */
      }
      const retenue = Object.entries(connues).some(([origine, v]) => {
        try {
          return new URL(origine).hostname === req.hostname && v && v.empreinte === req.certificate.fingerprint;
        } catch {
          return false;
        }
      });
      callback(retenue ? 0 : -2);
    });
  }
  return s;
}

/**
 * L'adresse d'instance confiée par le rendu est-elle acceptable ?
 *
 * Le processus principal n'est soumis à aucune politique de contenu : sans ce
 * contrôle, une page compromise lui faisait poster le jeton d'instance et le
 * jeton de séance vers l'hôte de son choix, toutes les soixante secondes, y
 * compris fenêtre fermée. Le lien Meet, lui, était bien vérifié ; celui-ci ne
 * l'était pas du tout.
 *
 * HTTPS exigé, sauf sur la boucle locale — c'est le cas d'un poste autonome,
 * où la passerelle tourne sur la même machine.
 */
function passerelleAcceptable(passerelle) {
  if (!passerelle || typeof passerelle.url !== "string") return false;
  if (typeof passerelle.jeton !== "string" || typeof passerelle.seance !== "string") return false;
  try {
    const u = new URL(passerelle.url);
    const locale = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
    return u.protocol === "https:" || (u.protocol === "http:" && locale);
  } catch {
    return false;
  }
}

async function appeler(passerelle, chemin, options = {}) {
  if (!passerelleAcceptable(passerelle)) {
    throw new Error("Adresse d'instance refusée : https est exigé hors de la machine.");
  }
  const r = await sessionPasserelle().fetch(`${passerelle.url.replace(/\/$/, "")}${chemin}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${passerelle.jeton}`,
      "X-OxoAI-Session": passerelle.seance,
      ...(options.type ? { "Content-Type": options.type } : {}),
    },
    body: options.body,
  });
  const corps = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corps?.error?.message ?? `L'instance a répondu ${r.status}.`);
  return corps;
}

/* ---- Lecture de la page Meet ---------------------------------------------- */

/**
 * Lu dans la page toutes les deux secondes. Fait une seule action par passage
 * (un clic, ou le nom à écrire) et rend la phase reconnue.
 */
function scriptPassage(nom) {
  return `(() => {
    const texte = (document.body && document.body.innerText) || "";
    const boutons = [...document.querySelectorAll('button, [role="button"]')];
    const libelle = (b) => ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
    const bouton = (re) => boutons.find((b) => re.test(libelle(b)) && !b.disabled && b.offsetParent !== null);
    const extrait = texte.replace(/\s+/g, " ").trim().slice(0, 300);
    // Le refus d'abord : sa page montre aussi « Revenir à l'écran d'accueil », qui passait pour une fin de réunion.
    if (/a refusé votre demande|denied your request|vous ne pouvez pas (participer|rejoindre)|you can't join|you cannot join|impossible de rejoindre|this meeting has been locked|réunion est verrouillée|n'avez pas été autorisé|not allowed to join/i.test(texte)) return { phase: "refus", extrait };
    if (/vous avez quitté|l'appel est terminé|la réunion est terminée|vous avez été (exclu|retiré)|you left the (meeting|call)|you've been removed|the (call|meeting) (has )?ended|return to home screen|revenir à l'écran d'accueil/i.test(texte)) return { phase: "fin", extrait };
    const quitter = boutons.find((b) => /^(quitter l'appel|leave call)$/i.test((b.getAttribute("aria-label") || "").trim()));
    if (quitter) {
      let participants = null;
      for (const e of document.querySelectorAll("[aria-label]")) {
        const m = /(?:participants?|tout le monde|everyone|personnes)\\D{0,12}\\(?(\\d{1,3})\\)?/i.exec(e.getAttribute("aria-label") || "");
        if (m) { participants = Number(m[1]); break; }
      }
      return { phase: "appel", participants };
    }
    if (/veuillez patienter|patientez|quelqu'un vous|vous rejoindrez|asking to be let in|waiting for someone|someone in the call to let you in|wait until a meeting host|demande de participation/i.test(texte)) return { phase: "attente" };
    /*
     * Le script ne clique plus lui-même : il rend le centre de l'élément, et le
     * processus principal y envoie un vrai clic (sendInputEvent). Mesuré le
     * 26/09/2026 sur une vraie réunion : le bouton « Participer » cliqué par
     * script restait sans effet, et la personne devait cliquer à sa place.
     */
    const centre = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
    // Une bulle d'avertissement (« Aucun micro détecté ») posée sur la page : on la ferme, elle peut masquer le bouton.
    const seul = (b) => [b.innerText || "", b.getAttribute("aria-label") || ""].map((x) => x.replace(/\s+/g, " ").trim());
    const fermer = boutons.find((b) => b.offsetParent !== null && b.closest('[role="dialog"], [role="alertdialog"]') && seul(b).some((x) => /^(fermer|close|ok|j'ai compris|got it|ignorer|dismiss)$/i.test(x)));
    if (fermer) return { phase: "preparation", clic: centre(fermer), extrait };
    const sans = bouton(/continuer sans (micro|microphone)|continue without (microphone|mic)/i);
    if (sans) return { phase: "preparation", clic: centre(sans), extrait };
    const champ = [...document.querySelectorAll("input")].find((i) => /nom|name/i.test((i.getAttribute("aria-label") || "") + " " + (i.placeholder || "")) && i.offsetParent !== null);
    if (champ && champ.value.trim() !== ${JSON.stringify(nom)}) return { phase: "nom", saisie: centre(champ), extrait };
    // Le libellé peut être « Participer », ou le texte suivi de son aria-label identique : on compare les deux séparément.
    const entrer = boutons.find((b) => !b.disabled && b.offsetParent !== null && [b.innerText || "", b.getAttribute("aria-label") || ""].some((x) => /^(demander à participer|participer|rejoindre maintenant|rejoindre|ask to join|join now|join)$/i.test(x.replace(/\s+/g, " ").trim())));
    if (entrer) return { phase: "demande", clic: centre(entrer), extrait };
    if (/connectez-vous|sign in to|se connecter pour|utilisez un compte|you need to sign in/i.test(texte) && !champ) return { phase: "connexion-requise", extrait };
    return { phase: "chargement", extrait };
  })()`;
}

const SCRIPT_QUITTER = `(() => {
  const b = [...document.querySelectorAll('button, [role="button"]')].find((x) => /^(quitter l'appel|leave call)$/i.test((x.getAttribute("aria-label") || "").trim()));
  if (b) b.click();
  return Boolean(b);
})()`;

/* ---- Vraies entrées et diagnostic ----------------------------------------- */

/** Un clic de souris au point donné (coordonnées de la page), comme un humain. */
async function vraiClic(fenetre, { x, y }) {
  if (!fenetre || fenetre.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const wc = fenetre.webContents;
  wc.sendInputEvent({ type: "mouseMove", x, y });
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 60));
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

/*
 * Ce que le bot lit à chaque passage, dans un fichier temporaire de la machine
 * (jamais envoyé nulle part) : phase et début du texte de la page d'accueil de
 * la réunion. Il sert à comprendre un blocage sans rejouer la réunion ; il est
 * écrasé à chaque bot, et ne contient rien une fois l'enregistrement commencé.
 */
function diagnostic(bot, lu) {
  try {
    const ligne = `${new Date().toISOString()} ${lu?.phase ?? "?"} ${lu?.clic ? `clic(${lu.clic.x},${lu.clic.y}) ` : ""}${lu?.saisie ? "saisie " : ""}${bot.debutEnregistrement ? "" : (lu?.extrait ?? "")}\n`;
    if (!bot.diagOuvert) {
      fs.writeFileSync(path.join(os.tmpdir(), "oxoai-bot-diagnostic.txt"), ligne, { mode: 0o600 });
      bot.diagOuvert = true;
    } else fs.appendFileSync(path.join(os.tmpdir(), "oxoai-bot-diagnostic.txt"), ligne);
  } catch {
    /* sans diagnostic, le bot fonctionne pareil */
  }
}

/* ---- Cycle de vie d'un bot ------------------------------------------------ */

function publier(bot) {
  const w = fenetrePrincipale();
  if (w && !w.isDestroyed()) w.webContents.send("oxoai:bot-etat", listerBots());
}

function vueBot(bot) {
  return {
    reunionId: bot.reunionId,
    titre: bot.titre,
    phase: bot.phase,
    message: bot.message ?? null,
    depuis: bot.debutEnregistrement ?? null,
    visible: Boolean(bot.fenetre && !bot.fenetre.isDestroyed() && bot.fenetre.isVisible()),
  };
}

function listerBots() {
  return [...bots.values()].map(vueBot);
}

async function signaler(bot, statut, message) {
  bot.message = message;
  publier(bot);
  try {
    await appeler(bot.passerelle, `/oxoai/reunions/${encodeURIComponent(bot.reunionId)}/etat`, {
      method: "POST",
      type: "application/json",
      body: JSON.stringify({ statut, message }),
    });
  } catch {
    /* l'instance le verra à la fin ; l'écran l'a déjà */
  }
}

async function conclure(bot, erreur) {
  if (bot.fini) return;
  bot.fini = true;
  clearInterval(bot.minuterie);
  if (erreur) {
    bot.phase = "erreur";
    await signaler(bot, "erreur", erreur);
  } else {
    bot.phase = "fin";
    publier(bot);
    // Les morceaux encore en route arrivent avant la fin de l'enregistrement.
    await bot.envois;
    try {
      await appeler(bot.passerelle, `/oxoai/reunions/${encodeURIComponent(bot.reunionId)}/terminer`, { method: "POST" });
    } catch {
      /* l'instance terminera d'elle-même au prochain démarrage */
    }
  }
  if (bot.fenetre && !bot.fenetre.isDestroyed()) bot.fenetre.destroy();
  bots.delete(bot.reunionId);
  publier(bot);
}

/** Arrête l'enregistrement proprement : le dernier morceau part, puis on conclut. */
function arreterEnregistrement(bot) {
  if (bot.arretEnCours) return;
  bot.arretEnCours = true;
  if (!bot.debutEnregistrement || !bot.fenetre || bot.fenetre.isDestroyed()) {
    void conclure(bot, bot.debutEnregistrement ? null : bot.erreurAttendue ?? "Le bot n'est pas entré dans la réunion.");
    return;
  }
  bot.fenetre.webContents.send("oxoai:bot-arreter");
  // Si la page ne répond plus, on conclut quand même.
  setTimeout(() => void conclure(bot, null), 8000);
}

async function passage(bot) {
  if (bot.fini || !bot.fenetre || bot.fenetre.isDestroyed()) return;
  let lu;
  try {
    lu = await bot.fenetre.webContents.executeJavaScript(scriptPassage(bot.nom), true);
  } catch {
    return;
  }
  const maintenant = Date.now();
  const phase = lu && lu.phase;
  diagnostic(bot, lu);
  if (lu && lu.clic && !bot.debutEnregistrement) {
    // Un vrai clic, pas un .click() de script : Meet ignore ces derniers.
    await vraiClic(bot.fenetre, lu.clic);
    bot.dernierClic = maintenant;
  }
  if (lu && lu.saisie && !bot.debutEnregistrement) {
    await vraiClic(bot.fenetre, lu.saisie);
    const wc = bot.fenetre.webContents;
    // Tout sélectionner, effacer, puis écrire le nom comme au clavier.
    wc.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    wc.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    await wc.insertText(bot.nom);
  }
  if (phase === "fin") {
    if (!bot.debutEnregistrement) bot.erreurAttendue = `La page de la réunion s'est fermée avant l'entrée du bot. Elle disait : « ${String(lu.extrait ?? "").slice(0, 200)} »`;
    return arreterEnregistrement(bot);
  }
  if (phase === "refus") {
    bot.erreurAttendue = `Google Meet n'a pas laissé entrer le bot. La page disait : « ${String(lu.extrait ?? "").slice(0, 200)} »`;
    return arreterEnregistrement(bot);
  }
  if (phase === "connexion-requise") {
    bot.erreurAttendue =
      "Cette réunion n'accepte que des comptes Google connectés. Connectez un compte Google au bot dans Réglages, Bot Recorder, puis renvoyez-le.";
    return arreterEnregistrement(bot);
  }
  if (phase === "attente") {
    if (bot.phase !== "attente") {
      bot.phase = "attente";
      bot.attenteDepuis = maintenant;
      await signaler(bot, "bot-attente", "Le bot attend qu'un participant l'admette dans la réunion.");
    } else if (maintenant - bot.attenteDepuis > ATTENTE_ADMISSION_MS) {
      bot.erreurAttendue = "Personne n'a admis le bot dans la réunion en quinze minutes.";
      return arreterEnregistrement(bot);
    }
    return;
  }
  if (phase === "appel") {
    if (!bot.debutEnregistrement) {
      bot.debutEnregistrement = new Date().toISOString();
      bot.phase = "enregistrement";
      bot.fenetre.webContents.send("oxoai:bot-demarrer");
      await signaler(bot, "bot-en-cours", "Le bot enregistre la réunion.");
    }
    if (lu.participants === 1) {
      bot.seulDepuis ??= maintenant;
      if (maintenant - bot.seulDepuis > SEUL_MAX_MS) {
        void bot.fenetre.webContents.executeJavaScript(SCRIPT_QUITTER, true).catch(() => undefined);
        return arreterEnregistrement(bot);
      }
    } else {
      bot.seulDepuis = null;
    }
    if (maintenant - Date.parse(bot.debutEnregistrement) > DUREE_MAX_MS) {
      void bot.fenetre.webContents.executeJavaScript(SCRIPT_QUITTER, true).catch(() => undefined);
      return arreterEnregistrement(bot);
    }
    return;
  }
  // Préparation, nom, demande, chargement : la page avance, ou pas.
  if (!bot.debutEnregistrement && bot.phase !== "attente" && maintenant - bot.cree > CHARGEMENT_MAX_MS) {
    bot.erreurAttendue = "La page de la réunion n'a pas pu être lue : le lien est peut-être erroné ou expiré.";
    arreterEnregistrement(bot);
  }
}

/**
 * Envoie un bot. `passerelle` : adresse de l'instance, jeton, séance de la
 * personne, gardés en mémoire le temps de la réunion seulement.
 */
function demarrerBot({ reunionId, lien, titre, nom, passerelle }) {
  if (bots.has(reunionId)) return listerBots();
  if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?[^\s#]*)?$/i.test(lien)) {
    throw new Error("Seuls les liens Google Meet sont pris en charge.");
  }
  if (!passerelleAcceptable(passerelle)) {
    throw new Error("Adresse d'instance refusée : https est exigé hors de la machine.");
  }
  sessionBot();
  const fenetre = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    title: `Bot de réunion : ${titre}`,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "botPreload.cjs"),
      /*
       * Le préchargement doit voir les connexions WebRTC de la page (voir
       * botPreload.cjs, qui dit ce que cela coûte : la page peut faire partir
       * un son de son choix, comme elle le pourrait de toute façon en jouant un
       * faux participant, et rien d'autre, les canaux vérifiant l'expéditeur).
       * `contextBridge.executeInMainWorld` (Electron 35 et suivants) n'y
       * changerait pas ce point ; pas repris, faute de pouvoir l'essayer ici.
       */
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // La réunion n'est pas jouée sur les haut-parleurs : le bot écoute, la personne n'entend rien de plus.
  fenetre.webContents.setAudioMuted(true);
  fenetre.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Google Meet et la connexion Google, rien d'autre : ni lien suivi, ni redirection ailleurs.
  const autorisee = (url) => /^https:\/\/(meet|accounts)\.google\.com\//.test(url);
  fenetre.webContents.on("will-navigate", (e, url) => {
    if (!autorisee(url)) e.preventDefault();
  });
  fenetre.webContents.on("will-redirect", (e, url) => {
    if (!autorisee(url)) e.preventDefault();
  });
  // Fermer la fenêtre du bot, quand on l'a affichée, ne le détruit pas : elle se cache.
  fenetre.on("close", (e) => {
    const bot = bots.get(reunionId);
    if (bot && !bot.fini) {
      e.preventDefault();
      fenetre.hide();
      publier(bot);
    }
  });

  const bot = {
    reunionId,
    titre,
    nom,
    passerelle,
    fenetre,
    phase: "connexion",
    cree: Date.now(),
    envois: Promise.resolve(),
    fini: false,
  };
  bots.set(reunionId, bot);
  const separateur = lien.includes("?") ? "&" : "?";
  void fenetre.loadURL(`${lien}${separateur}hl=fr`, { userAgent: uaChrome() }).catch(() => undefined);
  bot.minuterie = setInterval(() => void passage(bot), 2000);
  publier(bot);
  return listerBots();
}

function botDe(sender) {
  return [...bots.values()].find((b) => b.fenetre && !b.fenetre.isDestroyed() && b.fenetre.webContents === sender);
}

ipcMain.on("oxoai:bot-morceau", (event, morceau) => {
  const bot = botDe(event.sender);
  if (!bot || bot.fini || !(morceau instanceof ArrayBuffer) || morceau.byteLength === 0) return;
  // Un morceau après l'autre, dans l'ordre : l'instance les met bout à bout.
  bot.envois = bot.envois.then(() =>
    appeler(bot.passerelle, `/oxoai/reunions/${encodeURIComponent(bot.reunionId)}/audio`, {
      method: "POST",
      type: "application/octet-stream",
      body: new Uint8Array(morceau),
    }).catch((err) => {
      bot.message = `Envoi du son interrompu : ${err.message}`;
      publier(bot);
    }),
  );
});

ipcMain.on("oxoai:bot-fini", (event) => {
  const bot = botDe(event.sender);
  if (bot) void conclure(bot, null);
});

/* ---- Envoi automatique aux réunions de l'agenda ---------------------------- */

async function tourAutomatique() {
  const a = autorisationAuto;
  if (!a) return;
  let liste;
  try {
    liste = (await appeler(a.passerelle, "/oxoai/reunions/a-rejoindre")).reunions ?? [];
  } catch {
    return;
  }
  for (const r of liste) {
    if (dejaLances.has(r.evenement)) continue;
    dejaLances.add(r.evenement);
    try {
      const { reunion } = await appeler(a.passerelle, "/oxoai/reunions", {
        method: "POST",
        type: "application/json",
        body: JSON.stringify({ source: "bot", lien: r.lien, titre: r.titre, evenement: r.evenement }),
      });
      demarrerBot({ reunionId: reunion.id, lien: r.lien, titre: reunion.titre, nom: a.nom, passerelle: a.passerelle });
    } catch {
      /* déjà envoyé depuis un autre poste, ou lien refusé : rien à faire */
    }
  }
}

/* ---- Canaux de la fenêtre principale -------------------------------------- */

function installerBotReunion(obtenirFenetre) {
  fenetrePrincipale = obtenirFenetre;
  const depuisOxoAI = (event) => {
    const w = fenetrePrincipale();
    return Boolean(w && !w.isDestroyed() && event.sender === w.webContents);
  };

  ipcMain.handle("oxoai:bot-envoyer", (event, demande) => {
    if (!depuisOxoAI(event)) throw new Error("Refusé.");
    return demarrerBot(demande);
  });
  ipcMain.handle("oxoai:bot-arreter", (event, reunionId) => {
    if (!depuisOxoAI(event)) throw new Error("Refusé.");
    const bot = bots.get(reunionId);
    if (bot) {
      if (bot.fenetre && !bot.fenetre.isDestroyed()) void bot.fenetre.webContents.executeJavaScript(SCRIPT_QUITTER, true).catch(() => undefined);
      arreterEnregistrement(bot);
    }
    return listerBots();
  });
  ipcMain.handle("oxoai:bot-afficher", (event, reunionId) => {
    if (!depuisOxoAI(event)) throw new Error("Refusé.");
    const bot = bots.get(reunionId);
    if (bot?.fenetre && !bot.fenetre.isDestroyed()) {
      bot.fenetre.show();
      bot.fenetre.focus();
    }
    return listerBots();
  });
  ipcMain.handle("oxoai:bot-liste", (event) => {
    if (!depuisOxoAI(event)) throw new Error("Refusé.");
    return listerBots();
  });
  /*
   * Envoi automatique : l'interface confie l'adresse de l'instance et la
   * séance de la personne, gardées en mémoire tant que l'application tourne
   * (fenêtre fermée comprise), jamais écrites sur le disque. `null` arrête.
   */
  ipcMain.handle("oxoai:bot-auto", (event, autorisation) => {
    if (!depuisOxoAI(event)) throw new Error("Refusé.");
    // Même contrôle qu'à l'envoi d'un bot : cette adresse sera interrogée
    // toutes les minutes, avec les deux jetons, tant que l'application tourne.
    if (autorisation && autorisation.passerelle && !passerelleAcceptable(autorisation.passerelle)) {
      throw new Error("Adresse d'instance refusée : https est exigé hors de la machine.");
    }
    autorisationAuto = autorisation && autorisation.passerelle ? autorisation : null;
    if (autorisationAuto && !minuterieAuto) {
      minuterieAuto = setInterval(() => void tourAutomatique(), 60_000);
      void tourAutomatique();
    }
    if (!autorisationAuto && minuterieAuto) {
      clearInterval(minuterieAuto);
      minuterieAuto = null;
    }
    return Boolean(autorisationAuto);
  });
  /*
   * Compte Google du bot : certaines réunions n'admettent que des comptes
   * connectés. La personne se connecte elle-même, dans une fenêtre de Google,
   * que l'application ne lit pas ; la session reste propre au bot.
   */
  ipcMain.handle("oxoai:bot-compte", async (event, action) => {
    if (!depuisOxoAI(event)) throw new Error("Refusé.");
    const s = sessionBot();
    if (action === "oublier") {
      await s.clearStorageData();
      return { connecte: false };
    }
    if (action === "connecter") {
      const w = new BrowserWindow({
        width: 480,
        height: 720,
        title: "Compte Google du bot de réunion",
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      // En https seulement : la connexion d'une entreprise peut passer par son propre fournisseur d'identité.
      w.webContents.on("will-navigate", (e, url) => {
        if (!url.startsWith("https://")) e.preventDefault();
      });
      await w.loadURL("https://accounts.google.com/ServiceLogin?hl=fr&continue=https://meet.google.com/", { userAgent: uaChrome() });
      return new Promise((resolve) => {
        w.on("closed", async () => {
          const cookies = await s.cookies.get({ domain: ".google.com", name: "SID" }).catch(() => []);
          resolve({ connecte: cookies.length > 0 });
        });
      });
    }
    const cookies = await s.cookies.get({ domain: ".google.com", name: "SID" }).catch(() => []);
    return { connecte: cookies.length > 0 };
  });
}

/** Des bots sont-ils en route ? */
const botsActifs = () => bots.size > 0;

/**
 * À la fermeture de l'application : chaque bot part, son dernier morceau est
 * envoyé et la réunion part en transcription. Dix secondes au plus.
 */
function arreterTousLesBots() {
  for (const bot of bots.values()) arreterEnregistrement(bot);
  return new Promise((resolve) => {
    const debut = Date.now();
    const t = setInterval(() => {
      if (bots.size === 0 || Date.now() - debut > 10_000) {
        clearInterval(t);
        resolve();
      }
    }, 200);
  });
}

module.exports = { installerBotReunion, arreterTousLesBots, botsActifs };
