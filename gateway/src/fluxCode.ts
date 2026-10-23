import type http from "node:http";
import { api, enMarche, ensureServer, fluxEvenements, portEnCours } from "./opencode.ts";
import { journaliser } from "./audit.ts";
import { noterSousSession } from "./sessionsCode.ts";
import { rtkSousSession } from "./rtk.ts";
import { permissionRepondueAilleurs, traiterPermissionCode, type DemandeOpenCode } from "./permissionsCode.ts";

/**
 * Le flux d'évènements de Helix Code, fabriqué par la passerelle à partir de
 * l'**ancienne** API d'OpenCode.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Helix Code ouvrait ses sessions par la nouvelle API d'OpenCode
 * (`/api/session`), et l'écran, l'extension VS Code et la ligne de commande
 * lisent son flux (`session.next.*`). Or les sessions de cette nouvelle API
 * **n'ont pas d'outils MCP**, quelle que soit la configuration : lu dans le
 * code d'OpenCode 1.18.32 (dernière version publiée au 25/09/2026), son
 * registre d'outils « v2 » ne contient que les outils livrés (apply_patch,
 * bash, edit, glob, grep, question, read, skill, todowrite, webfetch,
 * websearch, write), enregistrés un par un ; rien n'y inscrit ceux des
 * serveurs MCP, et la note de l'équipe d'OpenCode sur la branche de
 * développement le dit : « MCP and future Session-scoped registrations still
 * need an explicit canonical registration design »
 * (packages/core/src/tool/AGENTS.md). Aucun réglage, agent ni champ `tools`
 * n'y change rien. L'ancienne API, elle, ajoute les outils MCP à ceux de
 * l'agent (vérifié le 25/09/2026 : un outil d'un serveur MCP d'essai appelé
 * par Qwen3 8B dans une session `/session`, sans rien d'autre à régler).
 *
 * Les sessions de Helix Code passent donc par l'ancienne API. Mais son flux
 * (`/event`, un seul pour tout un dossier, fait de `message.part.updated`) ne
 * ressemble pas à celui que lisent les trois clients. Plutôt que de réécrire
 * trois clients, la passerelle traduit : elle écoute `/event` et rend, pour
 * chaque session, les évènements `session.next.*` que les clients connaissent
 * déjà, avec les mêmes champs, un numéro (`durable.seq`) et la reprise par
 * `after`. Seuls les évènements que les clients lisent sont fabriqués.
 *
 * ── Ce que cela change, et ce qui reste ─────────────────────────────────────
 *
 *  - L'historique rejoué à l'ouverture est celui que la passerelle a vu depuis
 *    son démarrage (en mémoire, borné), et non plus toute l'histoire gardée
 *    par OpenCode. Les clients n'en ont besoin que pour reprendre un tour en
 *    cours ; après un redémarrage de la passerelle, OpenCode redémarre aussi.
 *  - Un évènement émis pendant que la passerelle se reconnecte à `/event`
 *    (OpenCode redémarré en plein tour) est perdu ; le guet de silence des
 *    clients le signale.
 *  - Les numéros partent de l'heure du démarrage (au centième de seconde) et
 *    sont communs à toutes les sessions : un client qui reprend avec le
 *    numéro d'avant un redémarrage ne manque pas les nouveaux, tant que la
 *    passerelle a fabriqué moins de cent évènements par seconde en moyenne.
 */

/** Un évènement tel que les clients de Helix Code le lisent. */
export interface EvenementCode {
  type: string;
  data: Record<string, unknown>;
  durable?: { seq: number };
}

type Auditeur = (evenement: EvenementCode) => void;

