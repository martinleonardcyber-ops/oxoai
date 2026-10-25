import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { journaliser } from "./audit.ts";
import { filtrer } from "./authz.ts";
import { groupesDe } from "./groupes.ts";
import { phraseLangue } from "./plan.ts";
import { t, tf } from "./langue.ts";

/**
 * Les tâches programmées : une consigne, un rythme, et OxoAI l'exécute avec les
 * outils de la personne, fenêtre fermée ou non.
 *
 * Demandé par Medhi le 26/09/2026 : « je veux programmer des tâches comme le
 * fait Claude », quotidiennes, hebdomadaires, mensuelles, et pouvoir les
 * préparer depuis le Chat, puisqu'il est branché à ses outils (Gmail, Google
 * Agenda…). Les missions des employés OpenClaw faisaient déjà une partie de ce
 * travail, mais demandent d'installer et de régler un agent ; ici, une phrase
 * suffit.
 *
 * Comment une tâche s'exécute : la passerelle s'appelle elle-même sur la boucle
 * locale (`/v1/chat/completions`, outils compris), au nom de la propriétaire,
 * avec une clé tirée au sort à chaque démarrage et gardée en mémoire (index.ts
 * vérifie clé et boucle locale). C'est donc le même agent que le Chat, sous la
 * même barrière d'approbation : ce qui modifie attend l'accord de la personne,
 * sauf au niveau « Tout approuver » qu'elle a choisi. Une tâche à la fois, le
 * modèle local n'en tient pas deux.
 *
 * Ce qui reste : le compte rendu de chaque exécution (les vingt dernières),
 * lisible dans l'écran Tâches. Rien n'est écrit dans les Chats : l'écran propose
 * d'ouvrir un compte rendu dans un Chat.
 */

export type Rythme =
  | { type: "jour" }
  | { type: "jours-ouvres" }
  | { type: "semaine"; jour: number }
  | { type: "mois"; jour: number };

export interface Execution {
  quand: string;
  ok: boolean;
  resultat: string;
  dureeMs: number;
  /** Le nom de l'agent qui l'a faite, tel qu'il était ce jour-là. */
  agent?: string;
}

export interface TacheProgrammee {
  id: string;
  ownerId: string;
  titre: string;
  consigne: string;
  rythme: Rythme;
  /** « HH:MM », heure de la machine de l'instance. */
  heure: string;
  /** Avec les outils de la personne (courrier, agenda, fichiers…). */
  outils: boolean;
  /**
   * L'agent personnalisé qui fait la tâche (écran Agents) : ses instructions,
   * son modèle, ses outils et ses bases de connaissances. Sans lui, l'agent du
   * Chat. Ajouté le 26/09/2026 (« je veux pouvoir donner des tâches à des
   * agents », Medhi).
   */
  agentId?: string;
  active: boolean;
  creeLe: string;
  prochaine: string;
  enCours?: boolean;
  executions: Execution[];
}

const COLLECTION = "tachesProgrammees";
const EXECUTIONS_GARDEES = 20;
const RESULTAT_MAX = 12_000;
const TACHES_PAR_PERSONNE = 50;

/* ------------------------------ rythme et prochaine fois ------------------------------ */

const JOURS = () => [t("dimanche"), t("lundi"), t("mardi"), t("mercredi"), t("jeudi"), t("vendredi"), t("samedi")];

