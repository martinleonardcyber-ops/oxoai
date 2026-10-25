import { request as requeteHttps } from "node:https";
import type { IncomingMessage } from "node:http";
import { db, type StoredCollection } from "./db.ts";
import { chiffrer, dechiffrer, chiffrementActif } from "./secret.ts";
import { nomProduit, NomProduit } from "./marque.ts";
import { lister, t, tf } from "./langue.ts";
import * as agendaGoogle from "./agendaGoogle.ts";

/**
 * Connecteur agenda de OxoAI, en CalDAV.
 *
 * Pourquoi CalDAV et pas l'API Google Agenda : OxoAI se vend à des PME
 * françaises sur l'argument de la souveraineté. Un connecteur Google Agenda ne
 * servirait qu'un fournisseur américain et lierait le produit à des conditions
 * d'API révocables. CalDAV est un protocole ouvert (RFC 4791, posé sur WebDAV
 * et HTTP) : le même code atteint Google Agenda, iCloud, Infomaniak, OVH,
 * Nextcloud, Zimbra et tout serveur auto-hébergé. Un seul connecteur, aucune
 * dépendance à un tiers, et rien à faire signer à personne.
 *
 * Sur l'authentification : Google a coupé l'authentification basique en mars
 * 2025, mais les mots de passe d'application restent l'exception explicite et
 * fonctionnent pour CalDAV. C'est vérifié auprès de Google et consigné dans
 * PROJET.md ; on ne le redécouvrira pas.
 *
 * Pourquoi le client est écrit ici plutôt qu'emprunté : la passerelle n'utilise
 * que la bibliothèque standard de Node. Une bibliothèque CalDAV tierce, c'est
 * un arbre de dépendances qui lit tout l'agenda de l'entreprise et que personne
 * dans l'équipe n'a relu. Le XML de WebDAV et l'iCalendar sont deux formats
 * texte : un analyseur minimal et tolérant suffit, il ne s'agit pas d'écrire
 * une bibliothèque générale.
 *
 * ⚠ LECTURE SEULE, et ce n'est pas négociable. Aucune méthode d'écriture n'est
 * implémentée : ni PUT, ni DELETE, ni MKCALENDAR, ni PROPPATCH, ni POST de
 * planification. Seuls PROPFIND et REPORT sont émis, qui sont les deux verbes
 * de consultation de WebDAV. Un agent lit l'agenda, il ne le modifie pas :
 * déplacer une réunion engage des gens, et une erreur de modèle y est visible
 * par tout le monde. Toute évolution de ce fichier qui ajouterait une écriture
 * doit être traitée comme un changement de périmètre du produit, pas comme une
 * amélioration technique.
 *
 * Le motif d'exposition reprend celui de courrier.ts : `toolsForModel()` et
 * `callTool()`, fusionnés dans la boucle de conversation par chat.ts.
 */

/* --------------------------------- réglages ---------------------------------- */

export interface CompteAgenda {
  /** URL de départ : principal, dossier d'agendas, ou racine du serveur. */
  url: string;
  identifiant: string;
  /** Ne sort jamais de ce module. */
  motDePasse: string;
  /**
   * Agendas retenus, par leur nom affiché. Liste vide : tous.
   * Un compte professionnel expose souvent une dizaine d'agendas partagés dont
   * l'agent n'a rien à faire ; les interroger tous coûte autant de requêtes.
   */
  retenus: string[];
}

/** Un agenda découvert sur le serveur. */
export interface Calendrier {
  nom: string;
  url: string;
  /** Couleur déclarée par le serveur (extension Apple), vide si absente. */
  couleur: string;
}

/** Ce que l'interface a le droit de savoir. Jamais le mot de passe. */
export interface EtatAgenda {
  /** Un compte CalDAV est enregistré (ce formulaire). */
  configure: boolean;
  /** Un agenda est branché, par CalDAV ou par Google Agenda (agendaGoogle.ts). */
  branche: boolean;
  url?: string;
  identifiant?: string;
  /** Horodatage ISO de l'enregistrement, pour afficher « configuré le… ». */
  depuis?: string;
  /** Agendas vus au moment de la configuration, pour l'affichage. */
  calendriers?: Calendrier[];
  /** Noms retenus. Vide : tous. */
  retenus?: string[];
  /** Le magasin chiffre-t-il réellement au repos sur cette machine ? */
  chiffrementDonnees: boolean;
}

export interface ServeurConnu {
  /** Nom affiché dans le formulaire. */
  nom: string;
  /**
   * URL utilisable telle quelle. Vide quand la valeur n'a pas pu être vérifiée :
   * mieux vaut un champ vide qu'une adresse fausse, qui ferait perdre une heure
   * à l'utilisateur avant qu'il ne pense à la mettre en doute.
   */
  url: string;
  /**
   * Gabarit à compléter, avec `{adresse}` pour l'adresse de la personne.
   * Vide quand il n'y en a pas.
   */
  gabarit: string;
  /** Domaines d'adresse qui désignent ce serveur. */
  domaines: string[];
  /** Consigne à montrer à l'utilisateur avant qu'il ne cherche son mot de passe. */
  conseil: string;
}

/**
 * Serveurs CalDAV usuels.
 *
 * ⚠ Ces valeurs sont celles publiées par les éditeurs au moment où ce fichier a
 * été écrit, et elles changent : un hébergeur renomme un serveur, un autre
 * déplace un chemin. Elles ne servent qu'à pré-remplir le formulaire à partir
 * du domaine de l'adresse. La saisie manuelle reste toujours possible et prime
 * sur cette table.
 *
 * Deux entrées portent volontairement une URL vide, Infomaniak et OVH. Leur
 * adresse CalDAV n'a pas pu être vérifiée avec certitude : chez Infomaniak
 * l'URL de base seule ne suffit pas à la découverte, et chez OVH elle dépend de
 * l'offre souscrite (Zimbra ou MX Plan, qui n'expose pas d'agenda). Une valeur
 * fausse coûte plus cher qu'une valeur absente : le conseil dit où la trouver.
 */
const SERVEURS: ServeurConnu[] = [
  {
    nom: "Google Agenda",
    url: "",
    // Documenté par Google : l'URL de principal est .../caldav/v2/<identifiant
    // d'agenda>/user, et l'identifiant de l'agenda principal est l'adresse.
    gabarit: "https://apidata.googleusercontent.com/caldav/v2/{adresse}/user",
    domaines: ["gmail.com", "googlemail.com"],
    /*
     * Essayé le 26/09/2026 sur un vrai compte : un mot de passe d'application
     * que Google accepte pour Gmail (IMAP) est refusé par son CalDAV. Google
     * n'ouvre ses agendas qu'avec sa propre connexion (OAuth). Le conseil
     * disait l'inverse ; il dit maintenant ce qui a été constaté.
     */
    conseil:
      "Google n'accepte pas de mot de passe d'application pour ses agendas (essayé : refusé, alors " +
      "qu'il l'accepte pour Gmail). Il n'ouvre Google Agenda qu'avec sa propre connexion, qui n'est " +
      "pas encore disponible pour l'agenda dans ce logiciel.",
  },
  {
    nom: "iCloud",
    url: "https://caldav.icloud.com/",
    gabarit: "",
    domaines: ["icloud.com", "me.com", "mac.com"],
    conseil:
      "L'identifiant est votre identifiant Apple. Le mot de passe doit être un mot de passe " +
      "pour application, créé depuis la gestion de votre compte Apple.",
  },
  {
    nom: "Infomaniak",
    url: "",
    gabarit: "",
    domaines: ["infomaniak.com", "ik.me", "etik.com", "ikmail.com"],
    conseil:
      "L'adresse de synchronisation d'Infomaniak contient votre identifiant et celui de " +
      "l'agenda : récupérez-la sur config.infomaniak.com, qui vous propose aussi de créer " +
      "le mot de passe d'application nécessaire si la double authentification est active.",
  },
  {
    nom: "OVH",
    url: "",
    gabarit: "",
    domaines: [],
    conseil:
      "Chez OVH l'agenda dépend de l'offre : les comptes Zimbra exposent CalDAV, les comptes " +
      "MX Plan n'ont pas d'agenda. Prenez l'adresse indiquée dans votre espace client, ou " +
      "auprès de votre service informatique.",
  },
  {
    nom: "Nextcloud",
    url: "",
    // Chemin stable, documenté par Nextcloud. Seul le nom d'hôte change.
    gabarit: "https://VOTRE-SERVEUR/remote.php/dav/",
    domaines: [],
    conseil:
      "Sur Nextcloud, l'adresse est https://votre-serveur/remote.php/dav/ : remplacez " +
      "« votre-serveur » par le nom de votre installation. Si la double authentification " +
      "est active, créez un mot de passe d'application dans vos réglages de sécurité.",
  },
];

/** Table complète, pour un menu déroulant dans le formulaire. */
export function serveursConnus(): ServeurConnu[] {
  // Le conseil est affiché : traduit au moment de le servir (scripts/i18n-passerelle.mjs le relève).
  return SERVEURS.map((s) => ({ ...s, conseil: t(s.conseil), domaines: [...s.domaines] }));
}

/**
 * Devine le serveur à partir d'une adresse ou d'un domaine.
 * `null` quand le domaine n'est pas connu : c'est le cas ordinaire d'un domaine
 * d'entreprise, où l'utilisateur saisit lui-même son adresse CalDAV.
 */
export function reglagesConnus(adresseOuDomaine: string): ServeurConnu | null {
  const brut = String(adresseOuDomaine ?? "").trim().toLowerCase();
  if (!brut) return null;
  const domaine = brut.includes("@") ? brut.slice(brut.lastIndexOf("@") + 1) : brut;
  if (!domaine) return null;
  const trouve = SERVEURS.find((s) => s.domaines.includes(domaine));
  return trouve ? { ...trouve, domaines: [...trouve.domaines] } : null;
}

/* --------------------------------- limites ----------------------------------- */

/**
 * Toutes les bornes du module au même endroit.
 *
 * Un agenda professionnel de dix ans pèse plusieurs dizaines de mégaoctets. Le
 * connecteur ne télécharge donc jamais un agenda entier : chaque lecture passe
 * par un `REPORT` filtré sur une période, et le lecteur refuse de son côté
 * toute réponse qui dépasserait le plafond, même si le serveur l'envoie.
 */
const LIMITES = {
  /** Corps de réponse conservé en mémoire. Au-delà, la requête est abandonnée. */
  reponse: 4 * 1024 * 1024,
  /** Établissement de la connexion et inactivité. */
  delaiMs: 20_000,
  /** Redirections suivies. Apple renvoie vers un serveur de partition. */
  redirections: 5,
  /** Agendas interrogés en une fois. Au-delà, on s'arrête et on le dit. */
  calendriersMax: 20,
  /** Événements rendus par un appel d'outil. */
  evenementsMax: 60,
  /** Période demandée par « agenda__prochains », en jours. */
  joursDefaut: 7,
  joursMax: 90,
  /** Amplitude maximale d'une recherche, en jours. */
  rechercheJoursMax: 366,
  /** Description rendue par événement. */
  description: 400,
  /** Longueur d'un critère venu du modèle. */
  critere: 200,
  /** Profondeur d'imbrication XML acceptée : au-delà, le document est hostile. */
  profondeurXml: 60,
  /** Durée de validité de la découverte en mémoire. */
  cacheMs: 10 * 60 * 1000,
} as const;

