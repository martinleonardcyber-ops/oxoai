import type { Collection } from "./db.ts";
import { competenceAcceptable, voitCompetence } from "./competencesRegles.ts";

/**
 * Cloisonnement des données, côté instance.
 *
 * Jusqu'ici l'interface décidait seule de ce qu'elle montrait : n'importe quel
 * poste légitime pouvait demander la collection entière et lire les projets,
 * les conversations et les tâches de tous ses collègues. La règle est
 * désormais appliquée ici, à l'endroit qui détient les données.
 *
 * Deux opérations symétriques :
 *  - `filtrer` : ce que la personne a le droit de **voir** ;
 *  - `fusionner` : ce qu'elle a le droit de **modifier**. Les postes envoient
 *    la collection entière ; on ne garde de leur envoi que les enregistrements
 *    qui les concernent, et on conserve les autres tels qu'ils étaient. Sans
 *    cela, un poste pourrait effacer le travail de toute l'entreprise en
 *    poussant une liste vide.
 */

export interface Demandeur {
  userId: string;
  email: string;
  /** Groupes dont la personne est membre (groupes.ts) : ce qu'on leur partage, elle le voit. */
  groupes?: string[];
}

/** La conversation est-elle partagée avec un des groupes de la personne ? */
const partageeAuGroupe = (s: Record<string, unknown>, qui: Demandeur) =>
  Array.isArray(s.sharedGroupIds) && s.sharedGroupIds.some((g) => typeof g === "string" && (qui.groupes ?? []).includes(g));

/** Un objet nu, par opposition à `null`, un tableau ou une valeur scalaire. */
const estEnregistrement = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/*
 * Un poste envoie ce qu'il veut, y compris `[null]` ou `[1, 2]`. Le tableau
 * était pris tel quel, et `String(item.id)` sur `null` faisait échouer la
 * requête en 500 — avec le message d'exception interne renvoyé au client.
 * Ce qui n'est pas un enregistrement n'en devient pas un : on l'écarte ici,
 * une fois, plutôt que de garder chaque règle sur ses gardes.
 */
const tableau = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(estEnregistrement) : [];

/** Sac de profils indexé par personne, ou sac vide si l'envoi n'en est pas un. */
const sacProfils = (value: unknown): Record<string, unknown> =>
  estEnregistrement(value) ? value : {};

const memeEmail = (a: unknown, b: string) =>
  typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/* ------------------------------------------------------------------ */
/* Règles de visibilité                                                */
/* ------------------------------------------------------------------ */

function voitProjet(projet: Record<string, unknown>, qui: Demandeur): boolean {
  if (projet.ownerId === qui.userId) return true;
  const membres = Array.isArray(projet.members) ? projet.members : [];
  return membres.some(
    (m) =>
      (m as { userId?: string }).userId === qui.userId ||
      memeEmail((m as { email?: string }).email, qui.email),
  );
}

/**
 * Exportée pour les images créées dans un Chat (images.ts) : elles se
 * montrent à qui voit le Chat, selon cette même règle et aucune autre.
 */
export function voitConversation(session: Record<string, unknown>, qui: Demandeur): boolean {
  if (session.ownerId === qui.userId) return true;
  const partages = Array.isArray(session.sharedWith) ? session.sharedWith : [];
  if (
    partages.some(
      (p) =>
        (p as { userId?: string }).userId === qui.userId ||
        memeEmail((p as { email?: string }).email, qui.email),
    )
  ) {
    return true;
  }
  if (partageeAuGroupe(session, qui)) return true;
  // Une conversation ouverte à l'organisation est lisible par tous.
  return session.visibility === "organisation";
}

/**
 * Un agent : son auteur, tout le monde s'il est d'organisation, et, partagé à
 * des groupes (ajouté le 25/09/2026), les membres de l'un de ces groupes à
 * l'instant de la demande. Sorti du groupe, on ne le reçoit plus.
 */
function voitAgent(agent: Record<string, unknown>, qui: Demandeur): boolean {
  if (agent.ownerId === qui.userId || agent.visibility === "organisation") return true;
  return (
    agent.visibility === "groupes" &&
    Array.isArray(agent.groupIds) &&
    agent.groupIds.some((g) => typeof g === "string" && (qui.groupes ?? []).includes(g))
  );
}

/**
 * Un agent ne se partage qu'aux groupes dont son auteur est membre (même
 * règle que la Bibliothèque) ; ceux qu'il avait déjà restent, pour qu'un
 * auteur sorti d'un groupe ne le lui retire pas sans le vouloir.
 */