export function lireHeure(v: unknown): string | null {
  const m = /^(\d{1,2})[:h](\d{2})?$/.exec(String(v ?? "").trim().toLowerCase());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export function lireRythme(v: unknown): Rythme | null {
  const r = (v ?? {}) as { type?: unknown; jour?: unknown };
  // Un nombre, ou son écriture : `null`, `""` ou `true` ne valent pas dimanche (Number(null) === 0).
  const jour = typeof r.jour === "number" ? Math.trunc(r.jour) : typeof r.jour === "string" && /^-?\d+$/.test(r.jour.trim()) ? Number(r.jour) : Number.NaN;
  if (r.type === "jour") return { type: "jour" };
  if (r.type === "jours-ouvres") return { type: "jours-ouvres" };
  if (r.type === "semaine") return Number.isInteger(jour) && jour >= 0 && jour <= 6 ? { type: "semaine", jour } : null;
  // Le jour du mois : 1 à 31 ; un mois plus court prend son dernier jour. -1 : le dernier jour du mois.
  if (r.type === "mois") return Number.isInteger(jour) && ((jour >= 1 && jour <= 31) || jour === -1) ? { type: "mois", jour } : null;
  return null;
}

/** La prochaine occurrence strictement après `apres`, à l'heure dite (heure locale de l'instance). */
export function prochaineOccurrence(rythme: Rythme, heure: string, apres: Date): Date {
  const [h, m] = heure.split(":").map(Number);
  const essai = new Date(apres);
  essai.setSeconds(0, 0);
  for (let i = 0; i < 400; i++) {
    const d = new Date(essai.getFullYear(), essai.getMonth(), essai.getDate() + i, h, m, 0, 0);
    if (d.getTime() <= apres.getTime()) continue;
    const js = d.getDay();
    if (rythme.type === "jour") return d;
    if (rythme.type === "jours-ouvres" && js >= 1 && js <= 5) return d;
    if (rythme.type === "semaine" && js === rythme.jour) return d;
    if (rythme.type === "mois") {
      const dernier = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const voulu = rythme.jour === -1 ? dernier : Math.min(rythme.jour, dernier);
      if (d.getDate() === voulu) return d;
    }
  }
  return new Date(apres.getTime() + 86_400_000);
}

export function decrireRythme(r: Rythme, heure: string): string {
  const a = heure.replace(":", " h ").replace(/ h 00$/, " h");
  switch (r.type) {
    case "jour":
      return tf("chaque jour à {0}", a);
    case "jours-ouvres":
      return tf("du lundi au vendredi à {0}", a);
    case "semaine":
      return tf("chaque {0} à {1}", JOURS()[r.jour]!, a);
    case "mois":
      return r.jour === -1 ? tf("le dernier jour de chaque mois à {0}", a) : tf("le {0} de chaque mois à {1}", String(r.jour), a);
  }
}

/* ------------------------------------ stockage ------------------------------------ */

let taches: TacheProgrammee[] | null = null;
/*
 * Lecture ratée : on n'écrit plus rien tant qu'on n'a pas relu. Une liste vide
 * écrite par-dessus des tâches qu'on n'a pas pu lire les effacerait (règle du
 * projet, pertes du 20/09 et du 24/09).
 */
let lectureEchouee = false;

async function charger(): Promise<TacheProgrammee[]> {
  if (taches) return taches;
  try {
    const v = await db().read(COLLECTION);
    taches = Array.isArray(v) ? (v as TacheProgrammee[]) : [];
    // Relu au démarrage : rien ne tourne encore. Un « en cours » écrit avant un arrêt bloquait la tâche jusqu'à sa prochaine heure.
    for (const x of taches) delete x.enCours;
    lectureEchouee = false;
  } catch {
    lectureEchouee = true;
    throw new Error(t("Les tâches programmées sont illisibles pour l'instant : rien n'a été modifié."));
  }
  return taches;
}

async function ecrire(): Promise<void> {
  if (lectureEchouee || !taches) throw new Error(t("Les tâches programmées sont illisibles pour l'instant : rien n'a été modifié."));
  await db().write(COLLECTION, taches);
}

const nouvelId = () => `tp_${randomBytes(9).toString("base64url")}`;
const texte = (v: unknown, max: number) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);

export type Resultat<T> = { ok: true; valeur: T } | { ok: false; statut: number; message: string };

/* ------------------------------------- agents ------------------------------------- */

export interface AgentDeTache {
  id: string;
  nom: string;
  instructions: string;
  outils: boolean;
  modele?: string;
  connaissances: string[];
}

/**
 * Les agents que la propriétaire voit, à l'instant (authz.ts, `voitAgent`) :
 * les siens, ceux de l'organisation, ceux partagés à l'un de ses groupes. Un
 * agent qu'on ne lui partage plus ne fait plus ses tâches : il est relu à
 * chaque exécution, jamais recopié dans la tâche.
 */
