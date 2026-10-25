// @ts-check
"use strict";

/**
 * OxoAI AI pour VS Code.
 *
 * Le Chat de l'instance OxoAI dans la barre latérale, et deux commandes sur
 * le code sélectionné (expliquer, améliorer). Tout passe par l'instance
 * OxoAI : ses modèles (locaux d'abord), ses règles, son journal. L'extension
 * ne parle à aucun autre service.
 *
 * Les appels partent de VS Code lui-même (le processus de l'extension), pas
 * de la page du Chat : le jeton d'instance ne passe jamais dans la page.
 *
 * Instance : par défaut celle de l'application OxoAI de cet ordinateur
 * (http://127.0.0.1:8787, jeton lu dans ~/.oxoai/data/instance-token).
 * Une instance d'entreprise se règle dans les paramètres (oxoai.adresse,
 * oxoai.jeton).
 */

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

/** Taille maximale du fichier ouvert joint à une question, en caractères. */
const FICHIER_MAX = 30_000;

const BOUCLE = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * Réglages de l'extension, avec les règles de la ligne de commande
 * (`adresseInstance`, cli/oxoai.mjs).
 *
 * Revue de sécurité du 26/09/2026 : `oxoai.adresse` et `oxoai.jeton` étaient
 * réglables par le `.vscode/settings.json` d'un dépôt ouvert. Un dépôt piégé
 * désignait son serveur, et recevait le jeton du poste, le fichier ouvert, la
 * séance, puis le mot de passe à la connexion. Désormais :
 *  - ces deux réglages sont de portée « machine » (package.json) : un espace de
 *    travail ne peut plus les changer ;
 *  - http n'est accepté que sur la boucle locale ; ailleurs, https ;
 *  - le jeton du poste n'est lu que pour une adresse locale, et seulement pour
 *    le port que l'application a réellement ouvert (`instance-port`).
 */