/** Erreur du protocole ou du transport, sans jamais transporter de secret. */
class ErreurAgenda extends Error {
  readonly categorie: "reseau" | "authentification" | "protocole" | "serveur";
  constructor(categorie: ErreurAgenda["categorie"], message: string) {
    super(message);
    this.name = "ErreurAgenda";
    this.categorie = categorie;
  }
}

/* ------------------------------ échappement XML ------------------------------- */

/**
 * Échappe une valeur avant de l'insérer dans un corps XML.
 *
 * C'est la seule défense contre l'injection d'éléments, et elle est exportée
 * pour être éprouvée par un test. Les cinq caractères sont traités, dans cet
 * ordre : l'esperluette d'abord, sinon les entités produites par les
 * remplacements suivants seraient elles-mêmes ré-échappées.
 *
 * Le `>` n'est obligatoire qu'après `]]`, mais on l'échappe toujours : un
 * critère contenant « ]]> » ne doit pas pouvoir refermer une section CDATA que
 * l'on n'écrit pas aujourd'hui mais qu'un successeur pourrait écrire demain.
 */
export function echapperXml(valeur: string): string {
  return valeur
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Chaîne venue du modèle, donc d'une source non fiable.
 *
 * Les caractères de contrôle sont refusés plutôt que filtrés : ils n'ont aucun
 * sens dans un titre de réunion, XML 1.0 en interdit la plupart, et un refus
 * net vaut mieux qu'un nettoyage silencieux dont personne ne connaît la règle.
 * Échec fermé : ce qui n'est pas compris est rejeté.
 */
export function critere(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const t = valeur.trim();
  if (t.length === 0) return null;
  // Plage C0, DEL, plage C1, et les deux non-caractères interdits par XML 1.0.
  if (/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/.test(t)) return null;
  return t.slice(0, LIMITES.critere);
}

/* ------------------------- analyseur XML minimal ------------------------------ */

/*
 * Ce n'est pas un analyseur XML général, et il ne doit pas le devenir. Il lit
 * ce que produisent les serveurs WebDAV : des documents plats, sans DTD, sans
 * entité déclarée, dont on ne veut que quelques éléments identifiés par leur
 * espace de noms. Les entités externes ne sont pas résolues, ce qui écarte
 * d'emblée la classe d'attaques « XXE ».
 */

const DAV = "DAV:";
const CAL = "urn:ietf:params:xml:ns:caldav";
const APPLE = "http://apple.com/ns/ical/";

interface Noeud {
  /** URI de l'espace de noms, résolu depuis les préfixes. */
  ns: string;
  /** Nom local, en minuscules : les serveurs ne s'accordent pas sur la casse. */
  nom: string;
  attrs: Record<string, string>;
  enfants: Noeud[];
  /** Texte propre au nœud, entités décodées. */
  texte: string;
}

function decoderEntites(texte: string): string {
  if (!texte.includes("&")) return texte;
  return texte.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (tout, corps: string) => {
    if (corps.startsWith("#x") || corps.startsWith("#X")) {
      const n = Number.parseInt(corps.slice(2), 16);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : tout;
    }
    if (corps.startsWith("#")) {
      const n = Number.parseInt(corps.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : tout;
    }
    switch (corps) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return tout;
    }
  });
}

/** Fin d'une balise, en ignorant les `>` contenus dans un attribut entre guillemets. */
function finDeBalise(source: string, debut: number): number {
  let guillemet = "";
  for (let i = debut + 1; i < source.length; i++) {
    const c = source[i]!;
    if (guillemet) {
      if (c === guillemet) guillemet = "";
    } else if (c === '"' || c === "'") {
      guillemet = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

const ATTRIBUT = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributsDe(contenu: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTRIBUT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUT.exec(contenu)) !== null) {
    out[m[1]!] = decoderEntites(m[2] ?? m[3] ?? "");
  }
  return out;
}

/**
 * Analyse un document XML de réponse WebDAV.
 *
 * Rend un nœud racine fictif dont les enfants sont les éléments de premier
 * niveau. `null` si rien d'exploitable n'a été trouvé : l'appelant décide alors
 * quoi dire à l'utilisateur, il ne reçoit pas un arbre à moitié construit.
 */
function analyserXml(source: string): Noeud | null {
  const racine: Noeud = { ns: "", nom: "#racine", attrs: {}, enfants: [], texte: "" };
  const pile: { noeud: Noeud; prefixes: Map<string, string> }[] = [
    { noeud: racine, prefixes: new Map([["", ""]]) },
  ];

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;
    if (lt > i) {
      pile[pile.length - 1]!.noeud.texte += decoderEntites(source.slice(i, lt));
    }

    if (source.startsWith("<!--", lt)) {
      const fin = source.indexOf("-->", lt + 4);
      i = fin === -1 ? source.length : fin + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const fin = source.indexOf("]]>", lt + 9);
      const brut = source.slice(lt + 9, fin === -1 ? source.length : fin);
      pile[pile.length - 1]!.noeud.texte += brut;
      i = fin === -1 ? source.length : fin + 3;
      continue;
    }
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) {
      const fin = source.indexOf(">", lt + 2);
      i = fin === -1 ? source.length : fin + 1;
      continue;
    }

    const gt = finDeBalise(source, lt);
    if (gt === -1) break;
    const brut = source.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!brut) continue;

    /* Fermeture. On dépile jusqu'au nom correspondant, sans exiger la
     * correspondance exacte : un serveur qui ferme mal ne doit pas faire perdre
     * tout le document. */
    if (brut.startsWith("/")) {
      const nom = brut.slice(1).trim().toLowerCase();
      const local = nom.includes(":") ? nom.slice(nom.indexOf(":") + 1) : nom;
      for (let p = pile.length - 1; p > 0; p--) {
        if (pile[p]!.noeud.nom === local) {
          pile.length = p;
          break;
        }
      }
      continue;
    }

    const autoFermant = brut.endsWith("/");
    const contenu = autoFermant ? brut.slice(0, -1) : brut;
    const separateur = contenu.search(/[\s/]/);
    const qualifie = (separateur === -1 ? contenu : contenu.slice(0, separateur)).trim();
    if (!qualifie) continue;

    const attrs = attributsDe(separateur === -1 ? "" : contenu.slice(separateur));
    const prefixes = new Map(pile[pile.length - 1]!.prefixes);
    for (const [cle, valeur] of Object.entries(attrs)) {
      if (cle === "xmlns") prefixes.set("", valeur);
      else if (cle.startsWith("xmlns:")) prefixes.set(cle.slice(6), valeur);
    }

    const deuxPoints = qualifie.indexOf(":");
    const prefixe = deuxPoints === -1 ? "" : qualifie.slice(0, deuxPoints);
    const local = (deuxPoints === -1 ? qualifie : qualifie.slice(deuxPoints + 1)).toLowerCase();

    const noeud: Noeud = {
      ns: prefixes.get(prefixe) ?? "",
      nom: local,
      attrs,
      enfants: [],
      texte: "",
    };
    pile[pile.length - 1]!.noeud.enfants.push(noeud);
    if (!autoFermant && pile.length < LIMITES.profondeurXml) {
      pile.push({ noeud, prefixes });
    }
  }

  return racine.enfants.length > 0 ? racine : null;
}

/** Descendants portant cet espace de noms et ce nom local, à toute profondeur. */
function tous(racine: Noeud, ns: string, nom: string): Noeud[] {
  const out: Noeud[] = [];
  const parcourir = (n: Noeud) => {
    for (const e of n.enfants) {
      if (e.ns === ns && e.nom === nom) out.push(e);
      parcourir(e);
    }
  };
  parcourir(racine);
  return out;
}

/** Premier descendant correspondant, `null` sinon. */
function premier(racine: Noeud, ns: string, nom: string): Noeud | null {
  return tous(racine, ns, nom)[0] ?? null;
}

/** Texte d'un nœud et de toute sa descendance. */
function texteDe(n: Noeud): string {
  let out = n.texte;
  for (const e of n.enfants) out += texteDe(e);
  return out;
}

/* --------------------------- analyse de l'iCalendar --------------------------- */

/*
 * RFC 5545, le minimum utile. On ne lit que VEVENT : les tâches (VTODO), les
 * disponibilités et les alarmes ne servent pas à répondre « qu'est-ce que j'ai
 * jeudi ». Les VTIMEZONE embarqués ne sont pas interprétés non plus : les
 * identifiants de fuseau sont ceux de la base IANA, qu'Intl connaît déjà.
 */

interface LigneIcal {
  nom: string;
  params: Map<string, string>;
  valeur: string;
}

/**
 * Dépliage des lignes.
 *
 * RFC 5545 : une ligne de plus de 75 octets est coupée, et la suite commence
 * par une espace ou une tabulation qu'il faut retirer. C'est la première chose
 * qui casse quand on l'oublie, et elle casse en silence : un titre long se
 * retrouve tronqué au milieu d'un mot, ou une adresse de participant coupée en
 * deux lignes illisibles.
 */
export function deplier(brut: string): string[] {
  const lignes = brut.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const ligne of lignes) {
    if ((ligne.startsWith(" ") || ligne.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += ligne.slice(1);
    } else {
      out.push(ligne);
    }
  }
  return out;
}

/** Découpe une chaîne sur un séparateur, en respectant les guillemets. */
function decouperHorsGuillemets(texte: string, separateur: string): string[] {
  const out: string[] = [];
  let courant = "";
  let enGuillemets = false;
  for (const c of texte) {
    if (c === '"') {
      enGuillemets = !enGuillemets;
      continue;
    }
    if (c === separateur && !enGuillemets) {
      out.push(courant);
      courant = "";
      continue;
    }
    courant += c;
  }
  out.push(courant);
  return out;
}

function analyserLigneIcal(ligne: string): LigneIcal | null {
  let enGuillemets = false;
  let coupure = -1;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') enGuillemets = !enGuillemets;
    else if (c === ":" && !enGuillemets) {
      coupure = i;
      break;
    }
  }
  if (coupure === -1) return null;

  const entete = ligne.slice(0, coupure);
  const valeur = ligne.slice(coupure + 1);
  const morceaux = decouperHorsGuillemets(entete, ";");
  const nom = (morceaux[0] ?? "").trim().toUpperCase();
  if (!nom) return null;

  const params = new Map<string, string>();
  for (const m of morceaux.slice(1)) {
    const egal = m.indexOf("=");
    if (egal === -1) continue;
    params.set(m.slice(0, egal).trim().toUpperCase(), m.slice(egal + 1).trim());
  }
  return { nom, params, valeur };
}

/**
 * Déséchappement des valeurs de texte (RFC 5545, § 3.3.11).
 *
 * `\,` `\;` `\n` `\\` : sans cela, « Réunion budget\, salle 2 » s'affiche avec
 * sa barre oblique inverse, et l'utilisateur croit à un bug d'encodage.
 */
