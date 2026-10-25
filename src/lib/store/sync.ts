import { apiFetch, sessionToken } from "@/lib/endpoint";
import { retenirGroupes } from "@/lib/store/identity";
import { auGrand, ecrireGrand, grandIllisible, grandRelu, lireGrand, noterReleve } from "@/lib/store/grandStockage";
import { refuseesParLeNavigateur } from "./secours";

/**
 * Synchronisation multi-postes.
 *
 * Les données vivent dans l'instance (voir `gateway/src/db.ts`) ; chaque poste
 * en garde une copie locale pour rester réactif et utilisable hors ligne.
 *
 * - **Au démarrage** : on tire l'état de l'instance dans le cache local.
 * - **À chaque écriture** : on pousse vers l'instance.
 * - **En continu** : on compare les révisions et on re-tire ce qui a bougé
 *   ailleurs, ce qui fait apparaître les projets et conversations partagés par
 *   un collègue depuis un autre poste.
 *
 * Le cache local reste la source de lecture : tous les appels existants
 * demeurent synchrones, sans réécriture des écrans.
 */

export const COLLECTIONS = [
  "accounts",
  "projects",
  "sessions",
  "tasks",
  "agents",
  "profiles",
  "competences",
] as const;

export type Collection = (typeof COLLECTIONS)[number];

/** Événement émis quand l'instance a apporté des changements. */
export const SYNCED = "oxoai:synced";

const PREFIX = "oxoai:";
const POLL_MS = 4000;

let online = false;
let timer: ReturnType<typeof setInterval> | null = null;
const revisions = new Map<Collection, number>();
/**
 * Ce que l'instance avait, tel que ce poste l'a relu ou envoyé en dernier :
 * l'état de départ de la fusion à trois (27/09/2026). Sans lui, une
 * suppression faite ici revenait à la première relecture (le Chat supprimé
 * réapparaissait), et un profil changé ici était remplacé par la copie de
 * l'instance.
 */
const derniersConnus = new Map<Collection, unknown>();
/** Collections que ce poste vient d'écrire : on ignore l'écho du serveur. */
const pushing = new Set<Collection>();

export function isOnline(): boolean {
  return online;
}

/** Nom de la clé locale correspondant à une collection. */
function localKey(collection: Collection): string {
  // Les profils sont stockés par utilisateur : « profile:<id> ».
  return collection === "profiles" ? `${PREFIX}profiles` : `${PREFIX}${collection}`;
}