/**
 * La photo d'un agent (27/09/2026) : une image intégrée, JPEG, PNG ou WebP,
 * de taille raisonnable, et rien d'autre. Elle voyage vers chaque poste qui
 * voit l'agent : une adresse ou un texte de plusieurs mégaoctets n'y passent pas.
 */
const PHOTO_AGENT = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function sansPhotoDouteuse(agent: Record<string, unknown>): Record<string, unknown> {
  if (agent.photo === undefined) return agent;
  if (typeof agent.photo === "string" && agent.photo.length < 200_000 && PHOTO_AGENT.test(agent.photo)) return agent;
  const { photo: _p, ...reste } = agent;
  return reste;
}

function groupesDeLAgent(avant: Record<string, unknown> | undefined, brut: Record<string, unknown>, qui: Demandeur): Record<string, unknown> {
  const envoye = sansPhotoDouteuse(brut);
  if (!Array.isArray(envoye.groupIds)) return envoye;
  const deja = Array.isArray(avant?.groupIds) ? avant.groupIds : [];
  const groupIds = [...new Set(envoye.groupIds.filter((g): g is string => typeof g === "string" && (deja.includes(g) || (qui.groupes ?? []).includes(g))))];
  return { ...envoye, groupIds };
}

/** Une tâche appartient à une personne ; rien ne la partage aujourd'hui. */
const voitTache = (tache: Record<string, unknown>, qui: Demandeur) =>
  tache.ownerId === qui.userId;

/* ------------------------------------------------------------------ */
/* Règles de modification                                              */
/* ------------------------------------------------------------------ */

/*
 * Voir n'est pas modifier. Un agent d'organisation est lisible par tous mais
 * n'appartient qu'à son auteur ; une conversation partagée reste sous la
 * responsabilité de celui qui l'a ouverte.
 */
const modifieProjet = voitProjet; // membre d'un projet : il y travaille
const modifieConversation = (s: Record<string, unknown>, qui: Demandeur) =>
  s.ownerId === qui.userId ||
  partageeAuGroupe(s, qui) ||
  (Array.isArray(s.sharedWith) &&
    s.sharedWith.some(
      (p) =>
        (p as { userId?: string }).userId === qui.userId ||
        memeEmail((p as { email?: string }).email, qui.email),
    ));
const estProprietaire = (item: Record<string, unknown>, qui: Demandeur) =>
  item.ownerId === qui.userId;

/**
 * Ce qu'une personne à qui l'on a partagé une conversation peut y changer :
 * son contenu, pas la liste de ceux qui la voient. Sans cette règle, un
 * invité pouvait l'ouvrir à un autre groupe, ou en retirer les autres
 * invités. Une seule exception : sa **propre** invitation, qu'il accepte en
 * s'y rattachant (`claimSessionShares`, côté poste).
 */
function partageDuProprietaire(
  avant: Record<string, unknown>,
  envoye: Record<string, unknown>,
  qui: Demandeur,
): Record<string, unknown> {
  const concerne = (p: unknown) =>
    (p as { userId?: string }).userId === qui.userId || memeEmail((p as { email?: string }).email, qui.email);
  const anciens = Array.isArray(avant.sharedWith) ? avant.sharedWith : [];
  const nouveaux = Array.isArray(envoye.sharedWith) ? envoye.sharedWith : [];
  const aMoi = anciens.some(concerne);
  const monEntree = nouveaux.find(
    (p) => concerne(p) && estEnregistrement(p) && memeEmail(p.email, String((anciens.find(concerne) as { email?: string } | undefined)?.email ?? "")),
  );
  const partages = anciens.map((p) => (concerne(p) && aMoi && monEntree ? { ...(monEntree as object), userId: qui.userId } : p));
  /*
   * Les bases de connaissances et le classement restent ceux de la
   * propriétaire (revue du 26/09/2026) : un invité qui y mettait l'identifiant
   * d'une base qu'elle seule voit faisait entrer ses passages dans la
   * conversation partagée, dès qu'elle y écrivait de nouveau.
   */
  const { sharedWith: _s, sharedGroupIds: _g, visibility: _v, connaissances: _k, projectId: _p, ...reste } = envoye;
  return {
    ...reste,
    ...(avant.sharedWith !== undefined ? { sharedWith: partages } : {}),
    ...(avant.sharedGroupIds !== undefined ? { sharedGroupIds: avant.sharedGroupIds } : {}),
    ...(avant.visibility !== undefined ? { visibility: avant.visibility } : {}),
    ...(avant.connaissances !== undefined ? { connaissances: avant.connaissances } : {}),
    ...(avant.projectId !== undefined ? { projectId: avant.projectId } : {}),
  };
}