export function desechapper(valeur: string): string {
  let out = "";
  for (let i = 0; i < valeur.length; i++) {
    const c = valeur[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const suivant = valeur[i + 1];
    if (suivant === undefined) break;
    i++;
    if (suivant === "n" || suivant === "N") out += "\n";
    else out += suivant; // couvre \, \; \\ et tout échappement inconnu
  }
  return out;
}

/* ------------------------------ dates et fuseaux ------------------------------ */

/** Fuseau du poste : c'est dans celui-là que le modèle doit lire les heures. */
const FUSEAU_POSTE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const zonesValides = new Map<string, boolean>();

function zoneConnue(zone: string): boolean {
  const memo = zonesValides.get(zone);
  if (memo !== undefined) return memo;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    ok = true;
  } catch {
    ok = false;
  }
  zonesValides.set(zone, ok);
  return ok;
}

/** Décalage d'un fuseau à un instant donné, en millisecondes. */
function decalageZone(zone: string, instant: number): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(instant))) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  // Certaines versions d'ICU rendent « 24 » pour minuit avec hour12: false.
  const heure = v.hour === 24 ? 0 : (v.hour ?? 0);
  const local = Date.UTC(
    v.year ?? 1970,
    (v.month ?? 1) - 1,
    v.day ?? 1,
    heure,
    v.minute ?? 0,
    v.second ?? 0,
  );
  return local - instant;
}

/**
 * Instant correspondant à une heure murale dans un fuseau donné.
 *
 * Deux passes : la première suppose le décalage de l'instant approché, la
 * seconde le corrige. C'est nécessaire autour des changements d'heure, où un
 * rendez-vous du dimanche matin se décale d'une heure si l'on s'arrête à la
 * première estimation.
 */
function instantDepuisMur(
  annee: number,
  mois: number,
  jour: number,
  heure: number,
  minute: number,
  seconde: number,
  zone: string,
): number {
  const brut = Date.UTC(annee, mois - 1, jour, heure, minute, seconde);
  const premierDecalage = decalageZone(zone, brut);
  let instant = brut - premierDecalage;
  const secondDecalage = decalageZone(zone, instant);
  if (secondDecalage !== premierDecalage) instant = brut - secondDecalage;
  return instant;
}

interface DateIcal {
  /** Instant, en millisecondes. Minuit local du poste pour une journée entière. */
  ms: number;
  /** ISO 8601 : date seule pour une journée entière, instant complet sinon. */
  iso: string;
  journeeEntiere: boolean;
  /** Le TZID annoncé est-il inconnu de ce poste ? */
  zoneInconnue: boolean;
}

/**
 * Analyse une valeur DTSTART / DTEND.
 *
 * Trois formes sont acceptées, et ce sont les trois que produisent les serveurs :
 * l'instant UTC (`20260905T140000Z`), l'heure locale accompagnée d'un TZID
 * (`TZID=Europe/Paris:20260905T140000`), et la journée entière
 * (`VALUE=DATE:20260905`). Une quatrième forme existe, l'heure « flottante »
 * sans fuseau : la RFC dit qu'elle vaut l'heure locale de celui qui regarde,
 * donc celle du poste.
 */
export function analyserDateIcal(valeur: string, params: Map<string, string>): DateIcal | null {
  const brut = valeur.trim();
  const estDate = params.get("VALUE")?.toUpperCase() === "DATE" || /^\d{8}$/.test(brut);

  if (estDate) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(brut);
    if (!m) return null;
    const annee = Number(m[1]);
    const mois = Number(m[2]);
    const jour = Number(m[3]);
    /*
     * Minuit local du poste, et non minuit UTC : une journée entière n'a pas
     * d'heure, elle a une date. La rattacher à UTC ferait afficher le 9
     * septembre à un poste réglé sur New York pour un événement du 10.
     */
    const ms = new Date(annee, mois - 1, jour, 0, 0, 0, 0).getTime();
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return { ms, iso, journeeEntiere: true, zoneInconnue: false };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(brut);
  if (!m) return null;
  const [, a, mo, j, h, mi, s, z] = m;
  const annee = Number(a);
  const mois = Number(mo);
  const jour = Number(j);
  const heure = Number(h);
  const minute = Number(mi);
  const seconde = Number(s);

  if (z === "Z") {
    const ms = Date.UTC(annee, mois - 1, jour, heure, minute, seconde);
    return { ms, iso: new Date(ms).toISOString(), journeeEntiere: false, zoneInconnue: false };
  }

  const tzid = params.get("TZID");
  if (tzid) {
    /*
     * Les TZID sont normalement des identifiants IANA (« Europe/Paris »), qu'Intl
     * connaît. Certains serveurs Exchange écrivent des noms Windows (« Romance
     * Standard Time ») ou des identifiants propres au fichier. On ne devine pas :
     * on retombe sur l'heure du poste et on le signale, plutôt que d'afficher une
     * heure fausse avec l'assurance d'une heure juste.
     */
    const propre = tzid.replace(/^\//, "");
    if (zoneConnue(propre)) {
      const ms = instantDepuisMur(annee, mois, jour, heure, minute, seconde, propre);
      return { ms, iso: new Date(ms).toISOString(), journeeEntiere: false, zoneInconnue: false };
    }
    const ms = new Date(annee, mois - 1, jour, heure, minute, seconde).getTime();
    return { ms, iso: new Date(ms).toISOString(), journeeEntiere: false, zoneInconnue: true };
  }

  // Heure flottante : l'heure de celui qui regarde, donc celle du poste.
  const ms = new Date(annee, mois - 1, jour, heure, minute, seconde).getTime();
  return { ms, iso: new Date(ms).toISOString(), journeeEntiere: false, zoneInconnue: false };
}

/** Durée ISO 8601 restreinte de la RFC 5545 (`P1DT2H30M`), en millisecondes. */
function analyserDuree(valeur: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    valeur.trim(),
  );
  if (!m) return null;
  const signe = m[1] === "-" ? -1 : 1;
  const ms =
    Number(m[2] ?? 0) * 604800000 +
    Number(m[3] ?? 0) * 86400000 +
    Number(m[4] ?? 0) * 3600000 +
    Number(m[5] ?? 0) * 60000 +
    Number(m[6] ?? 0) * 1000;
  return signe * ms;
}

/* -------------------------------- événements ---------------------------------- */

export interface Evenement {
  uid: string;
  titre: string;
  debutMs: number;
  finMs: number;
  debutIso: string;
  finIso: string;
  journeeEntiere: boolean;
  lieu: string;
  description: string;
  organisateur: string;
  participants: string[];
  /** CONFIRMED, TENTATIVE, CANCELLED, ou vide. */
  statut: string;
  /** RRULE telle quelle, vide s'il n'y en a pas. */
  recurrence: string;
  /**
   * Le serveur a-t-il dilaté la série ? Faux quand il a rendu la règle brute :
   * on affiche alors la règle et on le dit, plutôt que de calculer les
   * occurrences nous-mêmes et de se tromper sur les exceptions.
   */
  dilatee: boolean;
  zoneInconnue: boolean;
  calendrier: string;
}

/** Nettoie une adresse de participant : `mailto:jean@x.fr` devient `jean@x.fr`. */
function adresse(valeur: string): string {
  return valeur.replace(/^mailto:/i, "").trim();
}

/** Nom affichable d'un participant : le CN quand il existe, l'adresse sinon. */
function participant(ligne: LigneIcal): string {
  const cn = ligne.params.get("CN");
  const mail = adresse(desechapper(ligne.valeur));
  if (cn) {
    const propre = desechapper(cn).trim();
    return propre && propre !== mail ? `${propre} (${mail})` : mail;
  }
  return mail;
}

/**
 * Extrait les VEVENT d'un objet iCalendar.
 *
 * Un même objet peut en contenir plusieurs : c'est le cas quand le serveur a
 * dilaté une série, et c'est aussi le cas d'un événement récurrent accompagné
 * de ses exceptions. Les composants imbriqués (VALARM, VTIMEZONE) sont ignorés
 * : on ne veut ni les rappels ni les définitions de fuseau.
 */
export function analyserIcal(texte: string, calendrier: string): Evenement[] {
  const out: Evenement[] = [];
  let dans: LigneIcal[] | null = null;
  let profondeur = 0;

  for (const ligne of deplier(texte)) {
    if (!ligne) continue;
    const l = analyserLigneIcal(ligne);
    if (!l) continue;

    if (l.nom === "BEGIN") {
      const composant = l.valeur.trim().toUpperCase();
      if (composant === "VEVENT" && dans === null) {
        dans = [];
        profondeur = 0;
      } else if (dans !== null) {
        profondeur++;
      }
      continue;
    }
    if (l.nom === "END") {
      const composant = l.valeur.trim().toUpperCase();
      if (composant === "VEVENT" && dans !== null && profondeur === 0) {
        const e = construire(dans, calendrier);
        if (e) out.push(e);
        dans = null;
      } else if (dans !== null && profondeur > 0) {
        profondeur--;
      }
      continue;
    }
    // Les propriétés d'un composant imbriqué (VALARM) ne nous concernent pas.
    if (dans !== null && profondeur === 0) dans.push(l);
  }

  return out;
}

function construire(lignes: LigneIcal[], calendrier: string): Evenement | null {
  const un = (nom: string) => lignes.find((l) => l.nom === nom);
  const texte = (nom: string) => {
    const l = un(nom);
    return l ? desechapper(l.valeur).trim() : "";
  };

  const dtstart = un("DTSTART");
  if (!dtstart) return null;
  const debut = analyserDateIcal(dtstart.valeur, dtstart.params);
  if (!debut) return null;

  let fin: DateIcal | null = null;
  const dtend = un("DTEND");
  if (dtend) fin = analyserDateIcal(dtend.valeur, dtend.params);
  if (!fin) {
    const duree = un("DURATION");
    const ms = duree ? analyserDuree(duree.valeur) : null;
    if (ms !== null) {
      fin = {
        ms: debut.ms + ms,
        iso: new Date(debut.ms + ms).toISOString(),
        journeeEntiere: debut.journeeEntiere,
        zoneInconnue: debut.zoneInconnue,
      };
    }
  }
  if (!fin) {
    /*
     * Ni DTEND ni DURATION. La RFC 5545 est explicite : une journée entière dure
     * un jour, un événement horodaté a une durée nulle.
     */
    const ms = debut.journeeEntiere ? debut.ms + 86400000 : debut.ms;
    fin = {
      ms,
      iso: debut.journeeEntiere ? new Date(ms).toISOString() : debut.iso,
      journeeEntiere: debut.journeeEntiere,
      zoneInconnue: debut.zoneInconnue,
    };
  }

  const organisateurLigne = un("ORGANIZER");
  const recurrence = un("RRULE")?.valeur.trim() ?? "";
  const aUneOccurrence = lignes.some((l) => l.nom === "RECURRENCE-ID");

  return {
    uid: texte("UID"),
    titre: texte("SUMMARY"),
    debutMs: debut.ms,
    finMs: fin.ms,
    debutIso: debut.iso,
    finIso: fin.iso,
    journeeEntiere: debut.journeeEntiere,
    lieu: texte("LOCATION"),
    description: texte("DESCRIPTION"),
    organisateur: organisateurLigne ? participant(organisateurLigne) : "",
    participants: lignes.filter((l) => l.nom === "ATTENDEE").map(participant),
    statut: texte("STATUS").toUpperCase(),
    recurrence,
    // Une occurrence dilatée porte un RECURRENCE-ID et jamais de RRULE.
    dilatee: recurrence === "" || aUneOccurrence,
    zoneInconnue: debut.zoneInconnue || fin.zoneInconnue,
    calendrier,
  };
}