function reglages() {
  const c = vscode.workspace.getConfiguration("oxoai");
  const adresse = String(c.get("adresse") || "http://127.0.0.1:8787").replace(/\/+$/, "");
  let url;
  try {
    url = new URL(adresse);
  } catch {
    throw new Error(`Adresse d'instance illisible : « ${adresse} ».`);
  }
  const locale = BOUCLE.includes(url.hostname);
  if (url.protocol === "http:" && !locale) {
    throw new Error(`Adresse refusée : « ${adresse} ». Hors de cet ordinateur, l'instance se joint en https.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Adresse refusée : « ${adresse} ».`);
  let jeton = String(c.get("jeton") || "");
  if (!jeton && locale) {
    try {
      const dossier = process.env.OXOAI_DATA_DIR || path.join(os.homedir(), ".oxoai", "data");
      const ouvert = fs.readFileSync(path.join(dossier, "instance-port"), "utf8").trim();
      const vise = url.port || (url.protocol === "https:" ? "443" : "80");
      if (ouvert === vise) jeton = fs.readFileSync(path.join(dossier, "instance-token"), "utf8").trim();
    } catch {
      /* pas d'application OxoAI sur ce poste, ou d'une version qui ne note pas son port : il faudra régler le jeton */
    }
  }
  return { adresse, jeton, modele: String(c.get("modele") || "") };
}

/*
 * Réflexion écrite dans le texte, entre `<think>` et `</think>` (29/09/2026) :
 * certains moteurs ne la séparent pas (réglage de LM Studio, gabarit du modèle
 * non reconnu, service qui rend le texte brut), et les balises s'affichaient
 * ici avec toute la réflexion. Même découpage que la passerelle
 * (gateway/src/reflexionEnLigne.ts, essayé par la section 40 de
 * scripts/securite.mjs) : une réflexion en tête du texte, balises coupées
 * n'importe où entre deux morceaux, ou la balise fermante seule quand le
 * gabarit du modèle a déjà ouvert la sienne (`requalifie` : les derniers
 * caractères déjà rendus comme réponse étaient la réflexion).
 */
function separateurReflexion() {
  const OUVRANTE = "<think>";
  const FERMANTE = "</think>";
  const debutDe = (tete, balise) => tete.length < balise.length && balise.startsWith(tete);
  const suffixe = (s, balise) => {
    for (let n = Math.min(balise.length - 1, s.length); n > 0; n--) if (balise.startsWith(s.slice(s.length - n))) return n;
    return 0;
  };
  let etat = "debut";
  let retenu = "";
  let rendus = 0;
  let vue = false;
  return {
    /** Réflexion reçue par son canal séparé : le texte qui suit est la réponse. */
    canalSepare() {
      if (etat === "debut" && rendus === 0) etat = "apres";
    },
    /** @param {string} morceau @returns {{texte: string, reflexion: string, requalifie?: number}} */
    ajouter(morceau) {
      const sortie = { texte: "", reflexion: "" };
      let reste = retenu + morceau;
      retenu = "";
      while (reste) {
        if (etat === "reponse") {
          sortie.texte += reste;
          reste = "";
        } else if (etat === "debut") {
          const tete = reste.trimStart();
          if (rendus === 0) {
            if (!tete || debutDe(tete, OUVRANTE) || debutDe(tete, FERMANTE)) {
              retenu = reste;
              break;
            }
            if (tete.startsWith(OUVRANTE) || tete.startsWith(FERMANTE)) {
              etat = tete.startsWith(OUVRANTE) ? "dedans" : "apres";
              reste = tete.slice(tete.startsWith(OUVRANTE) ? OUVRANTE.length : FERMANTE.length);
              continue;
            }
          }
          const i = reste.indexOf(FERMANTE);
          if (i >= 0) {
            if (rendus > 0) sortie.requalifie = rendus;
            sortie.reflexion += reste.slice(0, i);
            rendus = 0;
            etat = "apres";
            reste = reste.slice(i + FERMANTE.length);
            continue;
          }
          const n = suffixe(reste, FERMANTE);
          sortie.texte += reste.slice(0, reste.length - n);
          rendus += reste.length - n;
          retenu = reste.slice(reste.length - n);
          reste = "";
        } else if (etat === "dedans") {
          if (!vue) reste = reste.trimStart();
          if (!reste) break;
          const i = reste.indexOf(FERMANTE);
          if (i >= 0) {
            sortie.reflexion += reste.slice(0, i);
            etat = "apres";
            reste = reste.slice(i + FERMANTE.length);
            continue;
          }
          const n = suffixe(reste, FERMANTE);
          sortie.reflexion += reste.slice(0, reste.length - n);
          if (reste.length > n) vue = true;
          retenu = reste.slice(reste.length - n);
          reste = "";
        } else {
          const tete = reste.trimStart();
          if (!tete || debutDe(tete, FERMANTE)) {
            retenu = tete;
            break;
          }
          if (tete.startsWith(FERMANTE)) {
            reste = tete.slice(FERMANTE.length);
            continue;
          }
          etat = "reponse";
          reste = tete;
        }
      }
      return sortie;
    },
    /** Fin du flux : ce qui était retenu est rendu à sa place. */
    finir() {
      const r = retenu;
      retenu = "";
      if (etat === "dedans") return { texte: "", reflexion: r };
      const t = r.trim();
      if ((etat === "debut" || etat === "apres") && rendus === 0 && (!t || OUVRANTE.startsWith(t) || FERMANTE.startsWith(t))) return { texte: "", reflexion: "" };
      return { texte: r, reflexion: "" };
    },
  };
}

/**
 * Pose une question à l'instance, et rend la réponse morceau par morceau.
 * @param {{role: string, content: string}[]} messages
 * @param {(texte: string) => void} surMorceau
 * @param {AbortSignal} signal
 * @param {() => void} [surReflexion] le modèle réfléchit avant de répondre (`reasoning_content`, ou `<think>` dans le texte)
 * @param {(caracteres: number) => void} [surRequalifier] les derniers caractères rendus étaient la réflexion (`</think>` seul)
 */
async function demander(messages, surMorceau, signal, surReflexion, surRequalifier) {
  const { adresse, jeton, modele } = reglages();
  if (!jeton) {
    throw new Error(
      "Aucun jeton d'instance : ouvrez l'application OxoAI sur cet ordinateur, ou réglez « oxoai.jeton » dans les paramètres.",
    );
  }
  let res;
  try {
    res = await fetch(`${adresse}/v1/chat/completions`, {
      // Jamais de redirection suivie : l'en-tête d'autorisation partirait ailleurs.
      redirect: "error",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ messages, stream: true, ...(modele ? { model: modele } : {}) }),
      signal,
    });
  } catch {
    throw new Error(`L'instance OxoAI ne répond pas (${adresse}). Ouvrez l'application OxoAI, puis réessayez.`);
  }
  if (!res.ok || !res.body) {
    const corps = await res.json().catch(() => ({}));
    throw new Error(corps?.error?.message || `L'instance a refusé la demande (${res.status}).`);
  }
  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder();
  let reste = "";
  const separateur = separateurReflexion();
  /** @param {{texte: string, reflexion: string, requalifie?: number}} m */
  const rendre = (m) => {
    if (m.requalifie) surRequalifier?.(m.requalifie);
    if (m.reflexion) surReflexion?.();
    if (m.texte) surMorceau(m.texte);
  };
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    reste += decodeur.decode(value, { stream: true });
    const lignes = reste.split("\n");
    reste = lignes.pop() ?? "";
    for (const ligne of lignes) {
      const l = ligne.trim();
      if (!l.startsWith("data:")) continue;
      const donnee = l.slice(5).trim();
      if (donnee === "[DONE]") return rendre(separateur.finir());
      try {
        const evenement = JSON.parse(donnee);
        if (evenement.error) throw new Error(evenement.error.message || "Erreur du modèle.");
        const delta = evenement.choices?.[0]?.delta;
        /*
         * La réflexion n'est pas montrée, mais elle est dite : Qwen3 réfléchit
         * parfois plus de deux minutes avant d'écrire, et la vue n'affichait
         * que « … » (vu dans VS Code le 29/09/2026).
         */
        if (delta?.reasoning_content || delta?.reasoning) {
          separateur.canalSepare();
          surReflexion?.();
        }
        if (typeof delta?.content === "string" && delta.content) rendre(separateur.ajouter(delta.content));
      } catch (err) {
        if (err instanceof Error && !(err instanceof SyntaxError)) throw err;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Séance (OxoAI Code)                                                 */
/* ------------------------------------------------------------------ */

/*
 * Le Chat se contente du jeton d'instance. OxoAI Code, qui modifie des
 * fichiers, exige une séance : la personne se connecte avec son compte OxoAI,
 * et la séance est gardée dans le coffre de VS Code (SecretStorage), jamais
 * dans les réglages en clair.
 */
/*
 * Une séance par adresse : celle d'une instance n'est jamais présentée à une
 * autre (revue du 26/09/2026, une clé unique « oxoai.seance » la donnait à
 * toute adresse réglée ensuite).
 */
const cleSeance = () => `oxoai.seance:${reglages().adresse}`;

/** @param {vscode.ExtensionContext} contexte */
async function seance(contexte) {
  return (await contexte.secrets.get(cleSeance())) || "";
}

/**
 * Appel à l'instance avec le jeton, et la séance si on l'a.
 * @param {string} chemin
 * @param {RequestInit & {seance?: string}} options
 */
async function appel(chemin, options = {}) {
  const { adresse, jeton } = reglages();
  const { seance: s, ...reste } = options;
  return fetch(`${adresse}${chemin}`, {
    ...reste,
    // Jamais de redirection suivie : `fetch` renverrait `X-OxoAI-Session` à l'adresse désignée (vérifié sur Node 24).
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
      ...(s ? { "X-OxoAI-Session": s } : {}),
      ...(reste.headers || {}),
    },
  });
}

/** @param {vscode.ExtensionContext} contexte */
async function seConnecter(contexte) {
  let comptes = [];
  try {
    const r = await appel("/oxoai/data/accounts");
    comptes = ((await r.json()).value || []);
  } catch {
    return void vscode.window.showErrorMessage("L'instance OxoAI ne répond pas : ouvrez l'application OxoAI, puis réessayez.");
  }
  if (comptes.length === 0) return void vscode.window.showErrorMessage("Aucun compte sur cette instance.");
  const choix = await vscode.window.showQuickPick(
    comptes.map((c) => ({ label: c.fullName || c.email, description: c.email, id: c.id })),
    { title: "OxoAI : se connecter", placeHolder: "Votre compte" },
  );
  if (!choix) return;
  const motDePasse = await vscode.window.showInputBox({ title: `Mot de passe de ${choix.label}`, password: true, ignoreFocusOut: true });
  if (!motDePasse) return;
  let r = await appel("/oxoai/auth/verify", { method: "POST", body: JSON.stringify({ accountId: choix.id, password: motDePasse, poste: "VS Code", rester: true }) });
  let corps = await r.json().catch(() => ({}));
  if (!r.ok && corps?.error?.code === "deux-facteurs-requis" && corps.defi) {
    const code = await vscode.window.showInputBox({ title: "Code de vérification", prompt: "Celui de votre application d'authentification, ou un code de secours.", ignoreFocusOut: true });
    if (!code) return;
    r = await appel("/oxoai/auth/deux-facteurs", { method: "POST", body: JSON.stringify({ defi: corps.defi, code, poste: "VS Code", rester: true }) });
    corps = await r.json().catch(() => ({}));
  }
  const jetonSeance = corps?.session?.token;
  if (!r.ok || !jetonSeance) {
    return void vscode.window.showErrorMessage(corps?.error?.message || "Connexion refusée.");
  }
  await contexte.secrets.store(cleSeance(), jetonSeance);
  vscode.window.showInformationMessage(`Connecté à OxoAI : ${choix.label}.`);
}

/* ------------------------------------------------------------------ */
/* OxoAI Code                                                          */
/* ------------------------------------------------------------------ */

/** Nom lisible des outils de l'agent de code, les mêmes que l'écran Code et la ligne de commande. */
const OUTILS = {
  read: "Lecture",
  write: "Écriture",
  edit: "Modification",
  list: "Liste",
  glob: "Recherche",
  grep: "Recherche",
  bash: "Commande",
  webfetch: "Page web",
  todowrite: "Liste de tâches mise à jour",
  todoread: "Lecture de la liste de tâches",
  task: "Sous-tâche",
};

/** « 45 s », « 2 min 05 s ». */
function duree(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/**
 * Ce que l'on dit pendant que le modèle n'a encore rien rendu (`oxoai.statut`
 * de l'instance, toutes les dix secondes) : sans lui, une lecture de deux
 * minutes ressemblait à une panne. Chaîne vide : le modèle répond, on efface.
 */
function texteStatut(d) {
  const ecoule = duree(Math.max(0, (Number(d.timestamp) || Date.now()) - (Number(d.depuis) || Date.now())));
  if (d.etat === "chargement") return `Le modèle se charge en mémoire (${ecoule})...`;
  if (d.etat === "attente") return `Le modèle termine une autre demande avant celle-ci (${ecoule})...`;
  if (d.etat !== "lecture") return "";
  const detail = [ecoule, typeof d.progression === "number" ? `${d.progression} %` : ""].filter(Boolean).join(", ");
  return `${d.sousTache ? "Le modèle lit la demande de la sous-tâche" : "Le modèle lit la demande"} (${detail})...`;
}

/**
 * Une demande à OxoAI Code, sur le dossier ouvert dans VS Code. Rend les
 * évènements de l'agent un à un (texte, outil appelé, outil fini), jusqu'à la
 * fin du tour.
 * @param {vscode.ExtensionContext} contexte
 * @param {{session: string | null}} etat
 * @param {string} texte
 * @param {(e: {type: string, texte?: string, outil?: string, ok?: boolean}) => void} surEvenement
 * @param {AbortSignal} signal
 */
async function demanderAuCode(contexte, etat, texte, surEvenement, signal) {
  const s = await seance(contexte);
  if (!s) throw new Error("OxoAI Code modifie vos fichiers : connectez-vous d'abord (commande « OxoAI : se connecter »).");
  const dossier = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!dossier) throw new Error("Ouvrez d'abord un dossier dans VS Code : c'est là que OxoAI Code travaille.");
  /*
   * Le dossier ouvert est un chemin de CE poste ; l'agent de code travaille
   * sur la machine de l'instance. Pour une instance distante, il désignerait un
   * autre dossier, ou aucun (revue du 25/09/2026).
   */
  let hote = "";
  try {
    hote = new URL(reglages().adresse).hostname;
  } catch {
    /* adresse illisible : l'appel échouera plus loin, avec son message */
  }
  if (hote && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hote)) {
    throw new Error("OxoAI Code travaille sur la machine de l'instance : depuis VS Code, seulement avec l'instance de cet ordinateur. Pour une instance d'entreprise, utilisez l'application ou « oxoai code --dossier ».");
  }
  if (!etat.session) {
    const r = await appel("/oxoai/code/session", { method: "POST", seance: s, body: JSON.stringify({ dossier }) });
    const corps = await r.json().catch(() => ({}));
    if (r.status === 401) await contexte.secrets.delete(cleSeance());
    if (!r.ok) throw new Error(corps?.error?.message || `Session refusée (${r.status}).`);
    etat.session = corps?.data?.id || corps?.id;
  }
  /*
   * Le flux d'abord, la demande ensuite : aucun évènement ne se perd entre les
   * deux. Ce premier flux a son propre arrêt : si la demande est refusée, ou
   * relancée dans une autre session, personne ne l'attend plus. Il restait
   * ouvert (l'instance le garde en vie toutes les vingt secondes) jusqu'à la
   * fermeture de VS Code, un de plus à chaque relance, et son échec tardif
   * devenait un rejet que personne ne traitait.
   */
  const arretPremier = new AbortController();
  const suivreArret = () => arretPremier.abort();
  signal.addEventListener("abort", suivreArret, { once: true });
  const ecouter = async (session, arretFlux = signal) => {
    const r = await appel(`/oxoai/code/events?sessionID=${encodeURIComponent(session)}`, { seance: s, signal: arretFlux });
    if (!r.ok || !r.body) throw new Error(`Flux de l'agent indisponible (${r.status}).`);
    const lecteur = r.body.getReader();
    const decodeur = new TextDecoder();
    let reste = "";
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) return;
      reste += decodeur.decode(value, { stream: true });
      const blocs = reste.split("\n\n");
      reste = blocs.pop() ?? "";
      for (const bloc of blocs) {
        const donnee = bloc.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!donnee) continue;
        let ev;
        try {
          ev = JSON.parse(donnee);
        } catch {
          continue;
        }
        const d = ev.data || {};
        if (ev.type === "oxoai.statut") surEvenement({ type: "statut", statut: texteStatut(d) });
        else if (ev.type === "session.next.text.ended" && d.text) surEvenement({ type: "texte", texte: d.text });
        else if (ev.type === "session.next.tool.called") {
          const cible = d.input?.filePath || d.input?.path || d.input?.command || d.input?.pattern || "";
          // Une sous-tâche dit ce qu'elle fait (sa description), au lieu de « task ».
          const libelle =
            d.tool === "task" && typeof d.input?.description === "string"
              ? `${OUTILS.task} : ${d.input.description}`
              : // Connecteurs de l'instance : « oxoai_drive__chercher » chez OpenCode, « drive__chercher » ici.
                `${OUTILS[d.tool] || String(d.tool ?? "").replace(/^oxoai_/, "")} ${cible}`.trim();
          surEvenement({ type: "outil", outil: libelle });
        } else if (ev.type === "session.next.tool.failed") surEvenement({ type: "outil-fin", ok: false });
        else if (ev.type === "session.next.tool.success") surEvenement({ type: "outil-fin", ok: true });
        else if (ev.type === "session.next.step.failed") throw new Error(d.error?.message || "L'agent de code a interrompu la tâche.");
        else if (ev.type === "session.next.step.ended" && d.finish && d.finish !== "tool-calls" && d.finish !== "tool_calls") return;
      }
    }
  };
  const flux = ecouter(etat.session, arretPremier.signal);
  flux.catch(() => undefined);
  /*
   * Depuis le 26/09/2026, chaque commande de l'agent de code, et chaque
   * modification au niveau « Demander avant de modifier », attend un accord
   * (gateway/src/permissionsCode.ts). La carte va à la personne connectée : on
   * l'écoute le temps du tour, et on la pose dans une fenêtre de VS Code. Sans
   * réponse ici ni dans l'application, l'action n'est pas faite (deux minutes).
   */
  const arretCartes = new AbortController();
  void ecouterCartes(s, arretCartes.signal).catch(() => undefined);
  try {
    const r = await appel("/oxoai/code/prompt", { method: "POST", seance: s, body: JSON.stringify({ sessionID: etat.session, text: texte }) });
    const corps = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corps?.error?.message || `Demande refusée (${r.status}).`);
    if (corps?.oxoaiRelance?.sessionID) {
      // L'instance a dû relancer la demande dans une nouvelle session : on suit celle-là, et on lâche l'autre.
      arretPremier.abort();
      etat.session = corps.oxoaiRelance.sessionID;
      await ecouter(etat.session);
      return;
    }
    await flux;
  } finally {
    signal.removeEventListener("abort", suivreArret);
    arretPremier.abort();
    arretCartes.abort();
  }
}