/**
 * Ce qu'un membre (non propriétaire) peut changer à un projet : son contenu,
 * pas qui en fait partie, ni ses bases de connaissances. Revue du 26/09/2026 :
 * un membre pouvait retirer un collègue et y ajouter quelqu'un du dehors, ce
 * que l'écran réserve au propriétaire. Une exception, comme pour un Chat
 * partagé : sa propre invitation, qu'il accepte (statut, identifiant), sans
 * changer son rôle.
 */
function projetDuProprietaire(
  avant: Record<string, unknown>,
  envoye: Record<string, unknown>,
  qui: Demandeur,
): Record<string, unknown> {
  const concerne = (m: unknown) =>
    (m as { userId?: string }).userId === qui.userId || memeEmail((m as { email?: string }).email, qui.email);
  const anciens = Array.isArray(avant.members) ? avant.members : [];
  const nouveaux = Array.isArray(envoye.members) ? envoye.members : [];
  const monAncienne = anciens.find(concerne) as Record<string, unknown> | undefined;
  const maNouvelle = nouveaux.find((m) => concerne(m) && estEnregistrement(m)) as Record<string, unknown> | undefined;
  const membres = anciens.map((m) =>
    monAncienne && m === monAncienne && maNouvelle
      ? { ...monAncienne, status: maNouvelle.status ?? monAncienne.status, userId: qui.userId }
      : m,
  );
  const { members: _m, connaissances: _k, ...reste } = envoye;
  return {
    ...reste,
    members: membres,
    ...(avant.connaissances !== undefined ? { connaissances: avant.connaissances } : {}),
  };
}

interface Regle {
  voit: (item: Record<string, unknown>, qui: Demandeur) => boolean;
  modifie: (item: Record<string, unknown>, qui: Demandeur) => boolean;
  /**
   * Supprimer n'est pas modifier : un collaborateur travaille dans un projet
   * partagé, il n'a pas à le faire disparaître pour tout le monde. Ce droit
   * reste au propriétaire.
   */
  supprime: (item: Record<string, unknown>, qui: Demandeur) => boolean;
  /**
   * Forme et bornes d'un enregistrement envoyé (23/10/2026, les compétences) :
   * hors bornes, il est refusé comme un enregistrement d'autrui, et l'ancien
   * reste. Jamais tronqué.
   */
  valide?: (item: Record<string, unknown>) => boolean;
}

const REGLES: Partial<Record<Collection, Regle>> = {
  projects: { voit: voitProjet, modifie: modifieProjet, supprime: estProprietaire },
  sessions: { voit: voitConversation, modifie: modifieConversation, supprime: estProprietaire },
  agents: { voit: voitAgent, modifie: estProprietaire, supprime: estProprietaire },
  tasks: { voit: voitTache, modifie: estProprietaire, supprime: estProprietaire },
  /*
   * Même règle qu'un agent : lisible par toute l'organisation si son auteur l'a
   * voulu, modifiable par lui seul. Une procédure que chacun pourrait réécrire
   * ne serait plus une procédure. Lue sur son propre champ (`visibilite`,
   * competencesRegles.ts) depuis le 23/10/2026 : celui des agents
   * (`visibility`) n'y est pas, et une compétence partagée ne partait chez
   * personne.
   */
  competences: {
    voit: (item, qui) => voitCompetence(item, qui.userId),
    modifie: estProprietaire,
    supprime: estProprietaire,
    valide: competenceAcceptable,
  },
};