export async function agentsVisibles(ownerId: string): Promise<AgentDeTache[]> {
  const tous = await db().read("agents");
  // Ceux qu'elle voit, mais avec leurs vraies instructions : une tâche se sert d'un agent masqué comme son Chat.
  const vrais = new Map((Array.isArray(tous) ? (tous as Record<string, unknown>[]) : []).map((a) => [a.id, a]));
  const visibles = (filtrer("agents", tous, { userId: ownerId, email: "", groupes: await groupesDe(ownerId) }) as Record<string, unknown>[]).map((a) => vrais.get(a.id) ?? a);
  return visibles
    .filter((a) => typeof a.id === "string")
    .map((a) => ({
      id: String(a.id),
      nom: String(a.name ?? "").trim() || t("Agent sans nom"),
      instructions: String(a.instructions ?? ""),
      outils: a.toolsEnabled !== false,
      ...(typeof a.modelUid === "string" && a.modelUid ? { modele: a.modelUid } : {}),
      connaissances: Array.isArray(a.connaissances) ? a.connaissances.filter((k): k is string => typeof k === "string") : [],
    }));
}

async function agentDe(ownerId: string, agentId: string): Promise<AgentDeTache | null> {
  return (await agentsVisibles(ownerId)).find((a) => a.id === agentId) ?? null;
}

/** `agentId` reçu : absent (inchangé), vide ou null (l'agent du Chat), ou un agent que la personne voit. */
async function lireAgent(v: unknown, ownerId: string): Promise<{ ok: true; id: string | undefined } | { ok: false }> {
  if (v === null || v === "") return { ok: true, id: undefined };
  if (typeof v !== "string") return { ok: false };
  return (await agentDe(ownerId, v).catch(() => null)) ? { ok: true, id: v } : { ok: false };
}
const AGENT_INCONNU = () => t("Cet agent est introuvable, ou il ne vous est pas partagé.");

export async function lister(ownerId: string): Promise<TacheProgrammee[]> {
  return (await charger()).filter((x) => x.ownerId === ownerId).sort((a, b) => a.prochaine.localeCompare(b.prochaine));
}

export async function creer(brut: Record<string, unknown>, ownerId: string): Promise<Resultat<TacheProgrammee>> {
  const liste = await charger();
  if (liste.filter((x) => x.ownerId === ownerId).length >= TACHES_PAR_PERSONNE) {
    return { ok: false, statut: 400, message: tf("{0} tâches programmées au plus : retirez-en une avant d'en ajouter.", String(TACHES_PAR_PERSONNE)) };
  }
  const titre = texte(brut.titre, 120);
  const consigne = texte(brut.consigne, 4000);
  const rythme = lireRythme(brut.rythme);
  const heure = lireHeure(brut.heure);
  if (!titre || !consigne) return { ok: false, statut: 400, message: t("Donnez un titre et une consigne à la tâche.") };
  if (!rythme) return { ok: false, statut: 400, message: t("Le rythme n'est pas compris : chaque jour, du lundi au vendredi, chaque semaine (un jour) ou chaque mois (un jour du mois).") };
  if (!heure) return { ok: false, statut: 400, message: t("L'heure n'est pas comprise : écrivez-la HH:MM, par exemple 08:30.") };
  const agent = brut.agentId === undefined ? { ok: true as const, id: undefined } : await lireAgent(brut.agentId, ownerId);
  if (!agent.ok) return { ok: false, statut: 400, message: AGENT_INCONNU() };
  const tache: TacheProgrammee = {
    id: nouvelId(),
    ownerId,
    titre,
    consigne,
    rythme,
    heure,
    outils: brut.outils !== false,
    ...(agent.id ? { agentId: agent.id } : {}),
    active: true,
    creeLe: new Date().toISOString(),
    prochaine: prochaineOccurrence(rythme, heure, new Date()).toISOString(),
    executions: [],
  };
  liste.push(tache);
  await ecrire();
  journaliser("tache_programmee.creee", ownerId, { id: tache.id, rythme: rythme.type });
  return { ok: true, valeur: tache };
}