/**
 * Ce qui vient de l'instance, sans caractère de contrôle ni renversement de
 * l'ordre d'affichage (même règle que la ligne de commande, cli/oxoai.mjs).
 * @param {unknown} v
 */
const propre = (v) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, "");

/**
 * Les demandes d'accord de OxoAI Code pour la personne connectée, posées dans
 * une fenêtre modale. Seul « Autoriser » accorde ; fermer la fenêtre refuse.
 * @param {string} s séance
 * @param {AbortSignal} signal
 */
async function ecouterCartes(s, signal) {
  const r = await appel("/oxoai/approbation/evenements", { seance: s, signal });
  if (!r.ok || !r.body) return;
  const lecteur = r.body.getReader();
  const decodeur = new TextDecoder();
  let reste = "";
  const vues = new Set();
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) return;
    reste += decodeur.decode(value, { stream: true });
    const blocs = reste.split("\n\n");
    reste = blocs.pop() ?? "";
    for (const bloc of blocs) {
      const donnee = bloc.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      let ev;
      try {
        ev = JSON.parse(donnee);
      } catch {
        continue;
      }
      if (ev.type !== "approbation_demandee" || ev.nature !== "outil" || ev.detail?.surface !== "code" || vues.has(ev.id)) continue;
      vues.add(ev.id);
      const commande = typeof ev.detail?.commande === "string" ? `\n\n${propre(ev.detail.commande).slice(0, 2000)}` : "";
      void vscode.window
        .showWarningMessage(`OxoAI Code veut ${propre(ev.resume)}.`, { modal: true, detail: `Accord demandé.${commande}` }, "Autoriser", "Refuser")
        .then((choix) =>
          appel("/oxoai/approbation/repondre", { method: "POST", seance: s, body: JSON.stringify({ id: ev.id, accord: choix === "Autoriser" }) }).catch(() => undefined),
        );
    }
  }
}