/** Ce que la passerelle retient d'une session pour la traduire. */
interface Suivi {
  dossier: string;
  /** Messages de la personne déjà annoncés (`prompted`). */
  demandes: Set<string>;
  /** Parts de texte ou de raisonnement déjà rendues entières. */
  finies: Set<string>;
  /** Appels d'outil déjà annoncés, puis déjà terminés. */
  appels: Set<string>;
  termines: Set<string>;
  /** Un échec a déjà été dit pour ce tour : OpenCode envoie parfois deux `session.error`. */
  echecDit: boolean;
  /** Derniers évènements numérotés, pour la reprise (`after`). */
  tampon: EvenementCode[];
  octets: number;
  auditeurs: Set<Auditeur>;
  /** Dernier signe de vie envoyé pendant qu'un texte s'écrit. */
  dernierSigne: number;
  /**
   * Nature de chaque part en cours (« reasoning », « text », « tool ») : un
   * morceau (`message.part.delta`) ne dit que l'identifiant de sa part, et les
   * clients veulent savoir si l'agent réfléchit ou écrit. Vidé à chaque
   * demande.
   */
  natures: Map<string, string>;
  vu: number;
  /**
   * Un tour de l'agent est ouvert : une demande est partie (`prompted`) et
   * aucune fin n'est encore venue. Voir `auTravail`.
   */
  tourOuvert: boolean;
  /** Quand le tour s'est ouvert : un OpenCode qui ne s'est pas encore dit occupé n'est pas cru tout de suite. */
  ouvertLe: number;
}

const sessions = new Map<string, Suivi>();
const TAMPON_MAX = 2000;
const OCTETS_MAX = 2_000_000;
const SESSIONS_MAX = 200;

/**
 * Sessions de sous-agents (outil `task` d'OpenCode) → session suivie qui les a
 * lancées. OpenCode les ouvre lui-même (`session.created` avec `parentID`) ;
 * leurs évènements ne portent que leur propre identifiant. Sans ce lien, une
 * sous-tâche de plusieurs minutes n'avait qu'une ligne « task » à l'écran.
 */
const enfants = new Map<string, { parent: string; callID?: string }>();
const ENFANTS_MAX = 500;

/** La session suivie à qui rapporter ce qui se passe dans `sessionID` (elle-même, ou le parent d'un sous-agent). */
export function destinataireDe(sessionID: string): { session: string; sousTache: boolean } | undefined {
  if (sessions.has(sessionID)) return { session: sessionID, sousTache: false };
  const lien = enfants.get(sessionID);
  return lien && sessions.has(lien.parent) ? { session: lien.parent, sousTache: true } : undefined;
}

/** Voir l'en-tête : au centième de seconde, douze chiffres jusqu'en 2286. */
let numero = Math.floor(Date.now() / 10);

/**
 * La passerelle suit cette session, ouverte dans ce dossier. Appelée à la
 * création d'une session de Helix Code, avant tout envoi.
 */
export function suivreSession(sessionID: string, dossier: string): void {
  const connu = sessions.get(sessionID);
  if (connu) {
    connu.dossier = dossier;
    connu.vu = Date.now();
    return;
  }
  if (sessions.size >= SESSIONS_MAX) {
    // La session restée le plus longtemps sans évènement ni auditeur s'oublie d'abord.
    const vieille = [...sessions.entries()]
      .filter(([, s]) => s.auditeurs.size === 0)
      .sort((a, b) => a[1].vu - b[1].vu)[0];
    if (vieille) sessions.delete(vieille[0]);
  }
  sessions.set(sessionID, {
    dossier,
    demandes: new Set(),
    finies: new Set(),
    appels: new Set(),
    termines: new Set(),
    echecDit: false,
    tampon: [],
    octets: 0,
    auditeurs: new Set(),
    dernierSigne: 0,
    natures: new Map(),
    vu: Date.now(),
    tourOuvert: false,
    ouvertLe: 0,
  });
}

/**
 * Où en est le modèle d'une session, pendant qu'il lit la demande ou attend son
 * tour (attenteModele.ts) : `helix.statut`, sans numéro, jamais rejoué, comme
 * `helix.activite`. C'est ce qui tient le guet de silence des clients au
 * repos pendant une lecture de plusieurs minutes.
 */
/**
 * Fin d'un tour de l'agent principal (le modèle s'arrête sans appeler d'outil) :
 * le contrôle automatique de Helix passe derrière (controleCode.ts). Un seul
 * abonné, posé par index.ts ; les sous-agents n'en déclenchent pas.
 */
let surFin: ((sessionID: string, dossier: string) => void) | null = null;
/** Messages envoyés par Helix lui-même (relance du contrôle automatique) : les clients les suivent dans le même tour. */
const relancesHelix = new Set<string>();
export function noterRelanceHelix(messageID: string): void {
  if (relancesHelix.size > 500) relancesHelix.clear();
  relancesHelix.add(messageID);
}
export function surFinDeTour(f: (sessionID: string, dossier: string) => void): void {
  surFin = f;
}