export async function modifier(id: string, brut: Record<string, unknown>, ownerId: string): Promise<Resultat<TacheProgrammee>> {
  const liste = await charger();
  const x = liste.find((y) => y.id === id && y.ownerId === ownerId);
  if (!x) return { ok: false, statut: 404, message: t("Tâche programmée introuvable.") };
  /*
   * Tout est vérifié avant de toucher à la tâche (revue du 27/09/2026) : une
   * heure refusée après un titre accepté laissait le titre changé en mémoire,
   * et la prochaine écriture l'enregistrait.
   */
  const suite: TacheProgrammee = { ...x };
  if (brut.titre !== undefined) {
    const v = texte(brut.titre, 120);
    if (v) suite.titre = v;
  }
  if (brut.consigne !== undefined) {
    const v = texte(brut.consigne, 4000);
    if (v) suite.consigne = v;
  }
  if (brut.rythme !== undefined) {
    const r = lireRythme(brut.rythme);
    if (!r) return { ok: false, statut: 400, message: t("Le rythme n'est pas compris.") };
    suite.rythme = r;
  }
  if (brut.heure !== undefined) {
    const h = lireHeure(brut.heure);
    if (!h) return { ok: false, statut: 400, message: t("L'heure n'est pas comprise : écrivez-la HH:MM, par exemple 08:30.") };
    suite.heure = h;
  }
  if (typeof brut.outils === "boolean") suite.outils = brut.outils;
  if (typeof brut.active === "boolean") suite.active = brut.active;
  if (brut.agentId !== undefined) {
    const agent = await lireAgent(brut.agentId, ownerId);
    if (!agent.ok) return { ok: false, statut: 400, message: AGENT_INCONNU() };
    if (agent.id) suite.agentId = agent.id;
    else delete suite.agentId;
  }
  suite.prochaine = prochaineOccurrence(suite.rythme, suite.heure, new Date()).toISOString();
  // Appliquée d'un coup, sur l'objet en place : une exécution en cours garde la même tâche.
  for (const k of Object.keys(x) as (keyof TacheProgrammee)[]) if (!(k in suite)) delete x[k];
  Object.assign(x, suite);
  await ecrire();
  return { ok: true, valeur: x };
}

export async function supprimer(id: string, ownerId: string): Promise<Resultat<null>> {
  const liste = await charger();
  const i = liste.findIndex((y) => y.id === id && y.ownerId === ownerId);
  if (i < 0) return { ok: false, statut: 404, message: t("Tâche programmée introuvable.") };
  liste.splice(i, 1);
  await ecrire();
  journaliser("tache_programmee.supprimee", ownerId, { id });
  return { ok: true, valeur: null };
}

/** Effacement d'un compte (effacement.ts) : ses tâches et leurs comptes rendus partent avec lui. */
export async function oublierPersonne(ownerId: string): Promise<number> {
  const liste = await charger();
  const avant = liste.length;
  taches = liste.filter((x) => x.ownerId !== ownerId);
  await ecrire();
  return avant - taches.length;
}

/* ------------------------------------ exécution ------------------------------------ */

/** Fourni par index.ts : un appel au Chat de l'instance, avec outils, au nom de la personne. Rend le texte de la réponse. */
export interface OptionsAppel {
  outils: boolean;
  /** Le modèle imposé par l'agent ; sinon celui du Chat. */
  modele?: string;
  /** Les bases de connaissances de l'agent, lues au nom de la propriétaire. */
  connaissances?: string[];
  /** Le titre de la tâche, que ses cartes d'accord affichent. */
  titre?: string;
}
type AppelChat = (ownerId: string, messages: { role: string; content: string }[], options: OptionsAppel) => Promise<string>;
let appeler: AppelChat | null = null;
let minuterie: ReturnType<typeof setInterval> | null = null;
let occupe = false;

function consigneSysteme(x: TacheProgrammee, outils: boolean, agent: AgentDeTache | null): string {
  const maintenant = new Date();
  return [
    // Les instructions de l'agent d'abord : c'est sa personnalité et son métier, la suite dit le cadre.
    ...(agent?.instructions.trim() ? [agent.instructions.trim(), ""] : []),
    "Tu exécutes une tâche programmée par la personne : personne n'est devant l'écran pour te répondre.",
    `Aujourd'hui, nous sommes le ${maintenant.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, il est ${String(maintenant.getHours()).padStart(2, "0")} h ${String(maintenant.getMinutes()).padStart(2, "0")}.`,
    outils ? "Fais le travail avec tes outils, réellement, plutôt que de décrire ce qu'il faudrait faire." : "Tu n'as pas d'outils pour cette tâche : réponds avec ce que tu sais.",
    "Termine par un compte rendu clair et court, que la personne lira plus tard : ce que tu as trouvé ou fait, et ce qui demande son attention.",
    "N'invente rien : ce que tu n'as pas pu vérifier, dis-le.",
    phraseLangue(x.consigne),
  ].join("\n");
}