function readLocal(collection: Collection): unknown {
  if (collection === "profiles") {
    // Regroupe tous les profils individuels en un seul objet transportable.
    const bag: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(`${PREFIX}profile:`)) continue;
      try {
        bag[key.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(key)!);
      } catch {
        /* entrée illisible, ignorée */
      }
    }
    return bag;
  }
  try {
    // Les Chats, dans l'application de bureau, vivent dans le grand stockage (grandStockage.ts).
    const raw = auGrand(collection) ? lireGrand(collection) : (refuseesParLeNavigateur.get(localKey(collection)) ?? localStorage.getItem(localKey(collection)));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Faux si le stockage du navigateur a refusé (quota) : la copie locale n'a pas été remplacée. */
function writeLocal(collection: Collection, value: unknown): boolean {
  try {
    if (collection === "profiles") {
      const bag = (value ?? {}) as Record<string, unknown>;
      for (const [suffix, profile] of Object.entries(bag)) {
        localStorage.setItem(`${PREFIX}${suffix}`, JSON.stringify(profile));
      }
      return true;
    }
    if (value === null || value === undefined) return true;
    if (auGrand(collection)) {
      ecrireGrand(collection, JSON.stringify(value));
      return true;
    }
    localStorage.setItem(localKey(collection), JSON.stringify(value));
    // Gardée pour de bon : ce que la mémoire tenait à sa place (secours.ts) n'a plus lieu d'être.
    refuseesParLeNavigateur.delete(localKey(collection));
    return true;
  } catch {
    return false;
  }
}

/**
 * Prévient les écrans qu'une collection a changé.
 * On réémet les mêmes événements que les écritures locales : les vues se
 * rafraîchissent sans qu'aucun écran n'ait à connaître la synchronisation.
 */
/** Émis quand la liste des comptes change (écran de connexion). */
export const ACCOUNTS_CHANGED = "oxoai:accounts-changed";

const CHANGE_EVENTS: Record<Collection, string> = {
  accounts: ACCOUNTS_CHANGED,
  projects: "oxoai:projects-changed",
  sessions: "oxoai:sessions-changed",
  tasks: "oxoai:tasks-changed",
  agents: "oxoai:agents-changed",
  profiles: "oxoai:profile-changed",
  competences: "oxoai:competences-changed",
};

function announce(collections: Collection[]): void {
  for (const collection of collections) {
    window.dispatchEvent(new Event(CHANGE_EVENTS[collection]));
  }
  window.dispatchEvent(new Event(SYNCED));
}

/**
 * Issue d'une tentative de lecture. Les trois cas ne se confondent pas, et
 * c'est le cœur du problème corrigé ci-dessous.
 */
type Tirage =
  /** L'instance a rendu la collection : le cache local a été remplacé. */
  | "tiree"
  /** L'instance n'a jamais eu cette collection : c'est à ce poste de l'amorcer. */
  | "absente"
  /** La demande a échoué : instance muette, séance expirée, réseau coupé. */
  | "echec";

/*
 * Deux garde-fous de plus, revue de sécurité du 26/09/2026.
 *
 * 1. **Aucune poussée avant une relecture de la séance.** Tant que l'instance
 *    n'a pas rendu une collection (`tiree` ou `absente`) depuis le lancement,
 *    ce poste ne la pousse pas : il ne sait pas ce qu'il y a en face. Le
 *    blocage « fichier illisible » ne vivait qu'en mémoire du processus
 *    principal ; au lancement suivant, le fichier se lisait (réécrit avec une
 *    liste partielle), et la première modification poussait cette liste, que
 *    l'instance prenait pour la suppression des autres Chats.
 * 2. **Ce qui n'a pas pu partir est noté, et survit au redémarrage**
 *    (`oxoai:sync:a-pousser`). Tant qu'une collection a des modifications en
 *    attente, la relecture ne remplace plus la copie du poste par celle de
 *    l'instance : elle les fusionne (par identifiant, le plus récent l'emporte,
 *    ce que le poste a seul est gardé), puis repousse le tout. Avant, un Chat
 *    créé hors ligne, ou dont la poussée avait échoué, était écrasé à la
 *    relecture suivante. Contrepartie : un élément supprimé sur un autre poste
 *    pendant que celui-ci avait des modifications en attente revient. On
 *    préfère un Chat de trop à un Chat perdu.
 */
const relues = new Set<Collection>();
const CLE_A_POUSSER = `${PREFIX}sync:a-pousser`;

function enAttente(): Set<Collection> {
  try {
    const brut = localStorage.getItem(CLE_A_POUSSER);
    const liste = brut ? (JSON.parse(brut) as unknown) : [];
    return new Set(Array.isArray(liste) ? (liste.filter((c) => COLLECTIONS.includes(c as Collection)) as Collection[]) : []);
  } catch {
    return new Set();
  }
}

function noterEnAttente(collection: Collection, attente: boolean): void {
  if (JAMAIS_POUSSEES.includes(collection)) return;
  const ensemble = enAttente();
  if (attente === ensemble.has(collection)) return;
  if (attente) ensemble.add(collection);
  else ensemble.delete(collection);
  try {
    localStorage.setItem(CLE_A_POUSSER, JSON.stringify([...ensemble]));
  } catch {
    /* stockage refusé : la note ne survivra pas au redémarrage, la règle 1 protège encore */
  }
}

const aUnId = (o: unknown): o is AvecId => typeof o === "object" && o !== null && "id" in o;
type AvecId = { id: unknown; updatedAt?: unknown; modifieLe?: unknown };
const date = (v: unknown) => (typeof v === "string" ? Date.parse(v) || 0 : 0);
/** La modification la plus récente d'un élément : son contenu (`updatedAt`) ou le reste (`modifieLe`, sessions.ts). */
const quand = (o: AvecId) => Math.max(date(o.updatedAt), date(o.modifieLe));

/**
 * Fusion à trois : `depart` est ce que l'instance avait quand ce poste l'a lu
 * ou écrit la dernière fois. Ce qui en a disparu ici est une suppression faite
 * ici, et le reste ; ce qui y manquait et arrive de l'instance est un ajout
 * d'ailleurs, et entre. Sans état de départ (redémarrage avec des
 * modifications en attente), la fusion garde tout, comme avant.
 */
function fusionner(local: unknown, distant: unknown, depart?: unknown): unknown {
  // Les profils : un objet, une entrée par personne. Ce qui a changé ici l'emporte, le reste vient de l'instance.
  if (local && distant && typeof local === "object" && typeof distant === "object" && !Array.isArray(local) && !Array.isArray(distant)) {
    const base = depart && typeof depart === "object" && !Array.isArray(depart) ? (depart as Record<string, unknown>) : null;
    const resultat: Record<string, unknown> = { ...(distant as Record<string, unknown>) };
    for (const [cle, valeur] of Object.entries(local as Record<string, unknown>)) {
      if (!base || JSON.stringify(base[cle]) !== JSON.stringify(valeur)) resultat[cle] = valeur;
    }
    return resultat;
  }
  if (!Array.isArray(local) || !Array.isArray(distant)) return distant;
  const idsDe = (l: unknown) => new Set(Array.isArray(l) ? l.filter(aUnId).map((o) => o.id) : []);
  const avant = Array.isArray(depart) ? idsDe(depart) : null;
  const ici = idsDe(local);
  const resultat = distant.filter((o) => !(avant && aUnId(o) && avant.has(o.id) && !ici.has(o.id)));
  const position = new Map<unknown, number>();
  resultat.forEach((o, i) => {
    if (aUnId(o)) position.set(o.id, i);
  });
  /*
   * Un même élément des deux côtés : celui qui a changé depuis le départ
   * l'emporte (relecture du 27/09/2026). Ranger un Chat dans un projet ou
   * accepter une invitation ne touche pas `updatedAt` : à dates égales,
   * l'instance gagnait, et la modification faite ici disparaissait. Changé
   * des deux côtés, ou sans départ connu : le plus récent.
   */
  const departDe = new Map<unknown, string>();
  if (Array.isArray(depart)) for (const o of depart) if (aUnId(o)) departDe.set(o.id, JSON.stringify(o));
  for (const l of local) {
    if (!aUnId(l)) continue;
    const i = position.get(l.id);
    if (i === undefined) {
      resultat.push(l);
      continue;
    }
    const avantLui = departDe.get(l.id);
    const changeIci = avantLui !== undefined && JSON.stringify(l) !== avantLui;
    const changeEnFace = avantLui !== undefined && JSON.stringify(resultat[i]) !== avantLui;
    if (changeIci && !changeEnFace) resultat[i] = l;
    /*
     * Né depuis le départ connu et présent des deux côtés : c'est l'écho de ce
     * que ce poste a lui-même créé, et sa copie à lui est la plus avancée. À
     * dates égales, elle l'emporte (28/09/2026 : un Chat créé puis écrit dans
     * la même milliseconde perdait sa question face à sa propre copie vide).
     */
    else if (Array.isArray(depart) && avantLui === undefined ? quand(l) >= quand(resultat[i] as AvecId) : quand(l) > quand(resultat[i] as AvecId)) resultat[i] = l;
  }
  return resultat;
}

/** Collections fusionnées à la relecture : à repousser dès qu'elle est finie. */
const aRepousser = new Set<Collection>();

/** Tire une collection depuis l'instance vers le cache local. */
async function pull(collection: Collection): Promise<Tirage> {
  // Une écriture faite ici pendant la lecture est plus récente que ce que l'instance va rendre.
  const ecrituresAvant = ecrituresLocales.get(collection) ?? 0;
  let payload: { value: unknown; revision: number };
  try {
    const res = await apiFetch(`/oxoai/data/${collection}`);
    if (!res.ok) throw new Error(String(res.status));
    payload = (await res.json()) as { value: unknown; revision: number };
  } catch {
    // Fichier des Chats illisible : le bandeau (AvisChatsIllisibles) dit que l'instance n'a pas pu être relue.
    noterReleve(collection, "echec");
    return "echec";
  }
  if (payload.value === null) {
    revisions.set(collection, payload.revision);
    noterReleve(collection, "absente");
    relues.add(collection);
    return "absente";
  }
  // Les conversations et les agents partagés à un groupe se lisent selon les groupes de la personne : on les relit avec.
  if (collection === "sessions" || collection === "agents") await relireMesGroupes();
  /*
   * Écrite ici pendant que la lecture était en route (28/09/2026) : la copie
   * rendue par l'instance est plus ancienne que celle du poste. Elle est
   * fusionnée, comme une modification en attente, au lieu de la remplacer, puis
   * le résultat repart.
   */
  const ecritPendant = (ecrituresLocales.get(collection) ?? 0) !== ecrituresAvant;
  const enAttenteIci = ecritPendant || enAttente().has(collection);
  const valeur = enAttenteIci ? fusionner(readLocal(collection), payload.value, derniersConnus.get(collection)) : payload.value;
  if (!writeLocal(collection, valeur)) {
    /*
     * Rendue par l'instance, mais ce poste n'a pas pu la garder : il n'en a
     * toujours pas de copie sûre. La révision n'est pas retenue, pour que
     * `refresh` réessaie.
     */
    noterReleve(collection, "place");
    return "echec";
  }
  revisions.set(collection, payload.revision);
  derniersConnus.set(collection, payload.value);
  grandRelu(collection, Array.isArray(valeur) ? valeur.length : undefined);
  relues.add(collection);
  if (enAttenteIci) aRepousser.add(collection);
  return "tiree";
}

/** Groupes de la personne tels que la dernière relecture les a rendus, triés et joints. */
let groupesConnus: string | null = null;

/** Relit les groupes de la personne ; vrai s'ils ont changé depuis la dernière relecture. */
async function relireMesGroupes(): Promise<boolean> {
  try {
    const res = await apiFetch("/oxoai/groupes");
    if (!res.ok) return false;
    const { groupes } = (await res.json()) as { groupes: { id: string; estMembre: boolean }[] };
    const siens = groupes.filter((g) => g.estMembre).map((g) => g.id);
    retenirGroupes(siens);
    const signature = [...siens].sort().join(",");
    const change = groupesConnus !== null && groupesConnus !== signature;
    groupesConnus = signature;
    return change;
  } catch {
    /* hors ligne : les groupes connus restent */
    return false;
  }
}

/**
 * Une personne entrée dans un groupe, ou sortie, ne voit plus les mêmes
 * Chats ni les mêmes agents, sans que leur révision bouge sur l'instance :
 * les groupes sont relus toutes les quinze relèves (une minute), et ces deux
 * collections re-tirées s'ils ont changé.
 */
const RELEVES_PAR_GROUPES = 15;
let releves = 0;

/**
 * Collections que ce poste ne pousse jamais.
 *
 * Les comptes ne s'écrivent que par les routes d'authentification, qui seules
 * savent hacher un mot de passe et tenir le journal. L'instance refusait donc
 * la poussée avec un 403 à chaque création de compte : une erreur silencieuse,
 * répétée, et parfaitement inutile puisque le serveur a raison de refuser.
 * On les tire, on ne les renvoie pas.
 */
const JAMAIS_POUSSEES: Collection[] = ["accounts"];

/** Dernière poussée demandée pour chaque collection : l'instance l'a-t-elle prise ? */
const envois = new Map<Collection, Promise<boolean>>();

/**
 * L'instance a-t-elle pris la dernière poussée de cette collection ? Pour le
 * bilan d'un import (ImporterChats), quand ce poste n'a pas pu les garder.
 * Faux aussi quand rien n'est parti (hors ligne, fichier illisible).
 */
export function dernierEnvoi(collection: Collection): Promise<boolean> {
  return envois.get(collection) ?? Promise.resolve(false);
}

/*
 * Une poussée à la fois par collection, et les écritures faites pendant
 * qu'elle part (parcours du 28/09/2026).
 *
 * Mesuré : un Chat neuf écrit deux fois de suite, à sa création puis avec la
 * question, partait en deux PUT simultanés portant la même révision de départ.
 * L'instance prenait le premier et refusait le second (409) ; la relecture qui
 * suit fusionnait, et comme les deux copies du Chat avaient la même date à la
 * milliseconde, celle de l'instance, vide, l'emportait. La question disparaissait
 * du Chat, ici comme sur l'instance, et rechargée pendant la réponse, la page
 * rouvrait un Chat vide. Les poussées d'une collection partent désormais l'une
 * après l'autre, celles demandées pendant un envoi se regroupent en une seule,
 * qui lit la copie locale au moment de partir.
 */
const enVol = new Map<Collection, Promise<boolean>>();
const enFile = new Map<Collection, Promise<boolean>>();
/** Écritures locales demandées par collection : une relecture qui les voit changer ne remplace pas la copie du poste. */
const ecrituresLocales = new Map<Collection, number>();

function lancer(collection: Collection): Promise<boolean> {
  const envoi = pousser(collection).finally(() => {
    if (enVol.get(collection) === envoi) enVol.delete(collection);
  });
  enVol.set(collection, envoi);
  return envoi;
}

/** Pousse le cache local vers l'instance. */
export function push(collection: Collection): Promise<boolean> {
  ecrituresLocales.set(collection, (ecrituresLocales.get(collection) ?? 0) + 1);
  const courant = enVol.get(collection);
  /*
   * La file d'abord (relecture du 28/09/2026) : entre la fin d'un envoi (qui
   * retire `enVol`) et le départ de celui qui attendait (qui retire `enFile`),
   * quelques micro-tâches passent. Une écriture faite là voyait `enVol` vide et
   * lançait un second PUT en même temps que celui de la file : les deux
   * portaient la même révision, et l'un revenait en 409.
   */
  const dejaEnFile = enFile.get(collection);
  let envoi: Promise<boolean>;
  if (dejaEnFile) envoi = dejaEnFile;
  else if (!courant) envoi = lancer(collection);
  else {
    envoi =
      courant
        .catch(() => false)
        .then(() => {
          enFile.delete(collection);
          return lancer(collection);
        });
    enFile.set(collection, envoi);
  }
  envois.set(collection, envoi);
  return envoi;
}

async function pousser(collection: Collection, reprise = false): Promise<boolean> {
  if (JAMAIS_POUSSEES.includes(collection)) return false;
  /*
   * Hors ligne, la modification est notée en attente (28/09/2026, vu par
   * Medhi : « j'ai choisi qwen, il propose gpt nano encore »). Elle ne partait
   * pas, et rien ne le retenait : la relecture suivante (au lancement, à la
   * connexion) remettait la copie de l'instance, donc le choix d'avant ; un
   * Chat créé pendant ce temps disparaissait de même. Notée, elle est fusionnée
   * à la relecture et renvoyée au retour de l'instance (`refresh`).
   */
  if (!online) {
    noterEnAttente(collection, true);
    return false;
  }
  /*
   * Fichier des Chats illisible au démarrage (grandStockage.ts) : la copie
   * locale part d'une liste vide. La pousser effacerait tous les Chats de la
   * personne sur l'instance, qui n'y verrait qu'une suppression voulue. On
   * attend que l'instance ait rendu la collection (`pull`).
   */
  if (grandIllisible(collection) || !relues.has(collection)) {
    noterEnAttente(collection, true);
    return false;
  }
  const value = readLocal(collection);
  if (value === null) return false;
  pushing.add(collection);
  try {
    const res = await apiFetch(`/oxoai/data/${collection}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // La version relue en dernier : l'instance refuse si elle a changé depuis (index.ts, `base`).
      body: JSON.stringify({ value, ...(revisions.has(collection) ? { base: revisions.get(collection) } : {}) }),
    });
    /*
     * Un autre poste a écrit entre-temps (27/09/2026) : on relit, ce qui
     * fusionne ce que ce poste avait en attente, puis on renvoie, une fois.
     * Sans cela, ce que l'autre poste venait de créer disparaissait.
     */
    if (res.status === 409 && !reprise) {
      noterEnAttente(collection, true);
      pushing.delete(collection);
      const relue = await pull(collection);
      aRepousser.delete(collection);
      return relue === "tiree" ? pousser(collection, true) : false;
    }
    if (res.ok) {
      const payload = (await res.json()) as { revision: number };
      revisions.set(collection, payload.revision);
      // L'instance a pris cet envoi (fusionné avec ce que ce poste n'a pas le droit de toucher) : c'est le nouveau départ.
      derniersConnus.set(collection, value);
    }
    noterEnAttente(collection, !res.ok);
    // Même règle que la relève : une erreur de serveur dit l'instance injoignable, et son retour fera repartir l'envoi.
    if (res.status >= 500) online = false;
    return res.ok;
  } catch {
    online = false;
    noterEnAttente(collection, true);
    return false;
  } finally {
    pushing.delete(collection);
  }
}

/*
 * Sans séance, l'instance ne rend que la liste des comptes (écran de
 * connexion) : les autres collections répondent 401. Relevé le 27/09/2026 en
 * essayant l'écran de connexion : six requêtes refusées toutes les quatre
 * secondes, tant que personne ne se connectait, et, une fois connecté, une
 * liste de Chats vide jusqu'à la relève suivante. On ne les demande donc
 * qu'une séance ouverte, et `relireMaintenant` les relit dès la connexion.
 */
const lisible = (collection: Collection): boolean => collection === "accounts" || Boolean(sessionToken());

/** Relit tout de suite ce qui n'a pas encore été relu (une séance vient de s'ouvrir). */
export function relireMaintenant(): Promise<void> {
  return refresh();
}

/** Compare les révisions et re-tire ce qui a changé sur un autre poste. */
async function refresh(): Promise<void> {
  try {
    const res = await apiFetch(`/oxoai/data`);
    if (!res.ok) {
      /*
       * Une erreur de serveur ici vient de ce qui se tient devant l'instance
       * (proxy du serveur de développement, relais d'une instance d'entreprise)
       * quand elle ne répond plus : c'est une coupure, comme un réseau tombé
       * (parcours du 28/09/2026). Sans cela, `online` restait vrai, le retour
       * de l'instance passait inaperçu, et ce qui avait été modifié pendant la
       * coupure (un Chat renommé, une question) ne repartait jamais vers elle.
       */
      if (res.status >= 500) online = false;
      return;
    }
    const { revisions: remote } = (await res.json()) as {
      revisions: Record<Collection, number>;
    };

    const touched: Collection[] = [];
    const groupesChanges = ++releves % RELEVES_PAR_GROUPES === 0 && (await relireMesGroupes());
    const deRetour = !online;
    online = true;
    for (const collection of COLLECTIONS) {
      if (pushing.has(collection)) continue;
      if (!lisible(collection)) continue;
      const known = revisions.get(collection) ?? 0;
      const parGroupe = groupesChanges && (collection === "sessions" || collection === "agents");
      // Pas encore relue cette séance (instance injoignable au lancement) : on la relit, même sans changement en face.
      if ((remote[collection] ?? 0) > known || parGroupe || !relues.has(collection)) {
        const etat = await pull(collection);
        if (etat === "tiree") touched.push(collection);
        if (etat === "absente" && readLocal(collection) !== null) await push(collection);
      }
    }
    /*
     * L'instance répond de nouveau : ce qui a été modifié ici pendant son
     * absence repart (28/09/2026). Sans changement en face, rien n'était relu,
     * donc rien n'était renvoyé : le choix d'un modèle fait pendant un
     * redémarrage de la passerelle restait sur ce poste seul, et la relecture
     * suivante le défaisait. Seulement ce qui a déjà été relu cette séance :
     * pas de poussée à l'aveugle.
     */
    if (deRetour) for (const collection of enAttente()) if (relues.has(collection) && lisible(collection)) aRepousser.add(collection);
    if (touched.length > 0) announce(touched);
    await repousserFusions();
  } catch {
    online = false;
  }
}

/**
 * Démarre la synchronisation. Sans instance joignable, l'application continue
 * de fonctionner sur son cache local : c'est un confort, pas une dépendance.
 */
export async function startSync(): Promise<void> {
  try {
    const res = await apiFetch(`/oxoai/data`);
    if (!res.ok) throw new Error(String(res.status));
    online = true;
  } catch {
    online = false;
    // Fichier des Chats illisible : tant que l'instance ne répond pas, rien ne les rend, et le bandeau le dit.
    for (const collection of COLLECTIONS) noterReleve(collection, "hors-ligne");
    /*
     * La relève tourne quand même (28/09/2026). Elle ne démarrait qu'après un
     * premier échange réussi : une passerelle encore en train de démarrer à
     * l'ouverture de la fenêtre laissait toute la séance sans synchronisation
     * et, la personne étant restée connectée, rien ne la relançait (mesuré
     * dans une fenêtre cachée : vingt secondes après, toujours hors ligne).
     * `refresh` fait le premier échange dès que l'instance répond : chaque
     * collection y est relue, puisqu'aucune ne l'a été.
     */
    demarrerReleve();
    return;
  }

  /*
   * Premier échange : l'instance fait foi si elle a des données, sinon ce
   * poste l'amorce avec les siennes.
   *
   * ── Le piège, mesuré et corrigé ───────────────────────────────────────────
   *
   * Cette boucle poussait le cache local dès que la lecture **échouait**, sans
   * distinguer « l'instance n'a pas cette collection » de « l'instance a
   * refusé de répondre ». Un refus est pourtant le pire moment pour écrire :
   * on ne sait rien de ce qu'il y a en face, et le cache local peut être vide
   * — poste qui vient de changer d'origine, séance expirée, données jamais
   * tirées. Pousser une liste vide par-dessus une instance pleine efface les
   * conversations de la personne, et `authz.ts` ne s'y oppose pas : elle en
   * est propriétaire, c'est donc une suppression légitime à ses yeux.
   *
   * On n'amorce donc que sur « absente », jamais sur « échec ».
   */
  for (const collection of COLLECTIONS) {
    if (!lisible(collection)) continue;
    const etat = await pull(collection);
    if (etat === "absente" && readLocal(collection) !== null) await push(collection);
  }
  announce([...COLLECTIONS]);
  await repousserFusions();
  demarrerReleve();
}

function demarrerReleve(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refresh(), POLL_MS);
}

/** Ce qui a été fusionné à la relecture repart vers l'instance, qui n'en avait qu'une partie. */
async function repousserFusions(): Promise<void> {
  for (const collection of [...aRepousser]) {
    aRepousser.delete(collection);
    await push(collection);
  }
}

export function stopSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