/* ----------------------------- rendu en français ------------------------------ */

function jourFrancais(ms: number, avecAnnee: boolean): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(avecAnnee ? { year: "numeric" as const } : {}),
    timeZone: FUSEAU_POSTE,
  }).format(new Date(ms));
}

/**
 * L'heure telle qu'on l'écrit en français : « 14 h », « 14 h 30 ».
 *
 * Le modèle doit pouvoir recopier la phrase sans rien calculer. Lui rendre
 * « 2026-09-10T12:00:00Z » l'obligerait à convertir un fuseau de tête, ce qu'un
 * petit modèle rate une fois sur trois.
 */
function heureFrancaise(ms: number): string {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: FUSEAU_POSTE,
  }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mi = parts.find((p) => p.type === "minute")?.value ?? "00";
  const heure = String(Number(h));
  return mi === "00" ? `${heure} h` : `${heure} h ${mi}`;
}

/** Même jour civil dans le fuseau du poste ? */
function memeJour(a: number, b: number): boolean {
  const f = new Intl.DateTimeFormat("fr-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: FUSEAU_POSTE,
  });
  return f.format(new Date(a)) === f.format(new Date(b));
}

function anneeCourante(ms: number): boolean {
  const f = new Intl.DateTimeFormat("fr-FR", { year: "numeric", timeZone: FUSEAU_POSTE });
  return f.format(new Date(ms)) === f.format(new Date());
}

function quand(e: Evenement): string {
  const annee = !anneeCourante(e.debutMs);

  if (e.journeeEntiere) {
    /*
     * DTEND d'une journée entière est exclusif : un événement du 10 au 10 porte
     * un DTEND au 11. On retire donc un jour pour l'affichage, sans quoi toute
     * journée entière paraîtrait durer deux jours.
     */
    const dernier = e.finMs - 86400000;
    if (dernier <= e.debutMs || memeJour(dernier, e.debutMs)) {
      return `${jourFrancais(e.debutMs, annee)}, toute la journée`;
    }
    return `du ${jourFrancais(e.debutMs, annee)} au ${jourFrancais(dernier, annee)}, toute la journée`;
  }

  if (memeJour(e.debutMs, e.finMs)) {
    if (e.finMs <= e.debutMs) return `${jourFrancais(e.debutMs, annee)} à ${heureFrancaise(e.debutMs)}`;
    return `${jourFrancais(e.debutMs, annee)}, de ${heureFrancaise(e.debutMs)} à ${heureFrancaise(e.finMs)}`;
  }
  return (
    `du ${jourFrancais(e.debutMs, annee)} à ${heureFrancaise(e.debutMs)} ` +
    `au ${jourFrancais(e.finMs, !anneeCourante(e.finMs))} à ${heureFrancaise(e.finMs)}`
  );
}

const STATUTS: Record<string, string> = {
  CANCELLED: "annulé",
  TENTATIVE: "provisoire",
  CONFIRMED: "confirmé",
};

/** Rendu texte d'un événement, pour la réponse d'outil. */
export function rendre(e: Evenement, montrerAgenda: boolean, montrerId = false): string {
  const lignes: string[] = [];
  lignes.push(e.titre || "(sans titre)");
  lignes.push(`  ${quand(e)}`);
  // L'identifiant ne sert qu'à modifier ou supprimer (Google Agenda en écriture) : montré seulement alors.
  if (montrerId && e.uid) lignes.push(`  Identifiant : ${e.uid}`);
  if (e.lieu) lignes.push(`  Lieu : ${e.lieu}`);
  if (montrerAgenda && e.calendrier) lignes.push(`  Agenda : ${e.calendrier}`);
  if (e.organisateur) lignes.push(`  Organisateur : ${e.organisateur}`);
  if (e.participants.length > 0) {
    const montres = e.participants.slice(0, 10);
    const reste = e.participants.length - montres.length;
    lignes.push(`  Participants : ${montres.join(", ")}${reste > 0 ? `, et ${reste} autre(s)` : ""}`);
  }
  if (e.statut && STATUTS[e.statut]) lignes.push(`  Statut : ${STATUTS[e.statut]}`);
  if (!e.dilatee && e.recurrence) {
    lignes.push(
      `  Série récurrente que le serveur n'a pas dilatée. Règle telle quelle : ${e.recurrence}. ` +
        "Les dates ci-dessus sont celles de la première occurrence ; les suivantes n'ont pas " +
        "été calculées, ne les invente pas.",
    );
  }
  if (e.zoneInconnue) {
    lignes.push(
      "  Fuseau horaire annoncé inconnu de ce poste : l'heure affichée est celle du poste, " +
        "elle peut être décalée.",
    );
  }
  if (e.description) {
    const d = e.description.replace(/\s+/g, " ").trim();
    const coupe = d.length > LIMITES.description ? `${d.slice(0, LIMITES.description)}…` : d;
    if (coupe) lignes.push(`  ${coupe}`);
  }
  return lignes.join("\n");
}

/* ------------------------------ client CalDAV --------------------------------- */

interface ReponseHttp {
  statut: number;
  corps: string;
  /** URL finale, après redirections : les href relatifs s'y rapportent. */
  url: URL;
  /** En-tête Location, sur une redirection seulement. */
  location?: string;
}

/**
 * Corps d'une requête PROPFIND, construits une fois pour toutes.
 *
 * Aucune de ces trois chaînes ne contient de donnée venue de l'extérieur : ce
 * sont des constantes du fichier. La seule requête qui reçoit une valeur non
 * fiable est `calendar-query`, et elle passe par `echapperXml`.
 */
const PROPFIND_PRINCIPAL =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:">' +
  "<D:prop><D:current-user-principal/><D:principal-URL/><D:resourcetype/></D:prop>" +
  "</D:propfind>";

const PROPFIND_MAISON =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
  "<D:prop><C:calendar-home-set/></D:prop>" +
  "</D:propfind>";

const PROPFIND_CALENDRIERS =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:A="http://apple.com/ns/ical/">' +
  "<D:prop>" +
  "<D:resourcetype/><D:displayname/>" +
  "<A:calendar-color/>" +
  "<C:supported-calendar-component-set/>" +
  "</D:prop>" +
  "</D:propfind>";

/** Instant au format des filtres CalDAV : toujours UTC, toujours écrit par nous. */
function horodatageCalDav(ms: number): string {
  const d = new Date(ms);
  const n = (v: number, taille = 2) => String(v).padStart(taille, "0");
  return (
    `${n(d.getUTCFullYear(), 4)}${n(d.getUTCMonth() + 1)}${n(d.getUTCDate())}` +
    `T${n(d.getUTCHours())}${n(d.getUTCMinutes())}${n(d.getUTCSeconds())}Z`
  );
}

/**
 * Corps d'un `REPORT calendar-query`.
 *
 * Deux points de sécurité, et ce sont les seuls endroits du module où une
 * donnée non fiable atteint le fil.
 *
 * Les bornes de la période ne sont jamais recopiées depuis l'entrée : elles
 * sont reconstruites par `horodatageCalDav` à partir d'un nombre. Une date
 * illisible est refusée en amont, jamais transmise.
 *
 * Le critère de recherche, lui, est du texte de l'utilisateur relayé par le
 * modèle. Il traverse `echapperXml`, si bien qu'un critère contenant `<`, `&`
 * ou `]]>` ne produit que du texte : il ne peut fabriquer ni élément, ni
 * attribut, ni fin de section.
 */
export function corpsCalendarQuery(
  debutMs: number,
  finMs: number,
  filtre: { champ: "SUMMARY" | "DESCRIPTION"; texte: string } | null,
  dilater: boolean,
): string {
  const debut = horodatageCalDav(debutMs);
  const fin = horodatageCalDav(finMs);
  const donnees = dilater
    ? `<C:calendar-data><C:expand start="${debut}" end="${fin}"/></C:calendar-data>`
    : "<C:calendar-data/>";
  const propFiltre = filtre
    ? `<C:prop-filter name="${filtre.champ}">` +
      `<C:text-match negate-condition="no">${echapperXml(filtre.texte)}</C:text-match>` +
      "</C:prop-filter>"
    : "";

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    `<D:prop><D:getetag/>${donnees}</D:prop>` +
    "<C:filter>" +
    '<C:comp-filter name="VCALENDAR">' +
    '<C:comp-filter name="VEVENT">' +
    `<C:time-range start="${debut}" end="${fin}"/>` +
    propFiltre +
    "</C:comp-filter>" +
    "</C:comp-filter>" +
    "</C:filter>" +
    "</C:calendar-query>"
  );
}

/**
 * Ce serveur sait-il dilater les séries ?
 *
 * Retenu pour le processus et non pour une connexion : un client est créé à
 * chaque appel d'outil, et sans cette mémoire chaque appel repayerait une
 * requête refusée pour redécouvrir la même chose. Remis à zéro quand le compte
 * change, puisque le serveur change avec lui.
 */
let expandRefuse = false;

class ClientCalDav {
  /*
   * Champ déclaré explicitement plutôt qu'en propriété de constructeur : Node
   * exécute le TypeScript en retirant simplement les types et refuse cette
   * forme. Même contrainte que dans db.ts et courrier.ts.
   */
  private readonly compte: CompteAgenda;

  constructor(compte: CompteAgenda) {
    this.compte = compte;
  }

  private entete(): string {
    const brut = `${this.compte.identifiant}:${this.compte.motDePasse}`;
    return `Basic ${Buffer.from(brut, "utf8").toString("base64")}`;
  }

  /**
   * Une requête HTTP, redirections comprises.
   *
   * Le certificat est vérifié (`rejectUnauthorized: true`) et il n'existe aucun
   * réglage pour l'assouplir. Une option « pour le développement » qui désactive
   * la vérification finit toujours en production, et sur un produit vendu comme
   * sécurisé elle offre le mot de passe de l'agenda au premier réseau hostile
   * venu. Un serveur au certificat auto-signé s'installe par une autorité de
   * confiance sur la machine, pas par un drapeau dans le code.
   */
  private async requete(
    methode: "PROPFIND" | "REPORT",
    cible: URL,
    corps: string,
    profondeur: "0" | "1",
  ): Promise<ReponseHttp> {
    let url = cible;
    for (let saut = 0; saut <= LIMITES.redirections; saut++) {
      const reponse = await this.emettre(methode, url, corps, profondeur);
      if (![301, 302, 303, 307, 308].includes(reponse.statut)) return reponse;

      const suite = reponse.location ?? "";
      if (!suite) return reponse;
      let prochaine: URL;
      try {
        prochaine = new URL(suite, url);
      } catch {
        throw new ErreurAgenda("protocole", t("Le serveur a renvoyé une redirection illisible."));
      }
      this.verifierRedirection(url, prochaine);
      url = prochaine;
    }
    throw new ErreurAgenda(
      "protocole",
      t("Le serveur d'agenda enchaîne trop de redirections. Vérifiez l'adresse saisie."),
    );
  }