/** Clé du profil d'une personne, tel que les postes l'envoient. */
const cleProfil = (userId: string) => `profile:${userId}`;

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/** Ce que `qui` a le droit de voir dans une collection. */
export function filtrer(collection: Collection, valeur: unknown, qui: Demandeur): unknown {
  if (collection === "accounts") return valeur; // déjà expurgé en amont

  if (collection === "profiles") {
    // Le profil porte les instructions et la mémoire personnelles : il ne sort
    // jamais de son propriétaire, même vers un collègue du même projet.
    const sac = sacProfils(valeur);
    const cle = cleProfil(qui.userId);
    return cle in sac ? { [cle]: sac[cle] } : {};
  }

  const regle = REGLES[collection];
  if (!regle) return valeur;
  const vus = tableau(valeur).filter((item) => regle.voit(item, qui));
  /*
   * Les instructions d'un agent partagé que son auteur a masquées ne partent
   * pas vers les postes des autres (27/09/2026) : leur copie arrive sans, et
   * l'instance les ajoute au Chat elle-même (instructionsAgents.ts).
   */
  if (collection === "agents") {
    return vus.map((a) => (a.hidePrompt === true && a.ownerId !== qui.userId ? { ...a, instructions: "", instructionsMasquees: true } : a));
  }
  return vus;
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

export interface Fusion {
  valeur: unknown;
  /** Enregistrements refusés, pour la trace : utile au diagnostic et à l'audit. */
  refuses: number;
}

/**
 * Applique l'envoi d'un poste sans lui laisser toucher ce qui ne le regarde pas.
 *
 * - un enregistrement qu'il ne peut pas voir est conservé tel quel ;
 * - un enregistrement qu'il peut modifier prend la valeur qu'il envoie ;
 * - un enregistrement nouveau n'est accepté que s'il lui appartiendrait ;
 * - un enregistrement visible mais absent de l'envoi est considéré supprimé,
 *   à condition qu'il ait eu le droit de le supprimer.
 */
export function fusionner(
  collection: Collection,
  existant: unknown,
  entrant: unknown,
  qui: Demandeur,
): Fusion {
  if (collection === "profiles") {
    const avant = sacProfils(existant);
    const apres = sacProfils(entrant);
    const cle = cleProfil(qui.userId);
    const refuses = Object.keys(apres).filter((k) => k !== cle).length;
    // Seul son propre profil est repris ; ceux des autres restent intacts.
    return {
      valeur: cle in apres ? { ...avant, [cle]: apres[cle] } : avant,
      refuses,
    };
  }

  const regle = REGLES[collection];
  if (!regle) return { valeur: entrant, refuses: 0 };

  const avant = tableau(existant);
  const apres = tableau(entrant);
  const parId = (liste: Record<string, unknown>[]) =>
    new Map(liste.map((item) => [String(item.id), item]));

  const avantParId = parId(avant);
  const apresParId = parId(apres);
  let refuses = 0;

  const resultat: Record<string, unknown>[] = [];

  // 1. Le sort de chaque enregistrement déjà présent.
  for (const item of avant) {
    const id = String(item.id);
    const envoye = apresParId.get(id);

    if (!envoye) {
      // Absent de l'envoi : suppression, réservée au propriétaire. Un poste qui
      // n'a simplement pas encore reçu l'enregistrement ne doit rien effacer.
      if (regle.supprime(item, qui)) continue;
      resultat.push(item);
      continue;
    }

    if (!regle.modifie(item, qui) || (regle.valide && !regle.valide(envoye))) {
      resultat.push(item);
      if (JSON.stringify(envoye) !== JSON.stringify(item)) refuses += 1;
      continue;
    }

    /*
     * Un collaborateur peut modifier le contenu, pas se l'approprier :
     * le propriétaire reste celui d'origine, quoi que le poste envoie.
     */
    if (regle.supprime(item, qui)) {
      resultat.push(collection === "agents" ? groupesDeLAgent(item, envoye, qui) : envoye);
      continue;
    }
    const retouche =
      collection === "sessions"
        ? partageDuProprietaire(item, envoye, qui)
        : collection === "projects"
          ? projetDuProprietaire(item, envoye, qui)
          : envoye;
    resultat.push({ ...retouche, ownerId: item.ownerId });
  }

  /*
   * 2. Les nouveaux enregistrements, s'ils lui appartiennent bien : à son nom,
   * et à son nom seulement. Revue du 26/09/2026 : il suffisait de se mettre
   * dans `sharedWith` (ou `members`) pour créer un Chat « de » quelqu'un
   * d'autre, messages inventés compris, que toute l'équipe voyait comme le
   * sien ; et la copie d'un collègue remettait les Chats d'un compte effacé,
   * que personne ne pouvait plus supprimer.
   */
  for (const item of apres) {
    if (avantParId.has(String(item.id))) continue;
    if (item.ownerId === qui.userId && regle.modifie(item, qui) && (!regle.valide || regle.valide(item))) resultat.push(collection === "agents" ? groupesDeLAgent(undefined, item, qui) : item);
    else refuses += 1;
  }

  return { valeur: resultat, refuses };
}