export function publierStatut(sessionID: string, donnees: Record<string, unknown>): void {
  const suivi = sessions.get(sessionID);
  if (suivi) publier(sessionID, suivi, "helix.statut", donnees, false);
}

/**
 * Ce qu'un appel d'outil a d'utile à montrer, sans son contenu : le chemin, le
 * motif, la première ligne d'une commande, la description d'une sous-tâche.
 * Un fichier écrit par un sous-agent n'a pas à traverser le flux en entier.
 */
function cibleCourte(entree: unknown): Record<string, string> {
  const e = (entree ?? {}) as Record<string, unknown>;
  const garde: Record<string, string> = {};
  for (const cle of ["filePath", "path", "pattern", "url", "description", "subagent_type"]) {
    if (typeof e[cle] === "string") garde[cle] = (e[cle] as string).slice(0, 300);
  }
  if (typeof e.command === "string") garde.command = e.command.split("\n")[0]!.slice(0, 200);
  return garde;
}

/**
 * Un évènement d'un sous-agent, rapporté à la session qui l'a lancé : ses
 * appels d'outils (`helix.soustache`) et ses signes de vie. Rien de son texte :
 * le sous-agent rend un seul message à l'agent principal, qui le résume.
 */
function traduireEnfant(
  enfant: string,
  lien: { parent: string; callID?: string },
  type: string | undefined,
  p: Record<string, unknown>,
): void {
  const suivi = sessions.get(lien.parent);
  if (!suivi) return;
  if (type === "message.part.delta") {
    if (Date.now() - suivi.dernierSigne < 1000) return;
    suivi.dernierSigne = Date.now();
    publier(lien.parent, suivi, "helix.activite", { sousTache: true }, false);
    return;
  }
  if (type !== "message.part.updated") return;
  const part = (p.part ?? {}) as PartV1;
  if (part.type !== "tool") return;
  const etat = part.state ?? {};
  if (etat.status === "pending" || !etat.status) return;
  publier(
    lien.parent,
    suivi,
    "helix.soustache",
    {
      sousSession: enfant,
      ...(lien.callID ? { parentCallID: lien.callID } : {}),
      callID: part.callID ?? part.id ?? "",
      tool: part.tool ?? "outil",
      input: cibleCourte(etat.input),
      etat: etat.status === "completed" ? "fini" : etat.status === "error" ? "echec" : "encours",
    },
    false,
  );
}

export const sessionSuivie = (sessionID: string): boolean => sessions.has(sessionID);

/*
 * Une session de Code travaille-t-elle encore ? (27/09/2026)
 *
 * Vu par Medhi : « quand on quitte la conversation, le message se retire, donc
 * on a l'impression qu'il ne travaille plus ». L'écran qui revient sur une
 * session demande à l'instance si l'agent y travaille, et la liste des
 * sessions le montre. Demander seulement à OpenCode (`/session/status`) ne
 * suffit pas : pendant que Helix prépare une application ou un plan, contrôle
 * le code écrit ou attend que la demande atteigne le modèle, OpenCode est au
 * repos, et c'est pourtant du travail de cette session (plusieurs minutes avec
 * un petit modèle). La passerelle tient donc les deux : le travail de Helix
 * (`travailHelix`, compté, rendu par qui l'a pris) et le tour ouvert chez
 * OpenCode, vu passer dans le flux (`tourOuvert`).
 */
const travauxHelix = new Map<string, number>();
/** Au-delà de ce silence, un tour qu'on croit ouvert ne compte plus : une fin a pu se perdre (OpenCode redémarré). */
const TOUR_MUET_MAX_MS = 15 * 60_000;

/** Helix travaille pour cette session (préparation, contrôle, envoi) : rend de quoi dire qu'il a fini, une seule fois. */
export function travailHelix(sessionID: string): () => void {
  travauxHelix.set(sessionID, (travauxHelix.get(sessionID) ?? 0) + 1);
  let rendu = false;
  return () => {
    if (rendu) return;
    rendu = true;
    const reste = (travauxHelix.get(sessionID) ?? 1) - 1;
    if (reste > 0) travauxHelix.set(sessionID, reste);
    else travauxHelix.delete(sessionID);
  };
}