async function executer(x: TacheProgrammee): Promise<Execution> {
  const debut = Date.now();
  x.enCours = true;
  let resultat = "";
  let ok = false;
  let nomAgent: string | undefined;
  try {
    if (!appeler) throw new Error(t("Le moteur des tâches n'est pas prêt."));
    const agent = x.agentId ? await agentDe(x.ownerId, x.agentId) : null;
    if (x.agentId && !agent) throw new Error(t("L'agent de cette tâche n'existe plus, ou il ne vous est plus partagé : choisissez-en un autre."));
    nomAgent = agent?.nom;
    // Les outils : il faut que la tâche les demande et que l'agent y ait droit.
    const outils = x.outils && (agent?.outils ?? true);
    resultat = (await appeler(x.ownerId, [
      { role: "system", content: consigneSysteme(x, outils, agent) },
      { role: "user", content: `${x.titre}\n\n${x.consigne}` },
    ], { outils, titre: x.titre, ...(agent?.modele ? { modele: agent.modele } : {}), ...(agent && agent.connaissances.length > 0 ? { connaissances: agent.connaissances } : {}) })).trim();
    ok = resultat.length > 0;
    if (!ok) resultat = t("Le modèle n'a rien répondu.");
  } catch (err) {
    resultat = err instanceof Error ? err.message : String(err);
  }
  x.enCours = false;
  const e: Execution = { quand: new Date(debut).toISOString(), ok, resultat: resultat.slice(0, RESULTAT_MAX), dureeMs: Date.now() - debut, ...(nomAgent ? { agent: nomAgent } : {}) };
  x.executions = [e, ...x.executions].slice(0, EXECUTIONS_GARDEES);
  journaliser("tache_programmee.executee", x.ownerId, { id: x.id, ok, dureeMs: e.dureeMs });
  return e;
}

/** Un tour : les tâches dont l'heure est passée, une à la fois. */
async function tour(): Promise<void> {
  if (occupe || !appeler) return;
  occupe = true;
  try {
    const liste = await charger().catch(() => null);
    if (!liste) return;
    const maintenant = Date.now();
    for (const x of liste) {
      if (!x.active || Date.parse(x.prochaine) > maintenant) continue;
      /*
       * La prochaine fois est calculée AVANT d'exécuter, depuis maintenant : une
       * machine éteinte toute la nuit ne rattrape pas dix exécutions d'un coup,
       * elle en fait une (celle qu'elle a manquée) et reprend le rythme.
       */
      x.prochaine = prochaineOccurrence(x.rythme, x.heure, new Date()).toISOString();
      await ecrire().catch(() => {});
      await executer(x);
      await ecrire().catch(() => {});
    }
  } finally {
    occupe = false;
  }
}

export function demarrer(fn: AppelChat): void {
  appeler = fn;
  if (!minuterie) {
    minuterie = setInterval(() => void tour(), 30_000);
    minuterie.unref?.();
  }
  void tour();
}

/** « Lancer maintenant », depuis l'écran : sans toucher au rythme. */
export async function lancerMaintenant(id: string, ownerId: string): Promise<Resultat<Execution>> {
  const x = (await charger()).find((y) => y.id === id && y.ownerId === ownerId);
  if (!x) return { ok: false, statut: 404, message: t("Tâche programmée introuvable.") };
  if (x.enCours || occupe) return { ok: false, statut: 409, message: t("Une tâche est déjà en cours : réessayez dans un instant.") };
  occupe = true;
  try {
    const e = await executer(x);
    await ecrire().catch(() => {});
    return { ok: true, valeur: e };
  } finally {
    occupe = false;
  }
}

/* ---------------------------------- outils du Chat ---------------------------------- */