  /**
   * Une redirection emporte l'en-tête d'authentification : on ne la suit donc
   * qu'en HTTPS, et vers le même domaine. Apple redirige `caldav.icloud.com`
   * vers `p42-caldav.icloud.com`, ce qui est légitime ; un renvoi vers un
   * domaine étranger ne l'est jamais et livrerait le mot de passe.
   */
  private verifierRedirection(depuis: URL, vers: URL): void {
    if (vers.protocol !== "https:") {
      throw new ErreurAgenda(
        "reseau",
        tf("Le serveur redirige vers une adresse non chiffrée. {0} refuse de continuer plutôt que d'y envoyer votre mot de passe.", NomProduit()),
      );
    }
    const racine = (h: string) => h.split(".").slice(-2).join(".");
    if (vers.hostname !== depuis.hostname && racine(vers.hostname) !== racine(depuis.hostname)) {
      throw new ErreurAgenda(
        "reseau",
        tf("Le serveur redirige vers un autre domaine. {0} refuse de lui transmettre vos identifiants. Vérifiez l'adresse CalDAV saisie.", NomProduit()),
      );
    }
  }

  private emettre(
    methode: string,
    cible: URL,
    corps: string,
    profondeur: string,
  ): Promise<ReponseHttp> {
    return new Promise<ReponseHttp>((ok, ko) => {
      if (cible.protocol !== "https:") {
        ko(
          new ErreurAgenda(
            "reseau",
            tf("L'adresse CalDAV doit commencer par https://. {0} n'envoie pas d'identifiants sur une liaison en clair.", NomProduit()),
          ),
        );
        return;
      }

      const charge = Buffer.from(corps, "utf8");
      let termine = false;
      const finir = (fn: () => void) => {
        if (termine) return;
        termine = true;
        fn();
      };

      const req = requeteHttps(
        {
          host: cible.hostname,
          port: cible.port || 443,
          path: `${cible.pathname}${cible.search}`,
          method: methode,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          /*
           * Pas de mise en commun des connexions : une session CalDAV laissée
           * ouverte entre deux tours se fait couper par le serveur, et le client
           * écrit ensuite dans le vide. « Connection: close » et `agent: false`
           * garantissent que la socket est refermée à chaque réponse.
           */
          agent: false,
          headers: {
            Authorization: this.entete(),
            "Content-Type": 'application/xml; charset="utf-8"',
            "Content-Length": String(charge.length),
            Depth: profondeur,
            Connection: "close",
            Accept: "application/xml, text/xml",
            // Neutre : marque blanche, le nom du produit n'a pas à figurer chez le serveur.
            "User-Agent": "Connecteur-CalDAV/1",
          },
        },
        (res: IncomingMessage) => {
          /*
           * Une redirection est renvoyée à l'appelant avec l'en-tête Location en
           * guise de corps : inutile de lire la page HTML d'accompagnement.
           */
          const statut = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(statut)) {
            const lieu = String(res.headers.location ?? "");
            // Le corps d'accompagnement ne sert à rien : on le consomme et on le jette.
            res.resume();
            const conclure = () => finir(() => ok({ statut, corps: "", url: cible, location: lieu }));
            res.on("end", conclure);
            res.on("close", conclure);
            return;
          }

          const morceaux: Buffer[] = [];
          let taille = 0;
          res.on("data", (bloc: Buffer) => {
            taille += bloc.length;
            if (taille > LIMITES.reponse) {
              res.destroy();
              finir(() =>
                ko(
                  new ErreurAgenda(
                    "serveur",
                    t("La réponse du serveur d'agenda dépasse la taille autorisée. Demandez une période plus courte, ou restreignez les agendas consultés."),
                  ),
                ),
              );
              return;
            }
            morceaux.push(bloc);
          });
          res.on("end", () =>
            finir(() =>
              ok({ statut, corps: Buffer.concat(morceaux).toString("utf8"), url: cible }),
            ),
          );
          res.on("close", () =>
            finir(() =>
              ok({ statut, corps: Buffer.concat(morceaux).toString("utf8"), url: cible }),
            ),
          );
          res.on("error", (e: Error) => finir(() => ko(this.traduireReseau(e))));
        },
      );

      req.setTimeout(LIMITES.delaiMs, () => {
        req.destroy();
        finir(() =>
          ko(new ErreurAgenda("reseau", t("Le serveur d'agenda n'a pas répondu dans le temps imparti."))),
        );
      });
      req.on("error", (e: Error) => finir(() => ko(this.traduireReseau(e))));
      req.end(charge);
    });
  }

  private traduireReseau(e: Error): ErreurAgenda {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return new ErreurAgenda("reseau", t("Nom de serveur introuvable : vérifiez son orthographe."));
    }
    if (code === "ECONNREFUSED") {
      return new ErreurAgenda("reseau", t("Connexion refusée : vérifiez l'adresse et le port."));
    }
    if (code === "ETIMEDOUT" || code === "ECONNRESET") {
      return new ErreurAgenda("reseau", t("La connexion au serveur d'agenda a été interrompue."));
    }
    if (/certificat|certificate|self.signed|CERT_|DEPTH_ZERO|ERR_TLS/i.test(`${code} ${e.message}`)) {
      return new ErreurAgenda(
        "reseau",
        tf("Le certificat du serveur n'est pas reconnu. {0} refuse de continuer plutôt que d'exposer votre mot de passe : faites installer un certificat valide, ou ajoutez l'autorité de votre entreprise au magasin de confiance de cette machine.", NomProduit()),
      );
    }
    return new ErreurAgenda("reseau", t("La connexion au serveur d'agenda a échoué."));
  }

  /** Traduit un code HTTP en phrase compréhensible, sans jamais citer la réponse. */
  private verifierStatut(statut: number): void {
    if (statut === 401 || statut === 403) {
      throw new ErreurAgenda(
        "authentification",
        t("Identifiant ou mot de passe refusé par le serveur d'agenda. Si votre compte utilise la validation en deux étapes, il vous faut un mot de passe d'application et non votre mot de passe habituel."),
      );
    }
    if (statut === 404) {
      throw new ErreurAgenda(
        "protocole",
        t("L'adresse CalDAV est introuvable sur ce serveur. Vérifiez le chemin saisi."),
      );
    }
    if (statut === 405) {
      throw new ErreurAgenda(
        "protocole",
        t("Ce serveur ne répond pas aux requêtes CalDAV à cette adresse. Vérifiez le chemin, ou demandez l'adresse de synchronisation à votre hébergeur."),
      );
    }
    if (statut >= 500) {
      throw new ErreurAgenda("serveur", t("Le serveur d'agenda a signalé une erreur interne."));
    }
    if (statut !== 207 && statut !== 200) {
      throw new ErreurAgenda(
        "protocole",
        t("Le serveur n'a pas répondu comme un serveur CalDAV. Vérifiez l'adresse saisie."),
      );
    }
  }

  /* ------------------------------ découverte ------------------------------ */

  /**
   * Trouve le principal, c'est-à-dire « qui suis-je » vu du serveur.
   *
   * Trois adresses sont essayées dans l'ordre : celle que l'utilisateur a
   * saisie, puis `/.well-known/caldav` qui est le point d'entrée normalisé, puis
   * la racine du serveur. C'est la seule façon de couvrir à la fois un
   * Nextcloud (où l'utilisateur colle `/remote.php/dav/`) et un iCloud (où il
   * colle la racine).
   */
  private async trouverPrincipal(depart: URL): Promise<URL | null> {
    const origine = `${depart.protocol}//${depart.host}`;
    const candidats = [depart, new URL("/.well-known/caldav", origine), new URL("/", origine)];
    const vus = new Set<string>();

    for (const candidat of candidats) {
      if (vus.has(candidat.href)) continue;
      vus.add(candidat.href);

      let reponse: ReponseHttp;
      try {
        reponse = await this.requete("PROPFIND", candidat, PROPFIND_PRINCIPAL, "0");
      } catch (err) {
        // Une erreur d'authentification est définitive : inutile d'insister.
        if (err instanceof ErreurAgenda && err.categorie === "authentification") throw err;
        continue;
      }
      if (reponse.statut === 401 || reponse.statut === 403) this.verifierStatut(reponse.statut);
      if (reponse.statut !== 207 && reponse.statut !== 200) continue;

      const doc = analyserXml(reponse.corps);
      if (!doc) continue;
      for (const nom of ["current-user-principal", "principal-url"]) {
        const bloc = premier(doc, DAV, nom);
        const href = bloc ? premier(bloc, DAV, "href") : null;
        const valeur = href ? texteDe(href).trim() : "";
        if (valeur) {
          try {
            return new URL(valeur, reponse.url);
          } catch {
            /* href illisible : on continue de chercher */
          }
        }
      }
    }
    return null;
  }

  /** Dossier qui contient les agendas de la personne. */
  private async trouverMaison(principal: URL): Promise<URL | null> {
    const reponse = await this.requete("PROPFIND", principal, PROPFIND_MAISON, "0");
    this.verifierStatut(reponse.statut);
    const doc = analyserXml(reponse.corps);
    if (!doc) return null;
    const bloc = premier(doc, CAL, "calendar-home-set");
    const href = bloc ? premier(bloc, DAV, "href") : null;
    const valeur = href ? texteDe(href).trim() : "";
    if (!valeur) return null;
    try {
      return new URL(valeur, reponse.url);
    } catch {
      return null;
    }
  }

  /** Agendas d'un dossier. Une profondeur de 1 suffit : on ne descend pas. */
  private async listerCalendriers(maison: URL, profondeur: "0" | "1"): Promise<Calendrier[]> {
    const reponse = await this.requete("PROPFIND", maison, PROPFIND_CALENDRIERS, profondeur);
    this.verifierStatut(reponse.statut);
    const doc = analyserXml(reponse.corps);
    if (!doc) return [];

    const out: Calendrier[] = [];
    for (const bloc of tous(doc, DAV, "response")) {
      const href = premier(bloc, DAV, "href");
      const chemin = href ? texteDe(href).trim() : "";
      if (!chemin) continue;

      const type = premier(bloc, DAV, "resourcetype");
      if (!type || !premier(type, CAL, "calendar")) continue;

      /*
       * Un agenda peut ne contenir que des tâches ou des anniversaires : la
       * propriété dit ce qu'il accepte. Absente, on suppose qu'il porte des
       * événements, comme le fait tout client CalDAV.
       */
      const composants = premier(bloc, CAL, "supported-calendar-component-set");
      if (composants) {
        const noms = tous(composants, CAL, "comp").map((c) => (c.attrs.name ?? "").toUpperCase());
        if (noms.length > 0 && !noms.includes("VEVENT")) continue;
      }

      let url: URL;
      try {
        url = new URL(chemin, reponse.url);
      } catch {
        continue;
      }

      const nomBloc = premier(bloc, DAV, "displayname");
      const nom = (nomBloc ? texteDe(nomBloc).trim() : "") || decodeURIComponent(
        url.pathname.replace(/\/$/, "").split("/").pop() ?? "Agenda",
      );
      const couleurBloc = premier(bloc, APPLE, "calendar-color");
      const couleur = couleurBloc ? texteDe(couleurBloc).trim() : "";

      out.push({ nom, url: url.href, couleur });
      if (out.length >= LIMITES.calendriersMax) break;
    }
    return out;
  }

  /**
   * Découverte complète : principal, dossier d'agendas, liste des agendas.
   *
   * Chaque étape a son repli, parce que les serveurs ne se comportent pas tous
   * pareil : Google veut qu'on parte de son principal, Nextcloud accepte le
   * dossier directement, et certains hébergeurs donnent l'URL d'un seul agenda.
   */
  async decouvrir(): Promise<Calendrier[]> {
    let depart: URL;
    try {
      depart = new URL(this.compte.url);
    } catch {
      throw new ErreurAgenda(
        "protocole",
        t("L'adresse CalDAV n'est pas une URL valide. Elle ressemble à https://serveur.example/remote.php/dav/."),
      );
    }

    const principal = await this.trouverPrincipal(depart);
    const maison = principal ? await this.trouverMaison(principal) : null;

    const essais: { cible: URL; profondeur: "0" | "1" }[] = [];
    if (maison) essais.push({ cible: maison, profondeur: "1" });
    essais.push({ cible: depart, profondeur: "1" });
    // Dernier recours : l'utilisateur a peut-être collé l'URL d'un agenda unique.
    essais.push({ cible: depart, profondeur: "0" });

    /*
     * Un échec sur l'un des essais ne doit pas interrompre les suivants : un
     * serveur qui annonce un dossier d'agendas puis répond 404 dessus existe, et
     * l'adresse saisie par l'utilisateur reste souvent la bonne. Le dernier
     * essai, lui, laisse remonter son erreur : « chemin introuvable » renseigne
     * mieux que « aucun agenda trouvé ».
     */
    for (let i = 0; i < essais.length; i++) {
      const essai = essais[i]!;
      const dernier = i === essais.length - 1;
      try {
        const trouves = await this.listerCalendriers(essai.cible, essai.profondeur);
        if (trouves.length > 0) return trouves;
      } catch (err) {
        if (dernier) throw err;
        // Une authentification refusée est définitive : inutile d'insister.
        if (err instanceof ErreurAgenda && err.categorie === "authentification") throw err;
      }
    }

    throw new ErreurAgenda(
      "protocole",
      t("Aucun agenda trouvé à cette adresse. Vérifiez le chemin CalDAV : chez certains hébergeurs il contient votre identifiant, et il se récupère depuis leur espace de configuration."),
    );
  }

  /* -------------------------------- lecture -------------------------------- */

  /**
   * Événements d'un agenda sur une période.
   *
   * Le filtre `time-range` est la raison d'être de cette méthode : sans lui, il
   * faudrait rapatrier l'agenda entier, soit dix ans de réunions pour répondre
   * « qu'est-ce que j'ai demain ». On demande aussi la dilatation des séries
   * (`expand`), et on retombe sans elle si le serveur la refuse.
   */
  async evenements(
    calendrier: Calendrier,
    debutMs: number,
    finMs: number,
    filtre: { champ: "SUMMARY" | "DESCRIPTION"; texte: string } | null,
  ): Promise<Evenement[]> {
    const url = new URL(calendrier.url);

    let reponse: ReponseHttp | null = null;
    if (!expandRefuse) {
      const corps = corpsCalendarQuery(debutMs, finMs, filtre, true);
      const essai = await this.requete("REPORT", url, corps, "1");
      if (essai.statut === 207 || essai.statut === 200) {
        reponse = essai;
      } else if (essai.statut === 401 || essai.statut === 403 || essai.statut >= 500) {
        this.verifierStatut(essai.statut);
      } else {
        // 400 le plus souvent : le serveur ne sait pas dilater. On note et on réessaie.
        expandRefuse = true;
      }
    }
    if (!reponse) {
      const corps = corpsCalendarQuery(debutMs, finMs, filtre, false);
      reponse = await this.requete("REPORT", url, corps, "1");
      this.verifierStatut(reponse.statut);
    }

    const doc = analyserXml(reponse.corps);
    if (!doc) return [];

    const out: Evenement[] = [];
    for (const donnees of tous(doc, CAL, "calendar-data")) {
      const brut = texteDe(donnees);
      if (!brut.includes("BEGIN:VEVENT")) continue;
      for (const e of analyserIcal(brut, calendrier.nom)) out.push(e);
    }
    return out;
  }
}