/** Une demande vient de partir chez OpenCode : le tour est ouvert avant même que son `prompted` revienne. */
export function ouvrirTour(sessionID: string): void {
  const suivi = sessions.get(sessionID);
  if (!suivi) return;
  suivi.tourOuvert = true;
  suivi.ouvertLe = Date.now();
  suivi.vu = Date.now();
}

/** La demande n'a jamais atteint le modèle (session perdue, voir index.ts) : aucun tour n'y travaille. */
export function fermerTour(sessionID: string): void {
  const suivi = sessions.get(sessionID);
  if (suivi) suivi.tourOuvert = false;
}

/**
 * OpenCode dit la session au repos : le tour qu'on croyait ouvert est fermé
 * (sa fin s'est perdue). Pas dans les cinq secondes qui suivent l'envoi, où
 * OpenCode peut ne pas s'être encore dit occupé.
 */
export function reposConfirme(sessionID: string): void {
  const suivi = sessions.get(sessionID);
  if (suivi?.tourOuvert && Date.now() - suivi.ouvertLe > 5000) suivi.tourOuvert = false;
}

/** L'agent ou Helix travaille encore pour cette session. */
export function auTravail(sessionID: string): boolean {
  if ((travauxHelix.get(sessionID) ?? 0) > 0) return true;
  const suivi = sessions.get(sessionID);
  return Boolean(suivi?.tourOuvert && Date.now() - suivi.vu < TOUR_MUET_MAX_MS);
}

/** Helix lui-même travaille pour cette session (sans compter OpenCode). */
export const helixAuTravail = (sessionID: string): boolean => (travauxHelix.get(sessionID) ?? 0) > 0;

/** Dernier numéro publié pour cette session (0 s'il n'y en a pas) : pour la suivre sans rien rejouer. */
export function dernierNumero(sessionID: string): number {
  const tampon = sessions.get(sessionID)?.tampon ?? [];
  return tampon.length ? (tampon[tampon.length - 1]!.durable?.seq ?? 0) : 0;
}
export const dossierSuivi = (sessionID: string): string | undefined => sessions.get(sessionID)?.dossier;

function publier(sessionID: string, suivi: Suivi, type: string, data: Record<string, unknown>, durable = true): void {
  const evenement: EvenementCode = {
    type,
    data: { sessionID, timestamp: Date.now(), ...data },
    ...(durable ? { durable: { seq: ++numero } } : {}),
  };
  suivi.vu = Date.now();
  if (durable) {
    suivi.tampon.push(evenement);
    suivi.octets += JSON.stringify(evenement).length;
    while (suivi.tampon.length > TAMPON_MAX || suivi.octets > OCTETS_MAX) {
      const sorti = suivi.tampon.shift();
      if (!sorti) break;
      suivi.octets -= JSON.stringify(sorti).length;
    }
  }
  for (const auditeur of suivi.auditeurs) {
    try {
      auditeur(evenement);
    } catch {
      /* un client qui décroche ne doit pas priver les autres */
    }
  }
}

/** Message lisible d'une erreur d'OpenCode (`{ name, data: { message } }`). */
function messageDe(erreur: unknown): string {
  const e = erreur as { name?: unknown; message?: unknown; data?: { message?: unknown } } | undefined;
  if (typeof e?.data?.message === "string") return e.data.message.split("\n")[0]!;
  if (typeof e?.message === "string") return e.message.split("\n")[0]!;
  return typeof e?.name === "string" ? e.name : "";
}

/**
 * L'échec d'un outil, pour l'écran (23/10/2026). Capture d'un utilisateur
 * sous Windows : un chemin hors du dossier du projet affichait le message de
 * règle d'OpenCode suivi du JSON de toutes ses règles. Ce refus-là (ou celui
 * du greffon de Helix, opencode.ts, `codeCheminHorsProjet`) porte désormais
 * `horsProjet`, avec le chemin quand l'appel en donne un : l'écran le dit en
 * une phrase traduite (src/lib/code.ts). Le message garde sa première phrase
 * seulement, sans le JSON, pour l'extension et la ligne de commande.
 */