/** Le fichier ouvert, pour le joindre à une question. */
function fichierOuvert() {
  const e = vscode.window.activeTextEditor;
  if (!e) return null;
  const nom = vscode.workspace.asRelativePath(e.document.uri);
  const texte = e.document.getText();
  return {
    nom,
    langage: e.document.languageId,
    texte: texte.length > FICHIER_MAX ? `${texte.slice(0, FICHIER_MAX)}\n[… fichier coupé]` : texte,
  };
}

class VueChat {
  /** @param {vscode.ExtensionContext} contexte */
  constructor(contexte) {
    this.contexte = contexte;
    /** @type {vscode.WebviewView | null} */
    this.vue = null;
    /** @type {{role: string, content: string}[]} */
    this.historique = [];
    /** @type {AbortController | null} */
    this.arret = null;
    /** Session OxoAI Code en cours (une par vue, sur le dossier ouvert). */
    this.code = { session: null };
  }

  /** @param {vscode.WebviewView} vue */
  resolveWebviewView(vue) {
    this.vue = vue;
    vue.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.contexte.extensionUri, "media")] };
    vue.webview.html = this.page(vue.webview);
    vue.webview.onDidReceiveMessage((m) => {
      if (m.type === "question") void this.question(String(m.texte || ""), Boolean(m.joindre));
      if (m.type === "code") void this.demandeCode(String(m.texte || ""));
      if (m.type === "connexion") void vscode.commands.executeCommand("oxoai.seConnecter");
      if (m.type === "arreter") this.arret?.abort();
      if (m.type === "nouveau") this.nouveau();
      if (m.type === "inserer") void this.inserer(String(m.texte || ""));
    });
  }

  nouveau() {
    this.arret?.abort();
    this.historique = [];
    this.code = { session: null };
    this.vue?.webview.postMessage({ type: "vider" });
  }

  /**
   * @param {string} texte
   * @param {boolean} joindre joindre le fichier ouvert
   */
  async question(texte, joindre) {
    if (!texte.trim() || this.arret) return;
    const fichier = joindre ? fichierOuvert() : null;
    const contenu = fichier
      ? `${texte}\n\nFichier ouvert : ${fichier.nom}\n\`\`\`${fichier.langage}\n${fichier.texte}\n\`\`\``
      : texte;
    this.historique.push({ role: "user", content: contenu });
    this.vue?.webview.postMessage({ type: "question", texte, fichier: fichier?.nom });
    this.arret = new AbortController();
    let reponse = "";
    let dernierSigne = 0;
    try {
      await demander(this.historique, (m) => {
        reponse += m;
        this.vue?.webview.postMessage({ type: "morceau", texte: m });
      }, this.arret.signal, () => {
        // Une fois par seconde au plus : la page compte elle-même les secondes.
        if (Date.now() - dernierSigne < 1000) return;
        dernierSigne = Date.now();
        this.vue?.webview.postMessage({ type: "reflexion" });
      }, (n) => {
        // Ce qui s'affichait comme réponse était la réflexion : retiré, et la vue redit que le modèle réfléchit.
        reponse = reponse.slice(0, Math.max(0, reponse.length - n));
        dernierSigne = Date.now();
        this.vue?.webview.postMessage({ type: "requalifier", caracteres: n });
      });
      this.historique.push({ role: "assistant", content: reponse });
      this.vue?.webview.postMessage({ type: "fin" });
    } catch (err) {
      const arrete = this.arret?.signal.aborted;
      this.historique.pop();
      this.vue?.webview.postMessage({ type: "erreur", texte: arrete ? "Arrêté." : err instanceof Error ? err.message : String(err) });
    } finally {
      this.arret = null;
    }
  }

  /** @param {string} texte */
  async demandeCode(texte) {
    if (!texte.trim() || this.arret) return;
    this.vue?.webview.postMessage({ type: "question", texte });
    this.arret = new AbortController();
    try {
      /*
       * `type` en dernier : placé avant, il était remplacé par celui de
       * l'évènement (« texte », « outil », « outil-fin »), et la page, qui
       * n'attend que « code », n'affichait ni les actions ni la réponse de
       * OxoAI Code, seulement la fin du tour.
       */
      await demanderAuCode(this.contexte, this.code, texte, (e) => this.vue?.webview.postMessage({ ...e, type: "code" }), this.arret.signal);
      this.vue?.webview.postMessage({ type: "fin" });
    } catch (err) {
      const arrete = this.arret?.signal.aborted;
      if (arrete && this.code.session) void appel("/oxoai/code/interrupt", { method: "POST", seance: await seance(this.contexte), body: JSON.stringify({ sessionID: this.code.session }) });
      this.vue?.webview.postMessage({ type: "erreur", texte: arrete ? "Arrêté." : err instanceof Error ? err.message : String(err) });
    } finally {
      this.arret = null;
    }
  }

  /** Insère un bloc de code de la réponse dans l'éditeur, à la place de la sélection. */
  async inserer(texte) {
    const e = vscode.window.activeTextEditor;
    if (!e) return void vscode.window.showWarningMessage("Ouvrez d'abord le fichier où insérer le code.");
    await e.edit((b) => (e.selection.isEmpty ? b.insert(e.selection.active, texte) : b.replace(e.selection, texte)));
  }

  /** @param {vscode.Webview} webview */
  page(webview) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const src = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.contexte.extensionUri, "media", f));
    return `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${src("chat.css")}">
</head><body>
<nav class="onglets" role="tablist">
  <button type="button" role="tab" id="onglet-chat" aria-selected="true">Chat</button>
  <button type="button" role="tab" id="onglet-code" aria-selected="false">Code</button>
</nav>
<main id="fil" aria-live="polite">
  <p class="accueil">Chat : posez une question à OxoAI. Code : OxoAI Code lit, écrit et modifie les fichiers du dossier ouvert.</p>
</main>
<form id="formulaire">
  <textarea id="saisie" rows="3" placeholder="Demandez à OxoAI…"></textarea>
  <div class="barre">
    <label><input type="checkbox" id="joindre" checked> Joindre le fichier ouvert</label>
    <span class="espace"></span>
    <button type="button" id="nouveau" class="discret" title="Nouveau Chat">Nouveau</button>
    <button type="submit" id="envoyer">Envoyer</button>
  </div>
</form>
<script nonce="${nonce}" src="${src("chat.js")}"></script>
</body></html>`;
  }
}