/* ------------------------------- configuration -------------------------------- */

/**
 * Collection interne du magasin de l'instance.
 *
 * Même raisonnement que pour le compte de courrier. La collection est
 * **interne** : elle ne figure pas dans `COLLECTIONS`, donc `isCollection()` la
 * rejette et les routes de synchronisation de index.ts ne la distribueront
 * jamais aux postes. Un mot de passe d'agenda n'a rien à faire dans une réponse
 * de synchronisation.
 *
 * Le mot de passe est en outre chiffré **une seconde fois**, ici, avant d'entrer
 * dans le magasin : l'implémentation PostgreSQL de db.ts, contrairement à celle
 * en fichiers, n'appelle pas `chiffrer`. Sans cette passe, un client déployé sur
 * PostgreSQL verrait le mot de passe en clair dans une colonne JSONB.
 */
const COLLECTION: StoredCollection = "agendaCompte";

interface CompteEnregistre {
  url: string;
  identifiant: string;
  /** Enveloppe produite par `chiffrer()`. Jamais une chaîne en clair. */
  secret: unknown;
  retenus: string[];
  /** Agendas vus à la configuration, pour l'affichage seulement. */
  calendriers: Calendrier[];
  depuis: string;
}

/**
 * Cache du compte.
 *
 * `toolsForModel()` est synchrone — c'est le contrat de chat.ts, qui construit
 * la liste d'outils au montage de la conversation — alors que la lecture du
 * magasin est asynchrone. On garde donc l'état sous la main, et `charger()`
 * permet à l'appelant de le remplir une fois au démarrage.
 */
let cache: CompteEnregistre | null | undefined;
let chargementEnCours: Promise<CompteEnregistre | null> | null = null;

/** Découverte gardée en mémoire : trois requêtes par appel d'outil, sinon. */
let calendriersCache: { quand: number; liste: Calendrier[]; source?: "caldav" | "google" } | null = null;

/** À appeler après une configuration ou un oubli : la liste d'outils change. */
export function oublierCompteAgenda(): void {
  cache = undefined;
  chargementEnCours = null;
  calendriersCache = null;
  expandRefuse = false;
}

async function lireCompte(): Promise<CompteEnregistre | null> {
  const valeur = await db().read(COLLECTION);
  if (!valeur || typeof valeur !== "object") return null;
  const c = valeur as Partial<CompteEnregistre>;
  if (!c.url || !c.identifiant || c.secret === undefined) return null;
  return {
    url: String(c.url),
    identifiant: String(c.identifiant),
    secret: c.secret,
    retenus: Array.isArray(c.retenus) ? c.retenus.map(String) : [],
    calendriers: Array.isArray(c.calendriers)
      ? c.calendriers.map((k) => ({
          nom: String((k as Calendrier).nom ?? ""),
          url: String((k as Calendrier).url ?? ""),
          couleur: String((k as Calendrier).couleur ?? ""),
        }))
      : [],
    depuis: String(c.depuis ?? ""),
  };
}

/**
 * Remplit le cache. À appeler une fois au démarrage de la passerelle : sans
 * cela, la première conversation ouverte après un redémarrage se verrait
 * proposer une liste d'outils vide alors qu'un agenda existe.
 */
export async function charger(): Promise<boolean> {
  if (cache !== undefined) return cache !== null;
  if (!chargementEnCours) chargementEnCours = lireCompte().catch(() => null);
  const compte = await chargementEnCours;
  chargementEnCours = null;
  cache = compte;
  return compte !== null;
}

function compteComplet(enregistre: CompteEnregistre): CompteAgenda {
  const clair = dechiffrer(enregistre.secret);
  if (typeof clair !== "string") {
    throw new ErreurAgenda(
      "authentification",
      t("Le mot de passe enregistré est illisible. Reconfigurez l'agenda."),
    );
  }
  return {
    url: enregistre.url,
    identifiant: enregistre.identifiant,
    motDePasse: clair,
    retenus: enregistre.retenus,
  };
}

/** Validation d'un compte reçu de l'interface. Rien n'est cru sur parole. */
function valider(
  brut: unknown,
): { ok: true; compte: CompteAgenda } | { ok: false; message: string } {
  if (!brut || typeof brut !== "object") return { ok: false, message: t("Aucun agenda fourni.") };
  const c = brut as Record<string, unknown>;
  const texte = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const url = texte(c.url);
  const identifiant = texte(c.identifiant);
  const motDePasse = typeof c.motDePasse === "string" ? c.motDePasse : "";
  const retenus = Array.isArray(c.retenus)
    ? c.retenus.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)
    : [];

  if (!url) {
    return {
      ok: false,
      message:
        t("Indiquez l'adresse CalDAV de votre agenda, par exemple https://serveur.example/remote.php/dav/."),
    };
  }
  let analysee: URL;
  try {
    analysee = new URL(url);
  } catch {
    return { ok: false, message: t("L'adresse CalDAV n'est pas une URL valide.") };
  }
  if (analysee.protocol !== "https:") {
    return {
      ok: false,
      message:
        tf("L'adresse doit commencer par https://. {0} n'envoie pas d'identifiants sur une liaison en clair, même sur un réseau interne.", NomProduit()),
    };
  }
  if (!identifiant) {
    return { ok: false, message: t("Indiquez l'identifiant de connexion, souvent l'adresse complète.") };
  }
  if (!motDePasse) {
    return {
      ok: false,
      message:
        t("Indiquez le mot de passe. Si votre compte utilise la validation en deux étapes, créez un mot de passe d'application : c'est ce qu'exigent Google et iCloud pour CalDAV."),
    };
  }

  return { ok: true, compte: { url: analysee.href, identifiant, motDePasse, retenus } };
}

/**
 * Enregistre un agenda, après l'avoir essayé.
 *
 * L'ordre compte : on se connecte, on s'authentifie et on découvre les agendas
 * **avant** d'écrire quoi que ce soit. Un compte enregistré puis inutilisable
 * est le pire des cas : l'agent se voit proposer des outils d'agenda qui
 * échouent, l'utilisateur croit son agenda branché, et personne ne sait où est
 * l'erreur. Un échec ici ne laisse aucune trace sur le disque.
 */