export function erreurOutil(message: string, entree: unknown): { message: string; horsProjet?: { chemin?: string } } {
  const regle = /The user has specified a rule which prevents you from using this specific tool call/.test(message);
  const greffon = /This path is outside the project folder/.test(message);
  if (!regle && !greffon) return { message };
  const args = (entree ?? {}) as { filePath?: unknown; path?: unknown };
  const chemin = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
  // Une règle refusée sans chemin (une question, une compétence) n'est pas une sortie du dossier : seulement la phrase, sans le JSON.
  if (regle && !chemin) return { message: "The user has specified a rule which prevents you from using this specific tool call." };
  return {
    message: greffon ? message.replace(/^Error:\s*/, "").split("\n")[0]! : "The user has specified a rule which prevents you from using this specific tool call.",
    horsProjet: chemin ? { chemin } : {},
  };
}

interface PartV1 {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  time?: { start?: number; end?: number };
  tool?: string;
  callID?: string;
  reason?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; metadata?: { sessionId?: unknown } };
}

/**
 * Traduit un évènement de l'ancienne API et le publie aux auditeurs de sa
 * session. Un évènement d'une session que la passerelle n'a pas ouverte est
 * ignoré. `repondre` sert à refuser une question d'OpenCode (voir plus bas).
 * Les formes ont été relevées sur OpenCode 1.18.32 le 25/09/2026 : un tour
 * avec un outil MCP, un modèle inconnu.
 */
