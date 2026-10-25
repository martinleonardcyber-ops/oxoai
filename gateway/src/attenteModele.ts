import type http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findLms } from "./backends.ts";
import { dossierLmStudio } from "./engine.ts";
import { destinataireDe, publierStatut } from "./fluxCode.ts";
import { cleRelaisValide } from "./opencode.ts";

const exec = promisify(execFile);

/**
 * Pendant qu'un modèle lit une demande de OxoAI Code, le dire aux clients.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Constat de Medhi le 25/09/2026 : « Aucun signe de l'agent de code depuis 90
 * secondes » pendant que Qwen3 8B, dans LM Studio, lisait une demande de
 * 18 141 jetons (146,9 s avant le premier mot, relevé dans le journal de LM
 * Studio). L'agent travaillait ; l'écran annonçait une panne, parce qu'entre
 * l'envoi au modèle et son premier mot, rien ne passe dans le flux
 * d'OpenCode.
 *
 * La passerelle, elle, le sait : c'est elle qui relaie l'appel au modèle
 * (chat.ts). OpenCode y joint l'identifiant de sa session (`X-Session-Id` et
 * `x-session-affinity`, et `x-parent-session-id` pour un sous-agent : lu dans
 * OpenCode 1.18.32, pour tout fournisseur qui n'est pas le sien). Tant qu'un
 * appel attend son premier morceau, la passerelle envoie à la session un
 * `oxoai.statut` toutes les dix secondes : les clients l'affichent, et leur
 * guet de silence reste au repos.
 *
 * ── Ce qu'on dit, et d'où on le tient ───────────────────────────────────────
 *
 *  - Le temps écoulé depuis l'envoi au modèle, et la taille approximative de
 *    la demande (caractères envoyés divisés par 4 : mesuré au tokeniseur de
 *    Qwen3 le 25/09/2026, 34 080 caractères pour 8 025 jetons avant
 *    l'allègement, 10 595 pour 2 803 après). Toujours sûr.
 *  - Pour un modèle de LM Studio sur ce poste, son état par `lms ps --json`,
 *    en lecture seule, au plus une fois toutes les dix secondes pour toute la
 *    passerelle, et seulement pendant qu'un appel attend : `processingPrompt`
 *    (il lit), `generating` alors qu'il ne sert qu'une demande à la fois et
 *    que la nôtre n'a encore rien reçu (il finit celle d'un autre programme :
 *    la nôtre attend son tour), absent de la liste (il se charge).
 *  - La progression de la lecture, en pour cent, lue dans le journal de LM
 *    Studio (« Prompt processing progress: 45.4% », environ toutes les dix
 *    secondes pendant une longue lecture, relevé le 25/09/2026) **seulement**
 *    quand on sait que c'est la nôtre : le modèle lit, personne n'attend
 *    derrière (`queued` à 0), et la passerelle n'a qu'un appel en cours sur ce
 *    modèle ; la lecture a commencé après notre envoi. Sinon, pas de chiffre.
 *    Ce journal n'est pas une interface publique de LM Studio : s'il change de
 *    forme ou de place, le chiffre disparaît, rien d'autre.
 *  - LM Studio dit le modèle au repos, rien en file, deux fois de suite, alors
 *    que la demande n'a toujours rien reçu : il ne la traite pas. On cesse
 *    alors d'envoyer des statuts, et le guet de silence des clients dit ce
 *    qu'il doit dire. Un statut ne doit jamais masquer une vraie panne.
 *
 * Jamais rien d'autre n'est demandé à LM Studio ici : ni chargement, ni
 * déchargement, ni requête au modèle.
 */

interface Appel {
  /** Session suivie à qui rapporter (celle de la demande, ou celle qui a lancé le sous-agent). */
  destinataire: string;
  sousTache: boolean;
  modele: string;
  /** Modèle de LM Studio sur ce poste : `lms ps` et son journal le concernent. */
  lmStudioLocal: boolean;
  depuis: number;
  jetons: number;
  /** Premier morceau reçu : le modèle ne lit plus, il écrit. */
  recu: boolean;
  /** La passerelle met le modèle en mémoire avant de l'appeler (chat.ts, `loadModel`). */
  charge: boolean;
  dernierStatut: number;
  /** Relevés consécutifs où LM Studio dit ne rien faire. */
  repos: number;
}

const appels = new Map<number, Appel>();
let numero = 0;
let minuterie: NodeJS.Timeout | undefined;

/** Premier statut après ce délai : une lecture courte (début de demande déjà lu) ne mérite pas d'affichage. */
const PREMIER_STATUT_MS = 3000;
const INTERVALLE_MS = 10_000;
const CARACTERES_PAR_JETON = 4;