export async function configurer(
  brut: unknown,
): Promise<{ ok: boolean; message: string; etat?: EtatAgenda }> {
  const verdict = valider(brut);
  if (!verdict.ok) return { ok: false, message: verdict.message };

  /*
   * Refus net plutôt que dégradation silencieuse. Ailleurs dans OxoAI, une
   * donnée non chiffrable est écrite en clair en le disant ; un mot de passe
   * d'agenda, non : il ouvre le plus souvent la messagerie du même compte, et
   * il dit à qui le vole où se trouvent les gens et quand.
   */
  if (!chiffrementActif()) {
    return {
      ok: false,
      message:
        tf("Le chiffrement des données n'est pas actif sur cette machine : {0} refuse d'enregistrer un mot de passe d'agenda en clair. Déverrouillez le trousseau du compte hôte, ou réglez « chiffrement » sur « fichier » dans oxoai.config.json, puis recommencez.", nomProduit()),
    };
  }

  let calendriers: Calendrier[];
  try {
    calendriers = await new ClientCalDav(verdict.compte).decouvrir();
  } catch (err) {
    return { ok: false, message: messageUtilisateur(err) };
  }

  /* Un nom retenu qui ne correspond à aucun agenda est une erreur de saisie :
   * l'accepter donnerait un connecteur branché qui ne rend jamais rien. */
  const noms = new Set(calendriers.map((c) => c.nom));
  const inconnus = verdict.compte.retenus.filter((r) => !noms.has(r));
  if (inconnus.length > 0) {
    return {
      ok: false,
      message:
        tf("Ces agendas n'existent pas sur le serveur : {0}. Agendas disponibles : {1}.", lister(inconnus), lister(calendriers.map((c) => c.nom))),
    };
  }

  const enregistre: CompteEnregistre = {
    url: verdict.compte.url,
    identifiant: verdict.compte.identifiant,
    secret: chiffrer(verdict.compte.motDePasse),
    retenus: verdict.compte.retenus,
    calendriers,
    depuis: new Date().toISOString(),
  };

  await db().write(COLLECTION, enregistre);
  cache = enregistre;
  chargementEnCours = null;
  calendriersCache = { quand: Date.now(), liste: calendriers, source: "caldav" };
  expandRefuse = false;

  const combien = verdict.compte.retenus.length || calendriers.length;
  return {
    ok: true,
    message: tf("Agenda connecté en lecture seule : {0} calendrier(s) accessible(s).", combien),
    etat: await etat(),
  };
}

/** État affichable. Le mot de passe n'y figure sous aucune forme. */
export async function etat(): Promise<EtatAgenda> {
  await charger();
  const compte = cache ?? null;
  // Un agenda branché par l'un ou l'autre chemin : c'est ce que les suggestions et les réunions regardent.
  const google = await agendaGoogle.charger();
  if (!compte) return { configure: false, branche: google, chiffrementDonnees: chiffrementActif() };
  return {
    configure: true,
    branche: true,
    url: compte.url,
    identifiant: compte.identifiant,
    depuis: compte.depuis,
    calendriers: compte.calendriers,
    retenus: compte.retenus,
    chiffrementDonnees: chiffrementActif(),
  };
}

/** Efface la configuration. Les outils disparaissent de la conversation suivante. */
export async function oublier(): Promise<{ ok: true; message: string }> {
  await db().write(COLLECTION, null);
  cache = null;
  chargementEnCours = null;
  calendriersCache = null;
  expandRefuse = false;
  return { ok: true, message: t("L'agenda a été retiré de cette instance.") };
}

/**
 * Message destiné à l'utilisateur ou au modèle.
 *
 * Le tri se fait ici, à la sortie : une erreur inconnue devient une phrase
 * neutre. Laisser passer l'erreur brute ferait tôt ou tard apparaître une
 * adresse de serveur, un extrait de réponse, voire un identifiant dans une
 * bulle de conversation ou dans un journal. Aucun titre de réunion, aucune
 * heure et aucun participant ne passent par ici non plus.
 */
function messageUtilisateur(err: unknown): string {
  if (err instanceof ErreurAgenda) return err.message;
  // Google Agenda (agendaGoogle.ts) a ses propres erreurs, déjà écrites pour la personne.
  if (!cache && agendaGoogle.connecte()) return agendaGoogle.messageUtilisateur(err);
  return t("La connexion au serveur d'agenda a échoué. Vérifiez l'adresse, l'identifiant et le mot de passe.");
}

/* ---------------------------------- outils ------------------------------------ */

/**
 * Liste vide tant qu'aucun agenda n'est configuré.
 *
 * Proposer à un modèle des outils qui échoueront le pousse à s'acharner dessus,
 * tour après tour, au lieu de dire à l'utilisateur qu'il n'a pas d'agenda
 * branché. Même motif que courrier.ts : un cache consulté sans attendre, et
 * `oublierCompteAgenda()` pour l'invalider après une configuration.
 */
export function toolsForModel(): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  if (cache === undefined) {
    // Premier appel avant `charger()` : on lance la lecture pour le tour suivant.
    void charger();
  }
  /*
   * Deux chemins vers un agenda : CalDAV (ce module), ou Google Agenda par la
   * connexion Google (agendaGoogle.ts, ajouté le 26/09/2026 : Google refuse
   * les mots de passe d'application pour ses agendas). Les outils sont les
   * mêmes ; CalDAV l'emporte quand les deux sont branchés.
   */
  const caldav = cache !== undefined && cache !== null;
  if (!caldav && !agendaGoogle.connecte()) return [];

  const fn = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({
    type: "function" as const,
    function: {
      name: `agenda__${name}`,
      description,
      parameters: { type: "object", properties, required },
    },
  });

  const calendrier = {
    type: "string",
    description:
      "Nom d'un agenda précis. À omettre pour consulter tous les agendas, ce qui convient " +
      "presque toujours.",
  };

  return [
    fn(
      "prochains",
      "Liste les événements à venir, du plus proche au plus lointain. Les dates et les heures " +
        "rendues sont déjà écrites en français et dans le fuseau de ce poste : recopie-les " +
        "telles quelles, ne les recalcule pas.",
      {
        jours: {
          type: "number",
          description: `Nombre de jours à couvrir à partir de maintenant, ${LIMITES.joursDefaut} par défaut, ${LIMITES.joursMax} au maximum.`,
        },
        calendrier,
      },
    ),
    fn(
      "jour",
      "Liste les événements d'une journée précise, du matin au soir.",
      {
        date: { type: "string", description: "Jour à consulter, au format AAAA-MM-JJ." },
        calendrier,
      },
      ["date"],
    ),
    fn(
      "chercher",
      "Cherche des événements dont le titre ou la description contient un texte, sur une " +
        "période. Sans période, la recherche couvre les 90 prochains jours ; pour chercher " +
        "dans le passé, donne « depuis ».",
      {
        texte: { type: "string", description: "Texte recherché dans le titre ou la description." },
        depuis: { type: "string", description: "Début de la période, au format AAAA-MM-JJ." },
        jusqu_a: { type: "string", description: "Fin de la période, au format AAAA-MM-JJ." },
        calendrier,
      },
      ["texte"],
    ),
    /*
     * Écrire : seulement sur Google Agenda branché en écriture (agendaGoogle.ts),
     * et chaque appel passe par une carte d'accord (approbation.ts). Le CalDAV
     * reste en lecture seule.
     */
    ...(!caldav && agendaGoogle.ecritureActive()
      ? [
          fn(
            "creer",
            `Crée un événement dans Google Agenda, une seule fois. Aujourd'hui, nous sommes le ${agendaGoogle.aujourdhui()} : ` +
              "calcule « demain », « lundi prochain »… à partir de cette date. Personne n'est invité et aucun courriel ne part.",
            {
              titre: { type: "string", description: "Nom de l'événement." },
              debut: { type: "string", description: "AAAA-MM-JJTHH:MM (heure de ce poste), ou AAAA-MM-JJ pour une journée entière." },
              fin: { type: "string", description: "Même format que le début. À omettre : une heure après le début (ou la journée)." },
              lieu: { type: "string", description: "Lieu, facultatif." },
              description: { type: "string", description: "Description, facultative." },
              calendrier,
            },
            ["titre", "debut"],
          ),
          fn(
            "modifier",
            `Modifie un événement existant de Google Agenda, désigné par l'identifiant donné par agenda__prochains, agenda__jour ou agenda__chercher. Seuls les champs donnés changent. Aujourd'hui : ${agendaGoogle.aujourdhui()}.`,
            {
              identifiant: { type: "string", description: "Identifiant de l'événement, recopié tel quel." },
              titre: { type: "string" },
              debut: { type: "string", description: "AAAA-MM-JJTHH:MM ou AAAA-MM-JJ." },
              fin: { type: "string", description: "Même format que le début." },
              lieu: { type: "string" },
              description: { type: "string" },
              calendrier,
            },
            ["identifiant"],
          ),
          fn(
            "supprimer",
            "Supprime un événement de Google Agenda, désigné par son identifiant. Irréversible : la personne le confirme à chaque fois.",
            { identifiant: { type: "string", description: "Identifiant de l'événement, recopié tel quel." }, calendrier },
            ["identifiant"],
          ),
        ]
      : []),
  ];
}

export function hasTools(): boolean {
  return (cache !== undefined && cache !== null) || agendaGoogle.connecte();
}

const refus = (message: string) => ({ ok: false, content: message });

/** Borne un nombre venu du modèle, qui écrit parfois « 3650 » sans y penser. */
function borner(valeur: unknown, defaut: number, max: number): number {
  const n = Math.trunc(Number(valeur));
  if (!Number.isFinite(n) || n <= 0) return defaut;
  return Math.min(n, max);
}

/**
 * Traduit une date AAAA-MM-JJ en minuit local du poste.
 *
 * La date n'est jamais recopiée depuis l'entrée : on en extrait trois nombres,
 * et c'est à partir d'eux qu'on reconstruit un instant. Une date illisible est
 * refusée, jamais transmise. Elle finit dans un attribut XML, et c'est
 * précisément le genre de valeur qu'on ne relaie pas telle quelle.
 */
function minuitLocal(valeur: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valeur.trim());
  if (!m) return null;
  const annee = Number(m[1]);
  const mois = Number(m[2]);
  const jour = Number(m[3]);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
  const d = new Date(annee, mois - 1, jour, 0, 0, 0, 0);
  // Le 31 février se replie sur le 3 mars : on refuse plutôt que de deviner.
  if (d.getFullYear() !== annee || d.getMonth() !== mois - 1 || d.getDate() !== jour) return null;
  return d.getTime();
}