export function traduire(brut: { type?: string; properties?: Record<string, unknown> }, repondre?: (chemin: string, corps: unknown) => void): void {
  const p = brut.properties ?? {};
  // Mesuré le 25/09/2026 : chaque évènement d'une session porte `sessionID` à la racine de `properties`.
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";

  /*
   * Un sous-agent naît (outil `task`) : OpenCode ouvre une session dont
   * `parentID` est la nôtre (schéma lu dans OpenCode 1.18.32 : `session.created`
   * porte `{ sessionID, info: { id, parentID } }`, et sa propre ligne de
   * commande suit les sous-agents de la même façon).
   */
  if (brut.type === "session.created" || brut.type === "session.updated") {
    const info = p.info as { id?: unknown; parentID?: unknown } | undefined;
    if (typeof info?.id === "string" && typeof info.parentID === "string" && destinataireDe(info.parentID)) {
      const racine = destinataireDe(info.parentID)!.session;
      if (!enfants.has(info.id)) {
        if (enfants.size >= ENFANTS_MAX) enfants.delete(enfants.keys().next().value!);
        enfants.set(info.id, { parent: racine });
      }
      // Au registre, sous la propriétaire de la session parente (sessionsCode.ts) : ses droits suivent.
      void noterSousSession(info.id, info.parentID).catch(() => {});
      // Ses commandes suivent le réglage RTK de la session qui l'a lancé, et comptent pour elle (rtk.ts).
      rtkSousSession(info.id, racine);
    }
    return;
  }
  const lienEnfant = sessionID ? enfants.get(sessionID) : undefined;
  // Une question d'un sous-agent se refuse comme celle de l'agent principal (plus bas) : elle le bloquerait aussi.
  const question = brut.type === "permission.asked" || brut.type === "question.asked" || brut.type === "permission.replied";
  if (lienEnfant && !question) return traduireEnfant(sessionID, lienEnfant, brut.type, p);

  const suivi = sessionID ? (sessions.get(sessionID) ?? (lienEnfant ? sessions.get(lienEnfant.parent) : undefined)) : undefined;
  if (!suivi) return;

  switch (brut.type) {
    case "message.updated": {
      const info = p.info as { id?: string; role?: string } | undefined;
      if (info?.role === "user" && typeof info.id === "string" && !suivi.demandes.has(info.id)) {
        suivi.demandes.add(info.id);
        suivi.tourOuvert = true;
        suivi.ouvertLe = Date.now();
        suivi.echecDit = false;
        suivi.natures.clear();
        publier(sessionID, suivi, "session.next.prompted", { messageID: info.id, ...(relancesHelix.has(info.id) ? { relanceHelix: true } : {}) });
      }
      return;
    }
    case "message.part.delta": {
      /*
       * Pas d'évènement fabriqué pour chaque morceau : les clients n'affichent
       * que les textes entiers. Mais ils tiennent tout ce qui arrive pour un
       * signe de vie (guet de silence de 90 s, src/hooks/useCode.ts) : sans ce
       * signal, un long raisonnement de Qwen3 passait pour un agent muet. Au
       * plus un par seconde, sans numéro, jamais rejoué. `phase` dit si
       * l'agent réfléchit ou écrit, pour le panneau de suivi de l'écran Code.
       */
      if (Date.now() - suivi.dernierSigne < 1000) return;
      suivi.dernierSigne = Date.now();
      const nature = typeof p.partID === "string" ? suivi.natures.get(p.partID) : undefined;
      publier(sessionID, suivi, "helix.activite", nature ? { phase: nature === "reasoning" ? "reflexion" : "ecriture" } : {}, false);
      return;
    }
    case "message.part.updated": {
      const part = (p.part ?? {}) as PartV1;
      if (!part.messageID || suivi.demandes.has(part.messageID)) return; // le texte de la personne
      const id = part.id ?? "";
      if (id && part.type && suivi.natures.size < 5000) suivi.natures.set(id, part.type);
      switch (part.type) {
        case "step-start":
          suivi.echecDit = false;
          publier(sessionID, suivi, "session.next.step.started", { assistantMessageID: part.messageID });
          return;
        case "reasoning":
        case "text":
          if (!part.time?.end || suivi.finies.has(id) || part.synthetic || typeof part.text !== "string") return;
          suivi.finies.add(id);
          publier(sessionID, suivi, part.type === "text" ? "session.next.text.ended" : "session.next.reasoning.ended", {
            assistantMessageID: part.messageID,
            text: part.text,
          });
          return;
        case "tool": {
          const appel = part.callID ?? id;
          const etat = part.state ?? {};
          // La sous-tâche a sa session : ses outils seront rapportés sous cet appel (voir `traduireEnfant`).
          const enfant = etat.metadata?.sessionId;
          if (part.tool === "task" && typeof enfant === "string" && /^ses_[A-Za-z0-9]{1,64}$/.test(enfant)) {
            const lien = enfants.get(enfant);
            if (lien) lien.callID = appel;
            else enfants.set(enfant, { parent: sessionID, callID: appel });
            if (!lien) void noterSousSession(enfant, sessionID).catch(() => {});
          }
          if (etat.status === "pending" || !etat.status) {
            /*
             * L'agent écrit les arguments de l'outil : un fichier entier pour
             * `write`, parfois plusieurs minutes sur un petit modèle, sans
             * aucun morceau de texte. C'est un signe de vie, et le panneau dit
             * quel outil se prépare.
             */
            if (Date.now() - suivi.dernierSigne < 1000) return;
            suivi.dernierSigne = Date.now();
            publier(sessionID, suivi, "helix.activite", { phase: "outil", tool: part.tool ?? "outil" }, false);
            return;
          }
          if (!suivi.appels.has(appel)) {
            suivi.appels.add(appel);
            publier(sessionID, suivi, "session.next.tool.called", {
              assistantMessageID: part.messageID,
              callID: appel,
              tool: part.tool ?? "outil",
              input: (etat.input as Record<string, unknown>) ?? {},
            });
          }
          if ((etat.status === "completed" || etat.status === "error") && !suivi.termines.has(appel)) {
            suivi.termines.add(appel);
            if (etat.status === "completed") {
              publier(sessionID, suivi, "session.next.tool.success", {
                assistantMessageID: part.messageID,
                callID: appel,
                content: [{ type: "text", text: typeof etat.output === "string" ? etat.output : "" }],
                structured: {},
              });
            } else {
              publier(sessionID, suivi, "session.next.tool.failed", {
                assistantMessageID: part.messageID,
                callID: appel,
                error: erreurOutil(typeof etat.error === "string" ? etat.error : messageDe(etat.error), etat.input),
              });
            }
          }
          return;
        }
        case "step-finish":
          publier(sessionID, suivi, "session.next.step.ended", {
            assistantMessageID: part.messageID,
            finish: part.reason ?? "unknown",
          });
          // « tool-calls » laisse travailler l'outil : l'étape suivante reprend. Toute autre fin ferme le tour.
          if (part.reason !== "tool-calls" && part.reason !== "tool_calls") suivi.tourOuvert = false;
          if (part.reason === "stop" && surFin) {
            const dossier = suivi.dossier;
            setTimeout(() => surFin?.(sessionID, dossier), 0);
          }
          return;
        case "compaction":
          if (suivi.finies.has(id)) return;
          suivi.finies.add(id);
          publier(sessionID, suivi, "session.next.compaction.started", {});
          return;
      }
      return;
    }
    case "session.idle":
      suivi.tourOuvert = false;
      return;
    case "session.status": {
      const statut = p.status as { type?: string; message?: string; attempt?: number } | undefined;
      if (statut?.type === "idle") suivi.tourOuvert = false;
      else if (statut?.type === "busy" && !suivi.tourOuvert) {
        suivi.tourOuvert = true;
        suivi.ouvertLe = Date.now();
      }
      if (statut?.type === "retry") {
        publier(sessionID, suivi, "session.next.retried", { attempt: statut.attempt, error: { message: statut.message ?? "" } });
      }
      return;
    }
    case "session.error": {
      suivi.tourOuvert = false;
      if (suivi.echecDit) return;
      suivi.echecDit = true;
      const erreur = p.error as { name?: string } | undefined;
      // La réponse coupée par la limite de longueur reste une réponse : les clients le disent comme tel.
      if (erreur?.name === "MessageOutputLengthError") {
        publier(sessionID, suivi, "session.next.step.ended", { finish: "length" });
        return;
      }
      publier(sessionID, suivi, "session.next.step.failed", { error: { message: messageDe(erreur) } });
      return;
    }
    case "permission.asked": {
      /*
       * Une demande d'autorisation d'OpenCode (commande, écriture, adresse…,
       * voir `permission` dans opencode.ts) : elle passe par la barrière de
       * Helix, et la carte va à la propriétaire de la session
       * (permissionsCode.ts). Depuis le 26/09/2026 ; avant, refusée d'office,
       * et seulement si elle passait malgré une configuration qui laissait
       * tout faire (revue du 25/09).
       */
      const demande = typeof p.id === "string" ? p.id : "";
      if (!demande || !/^[A-Za-z0-9_-]{1,80}$/.test(demande) || !repondre) return;
      const racine = lienEnfant?.parent ?? sessionID;
      const d: DemandeOpenCode = {
        id: demande,
        sessionID,
        permission: typeof p.permission === "string" ? p.permission : "inconnue",
        patterns: Array.isArray(p.patterns) ? p.patterns.filter((x): x is string => typeof x === "string") : [],
        metadata: p.metadata && typeof p.metadata === "object" ? (p.metadata as Record<string, unknown>) : {},
      };
      const chemin = `/permission/${demande}/reply`;
      void traiterPermissionCode(d, racine, suivi.dossier, (reponse) => repondre(chemin, reponse)).catch(() =>
        repondre(chemin, { reply: "reject" }),
      );
      return;
    }
    case "permission.replied": {
      // Répondue sans nous (session arrêtée) : la carte encore ouverte n'a plus d'objet.
      if (typeof p.requestID === "string") permissionRepondueAilleurs(p.requestID);
      return;
    }
    case "question.asked": {
      /*
       * Jamais de question en attente (même règle que `question: "deny"`
       * dans opencode.ts) : aucune ne passe par les clients, la session
       * resterait bloquée. Celles qui passeraient quand même sont refusées
       * ici, et l'agent lit un refus.
       */
      const demande = typeof p.id === "string" ? p.id : "";
      if (!demande || !/^[A-Za-z0-9_-]{1,80}$/.test(demande) || !repondre) return;
      journaliser("outil.refuse", "systeme", { surface: "code", cause: "question.asked-refuse", session: sessionID });
      repondre(`/question/${demande}/reject`, {});
      return;
    }
  }
}