type Outil = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export function toolsForModel(): Outil[] {
  return [
    {
      type: "function",
      function: {
        name: "taches__programmer",
        description:
          "Programme une tâche que OxoAI exécutera seul, avec les outils de la personne, à un rythme régulier (même fenêtre fermée). " +
          "Par exemple : chaque lundi à 8 h, résumer les mails de la semaine. La personne verra la tâche et l'acceptera avant qu'elle soit créée.",
        parameters: {
          type: "object",
          required: ["titre", "consigne", "rythme", "heure"],
          properties: {
            titre: { type: "string", description: "Nom court de la tâche." },
            consigne: { type: "string", description: "Ce que OxoAI doit faire à chaque fois, précisément." },
            rythme: { type: "string", enum: ["chaque-jour", "jours-ouvres", "chaque-semaine", "chaque-mois"] },
            jour: { type: "number", description: "Pour chaque-semaine : 0 dimanche, 1 lundi … 6 samedi. Pour chaque-mois : 1 à 31, ou -1 pour le dernier jour du mois." },
            heure: { type: "string", description: "HH:MM, heure de la machine." },
            agent: { type: "string", description: "Facultatif : le nom d'un agent de la personne (écran Agents) qui fera la tâche, si elle le demande. Sans lui, l'agent du Chat." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "taches__lister",
        description: "Liste les tâches programmées de la personne, avec leur rythme et leur prochaine exécution.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
}

export async function callTool(nom: string, args: Record<string, unknown>, ownerId: string | undefined): Promise<{ ok: boolean; content: string }> {
  if (!ownerId) return { ok: false, content: "Les tâches programmées demandent une personne identifiée." };
  try {
    if (nom === "taches__lister") {
      const liste = await lister(ownerId);
      if (liste.length === 0) return { ok: true, content: "Aucune tâche programmée." };
      const agents = await agentsVisibles(ownerId).catch(() => [] as AgentDeTache[]);
      const par = (x: TacheProgrammee) => (x.agentId ? `, par l'agent « ${agents.find((a) => a.id === x.agentId)?.nom ?? "introuvable"} »` : "");
      return {
        ok: true,
        content: liste
          .map((x) => `- ${x.titre} : ${decrireRythme(x.rythme, x.heure)}${par(x)}${x.active ? "" : " (en pause)"}, prochaine fois le ${new Date(x.prochaine).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`)
          .join("\n"),
      };
    }
    if (nom === "taches__programmer") {
      const r = String(args.rythme ?? "");
      const rythme = r === "chaque-jour" ? { type: "jour" } : r === "jours-ouvres" ? { type: "jours-ouvres" } : r === "chaque-semaine" ? { type: "semaine", jour: args.jour } : r === "chaque-mois" ? { type: "mois", jour: args.jour } : null;
      let agentId: string | undefined;
      if (typeof args.agent === "string" && args.agent.trim()) {
        const agents = await agentsVisibles(ownerId);
        const cherche = args.agent.trim().toLocaleLowerCase("fr");
        const trouve = agents.find((a) => a.nom.toLocaleLowerCase("fr") === cherche) ?? agents.find((a) => a.nom.toLocaleLowerCase("fr").includes(cherche));
        if (!trouve) {
          return {
            ok: false,
            content: agents.length > 0
              ? `Aucun agent ne s'appelle « ${args.agent} ». Agents de la personne : ${agents.map((a) => `« ${a.nom} »`).join(", ")}. Demande-lui lequel.`
              : "La personne n'a aucun agent personnalisé : la tâche peut être faite par l'agent du Chat, ou elle en crée un dans l'écran Agents.",
          };
        }
        agentId = trouve.id;
      }
      const cree = await creer({ titre: args.titre, consigne: args.consigne, rythme, heure: args.heure, outils: true, ...(agentId ? { agentId } : {}) }, ownerId);
      if (!cree.ok) return { ok: false, content: cree.message };
      const x = cree.valeur;
      const par = agentId ? ` Elle sera faite par l'agent « ${(await agentDe(ownerId, agentId))?.nom ?? ""} ».` : "";
      return {
        ok: true,
        content: `Tâche programmée : « ${x.titre} », ${decrireRythme(x.rythme, x.heure)}.${par} Première exécution le ${new Date(x.prochaine).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}. Elle se retrouve dans l'écran Tâches. C'est fait : ne la recrée pas.`,
      };
    }
    return { ok: false, content: `Outil inconnu : ${nom}.` };
  } catch (err) {
    return { ok: false, content: err instanceof Error ? err.message : String(err) };
  }
}