/** Comparaison insensible à la casse et aux accents, pour un public francophone. */
function normaliser(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Ce que les outils demandent à un agenda, par CalDAV ou par Google. */
type ClientAgenda = Pick<ClientCalDav, "decouvrir" | "evenements">;

/** Un agenda est-il branché, par l'un ou l'autre chemin ? */
async function agendaBranche(): Promise<boolean> {
  return (await charger()) || (await agendaGoogle.charger());
}

/** Ouvre une session, exécute, et ne laisse aucune connexion ouverte derrière. */
async function avecClient<T>(action: (client: ClientAgenda, source: "caldav" | "google") => Promise<T>): Promise<T> {
  await charger();
  if (cache) return action(new ClientCalDav(compteComplet(cache)), "caldav");
  if (await agendaGoogle.charger()) return action(new agendaGoogle.ClientGoogleAgenda(), "google");
  throw new ErreurAgenda("authentification", t("Aucun agenda n'est configuré."));
}

/** Agendas à interroger, découverte mise en cache et filtre du modèle appliqué. */
async function calendriersRetenus(
  client: ClientAgenda,
  demande: string | null,
  source: "caldav" | "google" = "caldav",
): Promise<{ ok: true; liste: Calendrier[] } | { ok: false; message: string }> {
  // La liste en cache est celle d'un chemin : passer de CalDAV à Google (ou l'inverse) la relit.
  if (!calendriersCache || calendriersCache.source !== source || Date.now() - calendriersCache.quand > LIMITES.cacheMs) {
    calendriersCache = { quand: Date.now(), liste: await client.decouvrir(), source };
  }
  let liste = calendriersCache.liste;

  const retenus = cache?.retenus ?? [];
  if (retenus.length > 0) {
    const garder = new Set(retenus.map(normaliser));
    liste = liste.filter((c) => garder.has(normaliser(c.nom)));
  }

  if (demande) {
    const cible = normaliser(demande);
    const filtre = liste.filter((c) => normaliser(c.nom).includes(cible));
    if (filtre.length === 0) {
      return {
        ok: false,
        message:
          tf("Aucun agenda ne s'appelle « {0} ». Agendas disponibles : {1}. Omets « calendrier » pour tous les consulter.", demande, liste.map((c) => c.nom).join(", ") || "aucun"),
      };
    }
    liste = filtre;
  }

  if (liste.length === 0) {
    return { ok: false, message: t("Aucun agenda accessible sur ce compte.") };
  }
  return { ok: true, liste: liste.slice(0, LIMITES.calendriersMax) };
}

/** Rassemble, dédoublonne et trie les événements de plusieurs agendas. */
function assembler(lots: Evenement[][], debutMs: number, finMs: number): Evenement[] {
  const vus = new Set<string>();
  const out: Evenement[] = [];
  for (const lot of lots) {
    for (const e of lot) {
      /*
       * Un serveur peut rendre le même objet deux fois, et une série non
       * dilatée revient à chaque agenda partagé. La clé mêle l'identifiant et
       * le début : deux occurrences d'une même série sont bien deux événements.
       */
      const cle = `${e.calendrier}|${e.uid}|${e.debutIso}`;
      if (vus.has(cle)) continue;
      vus.add(cle);
      /*
       * Un serveur qui ne sait pas dilater rend le maître de la série, dont le
       * DTSTART est souvent hors période. On le garde quand même, avec sa règle,
       * plutôt que de calculer les occurrences et de se tromper : c'est ce que
       * demande la consigne de ce module.
       */
      if (e.dilatee && (e.finMs <= debutMs || e.debutMs >= finMs)) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => a.debutMs - b.debutMs || a.titre.localeCompare(b.titre, "fr"));
  return out;
}

function rendreListe(evenements: Evenement[], periode: string, plusieurs: boolean): string {
  const ids = !cache && agendaGoogle.ecritureActive();
  const gardes = evenements.slice(0, LIMITES.evenementsMax);
  const reste = evenements.length - gardes.length;
  const suite = reste > 0 ? ` (${reste} de plus non affiché(s), restreins la période)` : "";
  return (
    `${gardes.length} événement(s) ${periode}${suite}, du plus proche au plus lointain :\n\n` +
    gardes.map((e) => rendre(e, plusieurs, ids)).join("\n\n")
  );
}

/**
 * Exécute un outil « agenda__… » appelé par le modèle.
 *
 * Tout ce qui arrive ici vient du modèle, donc d'une entrée non fiable : les
 * nombres sont bornés, les dates sont reconstruites à partir de leurs chiffres,
 * et le seul texte libre qui atteint le fil traverse `echapperXml`.
 */
export async function callTool(
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const nom = qualifiedName.replace(/^agenda__/, "");
  if (nom === "creer" || nom === "modifier" || nom === "supprimer") {
    // L'accord a déjà été donné en amont (approbation.ts) : ici, on écrit, et on dit ce qui s'est passé.
    const texte = (v: unknown) => (typeof v === "string" ? v : undefined);
    const champs = { titre: texte(args.titre), debut: texte(args.debut), fin: texte(args.fin), lieu: texte(args.lieu), description: texte(args.description) };
    try {
      const id = texte(args.identifiant) ?? "";
      const agendaNom = critere(args.calendrier);
      const message =
        nom === "creer"
          ? await agendaGoogle.creerEvenement(champs, agendaNom)
          : nom === "modifier"
            ? await agendaGoogle.modifierEvenement(id, champs, agendaNom)
            : await agendaGoogle.supprimerEvenement(id, agendaNom);
      calendriersCache = null;
      return { ok: true, content: message };
    } catch (err) {
      return refus(agendaGoogle.messageUtilisateur(err));
    }
  }
  if (nom !== "prochains" && nom !== "jour" && nom !== "chercher") {
    return refus(`Outil inconnu : ${qualifiedName}.`);
  }

  if (!(await agendaBranche())) {
    return refus(
      "Aucun agenda n'est connecté à " + nomProduit() + ". Demande à l'utilisateur de le configurer dans les " +
        "paramètres, puis reprends. N'essaie pas d'autres outils d'agenda.",
    );
  }

  const demandeCalendrier = critere(args.calendrier);

  try {
    return await avecClient(async (client, source) => {
      const agendas = await calendriersRetenus(client, demandeCalendrier, source);
      if (!agendas.ok) return refus(agendas.message);
      const plusieurs = agendas.liste.length > 1;

      if (nom === "prochains") {
        const jours = borner(args.jours, LIMITES.joursDefaut, LIMITES.joursMax);
        const debut = Date.now();
        const fin = debut + jours * 86400000;
        const lots: Evenement[][] = [];
        for (const c of agendas.liste) lots.push(await client.evenements(c, debut, fin, null));
        const evenements = assembler(lots, debut, fin);
        if (evenements.length === 0) {
          return { ok: true, content: `Aucun événement dans les ${jours} prochains jours.` };
        }
        return { ok: true, content: rendreListe(evenements, `dans les ${jours} prochains jours`, plusieurs) };
      }

      if (nom === "jour") {
        const brut = critere(args.date);
        const debut = brut ? minuitLocal(brut) : null;
        if (debut === null) {
          return refus("La date n'est pas comprise : écris-la au format AAAA-MM-JJ, par exemple 2026-09-10.");
        }
        const fin = debut + 86400000;
        const lots: Evenement[][] = [];
        for (const c of agendas.liste) lots.push(await client.evenements(c, debut, fin, null));
        const evenements = assembler(lots, debut, fin);
        const libelle = `le ${jourFrancais(debut, !anneeCourante(debut))}`;
        if (evenements.length === 0) return { ok: true, content: `Aucun événement ${libelle}.` };
        return { ok: true, content: rendreListe(evenements, libelle, plusieurs) };
      }

      // nom === "chercher"
      const texte = critere(args.texte);
      if (!texte) {
        return refus(
          "Donne « texte », le mot à chercher dans le titre ou la description. Les caractères " +
            "de contrôle ne sont pas acceptés.",
        );
      }

      const depuisBrut = critere(args.depuis);
      const jusquaBrut = critere(args.jusqu_a);
      const aujourdhui = new Date();
      const debut = depuisBrut
        ? minuitLocal(depuisBrut)
        : new Date(aujourdhui.getFullYear(), aujourdhui.getMonth(), aujourdhui.getDate()).getTime();
      if (debut === null) {
        return refus("La date « depuis » n'est pas comprise : écris-la au format AAAA-MM-JJ.");
      }
      const finDemandee = jusquaBrut ? minuitLocal(jusquaBrut) : debut + 90 * 86400000;
      if (finDemandee === null) {
        return refus("La date « jusqu_a » n'est pas comprise : écris-la au format AAAA-MM-JJ.");
      }
      if (finDemandee <= debut) {
        return refus("La date « jusqu_a » doit être postérieure à « depuis ».");
      }
      const fin = Math.min(finDemandee, debut + LIMITES.rechercheJoursMax * 86400000);

      /*
       * Deux chemins, et la raison tient à une subtilité de la RFC 4791 : la
       * collation par défaut de `text-match` est `i;ascii-casemap`, qui ne sait
       * pas replier les lettres accentuées. Un critère français comme
       * « Réunion » y serait donc mal comparé. Demander `i;unicode-casemap` se
       * fait refuser par beaucoup de serveurs, avec une erreur difficile à
       * expliquer à l'utilisateur.
       *
       * Critère purement ASCII : on laisse le serveur filtrer, sur le titre puis
       * sur la description, ce qui évite de rapatrier la période entière.
       * Critère accentué : on rapatrie la période et on filtre ici, où la
       * comparaison sait ignorer accents et casse.
       *
       * Dans les deux cas le filtrage local est réappliqué : un serveur qui
       * ignorerait le filtre ne doit pas faire remonter tout l'agenda.
       */
      const asciiSeul = !/[^\x20-\x7E]/.test(texte);
      const lots: Evenement[][] = [];
      for (const c of agendas.liste) {
        if (asciiSeul) {
          lots.push(await client.evenements(c, debut, fin, { champ: "SUMMARY", texte }));
          lots.push(await client.evenements(c, debut, fin, { champ: "DESCRIPTION", texte }));
        } else {
          lots.push(await client.evenements(c, debut, fin, null));
        }
      }

      const cible = normaliser(texte);
      const evenements = assembler(lots, debut, fin).filter(
        (e) => normaliser(e.titre).includes(cible) || normaliser(e.description).includes(cible),
      );
      const periode = `contenant « ${texte} », du ${jourFrancais(debut, true)} au ${jourFrancais(fin - 1, true)}`;
      if (evenements.length === 0) {
        return { ok: true, content: `Aucun événement ${periode}.` };
      }
      return { ok: true, content: rendreListe(evenements, periode, plusieurs) };
    });
  } catch (err) {
    return refus(messageUtilisateur(err));
  }
}

/**
 * Événements de tous les agendas retenus entre deux instants, pour les
 * réunions (reunions.ts : le bot rejoint celles qui ont un lien de visio).
 * Liste vide sans agenda branché ; une erreur de serveur remonte telle quelle.
 */
export async function evenementsEntre(debutMs: number, finMs: number): Promise<Evenement[]> {
  if (!(await agendaBranche())) return [];
  return avecClient(async (client, source) => {
    const agendas = await calendriersRetenus(client, null, source);
    if (!agendas.ok) return [];
    const lots: Evenement[][] = [];
    for (const c of agendas.liste) lots.push(await client.evenements(c, debutMs, finMs, null));
    return assembler(lots, debutMs, finMs);
  });
}