/* ------------------------- écoute de /event, par dossier ------------------------ */

/**
 * Écoutes ouvertes, une par serveur OpenCode et par dossier : chacune est
 * prête quand OpenCode a dit « connecté ». Le port fait partie de la clé :
 * OpenCode redémarré (`assurerModele`), l'écoute de l'ancien serveur peut
 * paraître encore ouverte un instant, et un envoi fait sur sa foi perdrait
 * tous ses évènements.
 */
interface Ecoute {
  cle: string;
  prete?: Promise<void>;
}
const ecoutes = new Map<string, Ecoute>();

/**
 * S'assure que la passerelle écoute les évènements d'OpenCode pour ce dossier,
 * et attend que l'écoute soit prête : un envoi fait avant perdrait ses
 * premiers évènements (`/event` ne rejoue rien).
 */
export async function ecouterDossier(dossier: string): Promise<void> {
  if (!(await ensureServer())) throw new Error("OpenCode indisponible.");
  const cle = `${portEnCours()}|${dossier}`;
  const deja = ecoutes.get(cle);
  if (deja?.prete) return deja.prete;
  const ecoute: Ecoute = { cle };
  ecoutes.set(cle, ecoute);
  ecoute.prete = ouvrir(dossier, ecoute);
  ecoute.prete.catch(() => {
    if (ecoutes.get(cle) === ecoute) ecoutes.delete(cle);
  });
  return ecoute.prete;
}