const SESSION = /^ses_[A-Za-z0-9]{1,64}$/;

function entete(entetes: http.IncomingHttpHeaders, nom: string): string | undefined {
  const v = entetes[nom];
  const valeur = Array.isArray(v) ? v[0] : v;
  return typeof valeur === "string" && SESSION.test(valeur) ? valeur : undefined;
}

/** L'adresse désigne-t-elle ce poste ? `lms` ne renseigne que sur le LM Studio local. */
function surCePoste(adresse: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(adresse).hostname);
  } catch {
    return false;
  }
}

/**
 * Un appel au modèle part, relayé par la passerelle. Rend de quoi signaler le
 * premier morceau et la fin, ou `null` si l'appel ne vient pas d'une session
 * de OxoAI Code suivie (autre client de l'API compatible, titre de session).
 */
export function suivreAppelModele(
  entetes: http.IncomingHttpHeaders,
  modele: string,
  moteur: { kind: string; baseUrl: string },
  caracteres: number,
): { premierMorceau: () => void; fin: () => void; chargement: (oui: boolean) => void; taille: (caracteres: number) => void } | null {
  /*
   * Seulement un appel d'OpenCode lui-même : il joint la clé que la
   * passerelle lui a remise (`X-OxoAI-Relais`, opencode.ts). Revue du
   * 25/09/2026 : sans ce contrôle, n'importe quel porteur du jeton d'instance
   * nommait la session d'un collègue dans `X-Session-Id` et y faisait
   * afficher ses propres statuts.
   */
  const relais = entetes["x-oxoai-relais"];
  if (!cleRelaisValide(Array.isArray(relais) ? relais[0] : relais)) return null;
  const session = entete(entetes, "x-session-id") ?? entete(entetes, "x-session-affinity");
  const parent = entete(entetes, "x-parent-session-id");
  const cible = (session && destinataireDe(session)) || (parent && destinataireDe(parent)) || undefined;
  if (!cible) return null;
  const id = ++numero;
  appels.set(id, {
    destinataire: cible.session,
    sousTache: cible.sousTache || (!destinataireDe(session ?? "") && Boolean(parent)),
    modele,
    lmStudioLocal: moteur.kind === "lmstudio" && surCePoste(moteur.baseUrl),
    depuis: Date.now(),
    jetons: Math.round(caracteres / CARACTERES_PAR_JETON),
    recu: false,
    charge: false,
    dernierStatut: 0,
    repos: 0,
  });
  if (!minuterie) {
    minuterie = setInterval(() => void tourner(), 1000);
    minuterie.unref();
  }
  let premier = true;
  return {
    chargement: (oui) => {
      const a = appels.get(id);
      if (a) a.charge = oui;
    },
    taille: (caracteres) => {
      const a = appels.get(id);
      if (a) a.jetons = Math.round(caracteres / CARACTERES_PAR_JETON);
    },
    premierMorceau: () => {
      const a = appels.get(id);
      if (!a || !premier) return;
      premier = false;
      a.recu = true;
      // Le client efface l'affichage de lecture sans attendre le premier texte entier.
      if (a.dernierStatut > 0) publierStatut(a.destinataire, { etat: "fin", sousTache: a.sousTache });
    },
    fin: () => {
      const a = appels.get(id);
      appels.delete(id);
      if (a && !a.recu && a.dernierStatut > 0) publierStatut(a.destinataire, { etat: "fin", sousTache: a.sousTache });
      if (appels.size === 0 && minuterie) {
        clearInterval(minuterie);
        minuterie = undefined;
      }
    },
  };
}

/* ---------------------------- état de LM Studio ---------------------------- */

interface EtatLms {
  identifier?: string;
  modelKey?: string;
  status?: string;
  queued?: number;
  parallel?: number;
}

let releve: { quand: number; modeles: EtatLms[] | null } = { quand: 0, modeles: null };
let releveEnCours: Promise<void> | null = null;