/** @param {vscode.ExtensionContext} contexte */
function activate(contexte) {
  const vue = new VueChat(contexte);
  contexte.subscriptions.push(vscode.window.registerWebviewViewProvider("oxoai.chat", vue, { webviewOptions: { retainContextWhenHidden: true } }));

  /** @param {string} consigne */
  const surSelection = async (consigne) => {
    const e = vscode.window.activeTextEditor;
    const selection = e?.document.getText(e.selection) ?? "";
    if (!selection.trim()) return void vscode.window.showInformationMessage("Sélectionnez d'abord du code.");
    await vscode.commands.executeCommand("oxoai.chat.focus");
    const langage = e?.document.languageId ?? "";
    void vue.question(`${consigne}\n\n\`\`\`${langage}\n${selection}\n\`\`\``, false);
  };

  contexte.subscriptions.push(
    vscode.commands.registerCommand("oxoai.expliquer", () => surSelection("Explique ce code, simplement et précisément :")),
    vscode.commands.registerCommand("oxoai.ameliorer", () =>
      surSelection("Améliore ce code (clarté, bugs, performances). Donne la version corrigée dans un seul bloc de code, puis ce que tu as changé :"),
    ),
    vscode.commands.registerCommand("oxoai.nouveau", () => vue.nouveau()),
    vscode.commands.registerCommand("oxoai.seConnecter", () => seConnecter(contexte)),
    vscode.commands.registerCommand("oxoai.seDeconnecter", async () => {
      await contexte.secrets.delete(cleSeance());
      vscode.window.showInformationMessage("Déconnecté de OxoAI.");
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