function ouvrir(dossier: string, ecoute: Ecoute): Promise<void> {
  return new Promise<void>((pret, echec) => {
    let amont: http.IncomingMessage | undefined;
    let annonce = false;
    const delai = setTimeout(() => {
      if (annonce) return;
      amont?.destroy();
      echec(new Error("OpenCode n'a pas ouvert son flux d'évènements."));
    }, 10_000);
    fluxEvenements(dossier)
      .then((reponse) => {
        amont = reponse;
        if (reponse.statusCode !== 200) {
          reponse.resume();
          clearTimeout(delai);
          echec(new Error(`Flux d'évènements d'OpenCode : ${reponse.statusCode}`));
          return;
        }
        const d = encodeURIComponent(dossier);
        const repondre = (chemin: string, corps: unknown) =>
          void api(`${chemin}?directory=${d}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(corps),
          }).catch(() => {});
        let reste = "";
        reponse.setEncoding("utf8");
        reponse.on("data", (morceau: string) => {
          reste += morceau;
          const blocs = reste.split("\n\n");
          reste = blocs.pop() ?? "";
          for (const bloc of blocs) {
            const donnee = bloc
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("");
            if (!donnee) continue;
            let brut: { type?: string; properties?: Record<string, unknown> };
            try {
              brut = JSON.parse(donnee);
            } catch {
              continue;
            }
            if (!annonce && brut.type === "server.connected") {
              annonce = true;
              clearTimeout(delai);
              pret();
            }
            traduire(brut, repondre);
          }
        });
        let fini = false;
        const fin = () => {
          if (fini) return;
          fini = true;
          clearTimeout(delai);
          const encore = ecoutes.get(ecoute.cle) === ecoute;
          if (encore) ecoutes.delete(ecoute.cle);
          if (!annonce) echec(new Error("Flux d'évènements d'OpenCode fermé."));
          // OpenCode tourne encore (flux coupé, pas arrêté) : on se rebranche sans attendre qu'on le demande.
          else if (encore && enMarche()) setTimeout(() => void ecouterDossier(dossier).catch(() => {}), 1000);
        };
        reponse.on("end", fin);
        reponse.on("error", fin);
        reponse.on("close", fin);
      })
      .catch((err) => {
        clearTimeout(delai);
        echec(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Abonne un client au flux traduit d'une session. `apres` : dernier numéro
 * déjà reçu ; absent, tout ce que la passerelle garde de la session est
 * rejoué d'abord, comme le faisait OpenCode (les clients trient par
 * l'identifiant de leur message). Rend de quoi se désabonner.
 */
export function abonner(sessionID: string, apres: number | undefined, auditeur: Auditeur): () => void {
  const suivi = sessions.get(sessionID);
  if (!suivi) return () => {};
  for (const evenement of suivi.tampon) {
    if (apres === undefined || (evenement.durable?.seq ?? 0) > apres) auditeur(evenement);
  }
  suivi.auditeurs.add(auditeur);
  return () => suivi.auditeurs.delete(auditeur);
}