/** `lms ps --json`, au plus une fois toutes les dix secondes, un seul à la fois. */
async function etatLms(): Promise<EtatLms[] | null> {
  if (Date.now() - releve.quand < INTERVALLE_MS - 500) return releve.modeles;
  if (!releveEnCours) {
    releveEnCours = (async () => {
      const lms = await findLms();
      let modeles: EtatLms[] | null = null;
      if (lms) {
        try {
          const { stdout } = await exec(lms, ["ps", "--json"], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
          const lu = JSON.parse(stdout);
          modeles = Array.isArray(lu) ? lu : null;
        } catch {
          modeles = null;
        }
      }
      releve = { quand: Date.now(), modeles };
    })().finally(() => {
      releveEnCours = null;
    });
  }
  await releveEnCours;
  return releve.modeles;
}

/**
 * Dernière progression de lecture de ce modèle dans le journal de LM Studio,
 * si la lecture a commencé après `depuis`. Lecture seule des 96 derniers Ko du
 * fichier le plus récent. Les lignes relevées le 25/09/2026 :
 * `[2026-09-25 15:00:15][INFO][qwen3-8b] Prompt processing progress: 0.0%`.
 */
// Dans le dossier de LM Studio que suit la passerelle, pointeur compris (28/09/2026 : il peut être sur un autre disque).
export function progressionJournal(modele: string, depuis: number, racine = join(dossierLmStudio(), "server-logs")): number | undefined {
  let fichier: string | undefined;
  try {
    const mois = readdirSync(racine).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort().pop();
    if (!mois) return undefined;
    const dossier = join(racine, mois);
    fichier = readdirSync(dossier)
      .filter((n) => n.endsWith(".log"))
      .map((n) => ({ n, m: statSync(join(dossier, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.n;
    if (!fichier) return undefined;
    fichier = join(dossier, fichier);
  } catch {
    return undefined;
  }
  let texte = "";
  try {
    const taille = statSync(fichier).size;
    const longueur = Math.min(taille, 96 * 1024);
    const tampon = Buffer.alloc(longueur);
    const fd = openSync(fichier, "r");
    try {
      readSync(fd, tampon, 0, longueur, taille - longueur);
    } finally {
      closeSync(fd);
    }
    texte = tampon.toString("utf8");
  } catch {
    return undefined;
  }
  const echappe = modele.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const motif = new RegExp(`^\\[(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2})\\]\\[INFO\\]\\[${echappe}\\] Prompt processing progress: ([\\d.]+)%`, "gm");
  let debut: number | undefined;
  let valeur: number | undefined;
  for (const m of texte.matchAll(motif)) {
    // Heure locale du poste, à la seconde près : une seconde de marge.
    const quand = new Date(`${m[1]}T${m[2]}`).getTime();
    const pourcent = Number(m[3]);
    if (pourcent === 0) {
      debut = quand;
      valeur = 0;
    } else if (debut !== undefined) valeur = pourcent;
  }
  if (debut === undefined || debut < depuis - 1000 || valeur === undefined) return undefined;
  return Math.min(100, Math.round(valeur));
}

/* --------------------------------- tour ---------------------------------- */

let tourEnCours = false;

async function tourner(): Promise<void> {
  if (tourEnCours) return;
  tourEnCours = true;
  try {
    const maintenant = Date.now();
    const dus = [...appels.values()].filter(
      (a) => !a.recu && maintenant - a.depuis >= PREMIER_STATUT_MS && maintenant - a.dernierStatut >= INTERVALLE_MS,
    );
    if (dus.length === 0) return;
    const lms = dus.some((a) => a.lmStudioLocal) ? await etatLms() : null;
    for (const a of dus) {
      // Réponse arrivée, ou appel terminé, pendant qu'on interrogeait LM Studio.
      if (a.recu || ![...appels.values()].includes(a)) continue;
      const donnees: Record<string, unknown> = { depuis: a.depuis, jetons: a.jetons, sousTache: a.sousTache };
      let etat = "lecture";
      if (a.charge) etat = "chargement";
      else if (a.lmStudioLocal && lms) {
        const e = lms.find((m) => m.identifier === a.modele || m.modelKey === a.modele);
        const memesModele = [...appels.values()].filter((b) => b.modele === a.modele && !b.recu).length;
        if (!e) etat = "chargement";
        else if (e.status === "processingPrompt") {
          if ((e.queued ?? 0) === 0 && memesModele === 1) {
            const p = progressionJournal(a.modele, a.depuis);
            if (p !== undefined) donnees.progression = p;
          }
          if ((e.queued ?? 0) > 0) donnees.file = e.queued;
        } else if (e.status === "generating" && (e.parallel ?? 1) === 1) etat = "attente";
        else if (e.status === "idle" && (e.queued ?? 0) === 0) {
          // LM Studio ne fait rien, et notre demande n'a rien reçu : on ne masque pas ce silence.
          a.repos += 1;
          if (a.repos >= 2) {
            a.dernierStatut = maintenant;
            continue;
          }
        }
        if (e && e.status !== "idle") a.repos = 0;
      }
      a.dernierStatut = maintenant;
      publierStatut(a.destinataire, { etat, ...donnees });
    }
  } finally {
    tourEnCours = false;
  }
}
