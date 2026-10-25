import { storage, newId } from "./storage";
import type { User } from "./identity";
import { loadProfile, saveProfile } from "./profile";
import { t } from "@/lib/i18n";

/**
 * Compétences : des manières de faire écrites une fois, appliquées ensuite.
 *
 * ── Ce que c'est, et ce que ce n'est pas ────────────────────────────────────
 *
 * Une compétence n'est **pas** un outil. Les outils, ce sont les connecteurs :
 * du code qui lit un fichier, envoie un mail, ouvre une page. Une compétence
 * est une **manière de s'y prendre**, que le modèle lit et suit : « voici
 * comment on rédige un compte rendu de visite chez nous », « voici les
 * mentions obligatoires d'un devis ». ADR-043.
 *
 * ── Comment elle est utilisée, depuis le 23/10/2026 ────────────────────────
 *
 * L'écran ne la recopie plus dans ses consignes. C'est l'instance qui l'ajoute
 * au moment d'appeler le modèle (gateway/src/competences.ts), pour le Chat,
 * Cowork, Code, les tâches et les employés : toutes en entier si elles
 * tiennent dans la place du modèle, sinon le nom et la phrase « quand » de
 * chacune, et le texte complet de celles qui correspondent à la demande.
 * L'écran se contente de dire `competences: true` (useChat, taskRunner).
 *
 * ── Ce qui a changé le 23/10/2026 ──────────────────────────────────────────
 *
 * Demandé par Medhi : « un système de skills, la possibilité pour les gens de
 * créer leurs skills ». Un écran à elles (Réglages, IA et modèles), des
 * fichiers joints (modèles, exemples), l'import et l'export au format
 * SKILL.md (competencesFichier.ts), des exemples à ajouter, et un
 * interrupteur personnel pour celles d'un collègue.
 */

export type VisibiliteCompetence = "personnel" | "organisation";

/** Un fichier joint : un modèle de document, un exemple. Du texte, jamais exécuté. */
export interface FichierCompetence {
  nom: string;
  contenu: string;
}

export interface Competence {
  id: string;
  nom: string;
  /** Quand s'en servir : c'est là-dessus que le modèle décide, et que l'instance la retrouve. */
  quand: string;
  /** La manière de faire elle-même. */
  instructions: string;
  /** Allumée par son autrice. Une compétence inactive est conservée mais n'est plus envoyée au modèle. */
  active: boolean;
  visibilite: VisibiliteCompetence;
  ownerId: string;
  organisationId: string;
  createdAt: string;
  updatedAt: string;
  /** Au plus cinq fichiers texte (23/10/2026). */
  fichiers?: FichierCompetence[];
  /** D'où elle vient : un fichier importé, un exemple ajouté, ou écrite ici (absent). */
  origine?: "importee" | "exemple";
}

/**
 * Bornes, les mêmes que l'instance (gateway/src/competencesRegles.ts,
 * `BORNES_COMPETENCE`) : une compétence qui les dépasse y serait refusée, et
 * la copie de ce poste ne s'enregistrerait jamais. L'écran les applique avant.
 */
export const BORNES = {
  nom: 80,
  quand: 300,
  instructions: 12_000,
  fichiers: 5,
  nomFichier: 120,
  fichier: 20_000,
  total: 60_000,
} as const;

const CLE = "competences";

function toutes(): Competence[] {
  const brut = storage.get<Competence[]>(CLE, []);
  // Une collection synchronisée peut arriver abîmée d'un poste plus ancien.
  return Array.isArray(brut) ? brut.filter((c) => c && typeof c.id === "string") : [];
}

function ecrire(liste: Competence[]): void {
  storage.set(CLE, liste);
}

/** Les siennes, plus celles publiées dans l'organisation. */
export function competencesVisibles(user: User): Competence[] {
  return toutes()
    .filter(
      (c) =>
        c.ownerId === user.id ||
        (c.visibilite === "organisation" && c.organisationId === user.organisationId),
    )
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

export function competence(id: string): Competence | undefined {
  return toutes().find((c) => c.id === id);
}

/** Taille d'une compétence, telle que l'instance la mesure. */
export function tailleCompetence(c: Pick<Competence, "nom" | "quand" | "instructions" | "fichiers">): number {
  return c.nom.length + c.quand.length + c.instructions.length + (c.fichiers ?? []).reduce((n, f) => n + f.nom.length + f.contenu.length, 0);
}

/** Ce qui empêche d'enregistrer, ou null. Les mêmes règles que l'instance. */
export function problemeCompetence(c: Pick<Competence, "nom" | "quand" | "instructions" | "fichiers">): string | null {
  if (!c.nom.trim()) return t("Donnez un nom à la compétence.");
  if (!c.instructions.trim()) return t("Écrivez la manière de faire.");
  if (c.nom.length > BORNES.nom) return t("Le nom est trop long.");
  if (c.quand.length > BORNES.quand) return t("La phrase « quand s'en servir » est trop longue.");
  if (c.instructions.length > BORNES.instructions) return t("La manière de faire est trop longue.");
  const fichiers = c.fichiers ?? [];
  if (fichiers.length > BORNES.fichiers) return t("Cinq fichiers joints au plus.");
  for (const f of fichiers) {
    if (!nomDeFichierValide(f.nom)) return t("Un fichier joint a un nom invalide.");
    if (f.contenu.length > BORNES.fichier) return t("Un fichier joint est trop long.");
  }
  if (tailleCompetence(c) > BORNES.total) return t("La compétence est trop longue, fichiers compris.");
  return null;
}

/** Un nom de fichier joint n'est qu'une étiquette : ni chemin, ni caractère de contrôle. */
export function nomDeFichierValide(nom: string): boolean {
  return nom.trim() !== "" && nom.length <= BORNES.nomFichier && !/[\\/\u0000-\u001f]/.test(nom) && !/^\.+$/.test(nom.trim());
}

export type DonneesCompetence = Pick<Competence, "nom" | "quand" | "instructions" | "visibilite"> &
  Partial<Pick<Competence, "fichiers" | "origine" | "active">>;

export function creerCompetence(proprietaire: User, donnees: DonneesCompetence): Competence {
  const maintenant = new Date().toISOString();
  const nouvelle: Competence = {
    id: newId(),
    nom: donnees.nom.trim() || t("Compétence sans nom"),
    quand: donnees.quand.trim(),
    instructions: donnees.instructions.trim(),
    active: donnees.active ?? true,
    visibilite: donnees.visibilite,
    ownerId: proprietaire.id,
    organisationId: proprietaire.organisationId,
    createdAt: maintenant,
    updatedAt: maintenant,
    ...(donnees.fichiers && donnees.fichiers.length > 0 ? { fichiers: donnees.fichiers } : {}),
    ...(donnees.origine ? { origine: donnees.origine } : {}),
  };
  ecrire([nouvelle, ...toutes()]);
  return nouvelle;
}

export function modifierCompetence(id: string, changements: Partial<Competence>): void {
  ecrire(
    toutes().map((c) =>
      c.id === id ? { ...c, ...changements, updatedAt: new Date().toISOString() } : c,
    ),
  );
}

export function supprimerCompetence(id: string): void {
  ecrire(toutes().filter((c) => c.id !== id));
}

/* ---- Allumée pour moi ---------------------------------------------------- */

/**
 * Une compétence sert-elle pour cette personne ? La sienne : son interrupteur.
 * Celle d'un collègue : allumée par lui, et pas éteinte par elle (son profil).
 * Jusqu'au 23/10/2026, l'interrupteur d'une compétence partagée écrivait dans
 * la compétence du collègue, ce que l'instance refusait sans rien dire.
 */
export function allumeePour(c: Competence, user: User): boolean {
  if (!c.active) return false;
  if (c.ownerId === user.id) return true;
  return !(loadProfile(user.id).competencesEteintes ?? []).includes(c.id);
}

export function basculerPourMoi(c: Competence, user: User, allumer: boolean): void {
  if (c.ownerId === user.id) {
    modifierCompetence(c.id, { active: allumer });
    return;
  }
  const profil = loadProfile(user.id);
  const avant = new Set(profil.competencesEteintes ?? []);
  if (allumer) avant.delete(c.id);
  else avant.add(c.id);
  saveProfile({ ...profil, competencesEteintes: [...avant] });
  window.dispatchEvent(new Event("oxoai:profile-changed"));
}

/* ---- Exemples ------------------------------------------------------------ */

export interface ExempleCompetence {
  cle: string;
  nom: string;
  quand: string;
  instructions: string;
}

/**
 * Trois exemples, proposés à l'ajout et jamais imposés : la personne les
 * ajoute d'un clic (désactivés, pour qu'elle les relise avant), puis les
 * adapte. Sans marque, écrits pour n'importe quelle entreprise.
 */
export function exemplesDeCompetences(): ExempleCompetence[] {
  return [
    {
      cle: "compte-rendu-reunion",
      nom: t("Compte rendu de réunion"),
      quand: t("Quand on me demande le compte rendu d'une réunion, à partir de notes ou d'une transcription"),
      instructions: [
        t("1. En tête : l'objet de la réunion, la date, les personnes présentes."),
        t("2. Trois parties, dans cet ordre : ce qui a été dit, ce qui a été décidé, ce qui reste à faire."),
        t("3. Chaque point à faire porte un responsable et une échéance ; s'ils manquent, écrire « à préciser »."),
        t("4. Phrases courtes, sans jugement sur les personnes."),
        t("5. Ne jamais inventer un chiffre ou une décision : ce qui n'est pas dans les notes n'est pas dans le compte rendu."),
      ].join("\n"),
    },
    {
      cle: "relecture-texte",
      nom: t("Relecture d'un texte"),
      quand: t("Quand on me demande de relire, corriger ou améliorer un texte"),
      instructions: [
        t("1. Corriger l'orthographe, la grammaire et la ponctuation, sans changer le sens."),
        t("2. Garder le ton et le niveau de langue de l'auteur."),
        t("3. Rendre d'abord le texte corrigé en entier, puis une courte liste des changements importants."),
        t("4. Signaler ce qui semble faux ou ambigu sans le réécrire de son propre chef."),
      ].join("\n"),
    },
    {
      cle: "mail-relance",
      nom: t("Mail de relance poli"),
      quand: t("Quand on me demande de relancer quelqu'un par mail, pour une réponse, un paiement ou un document attendu"),
      instructions: [
        t("1. Objet court et clair, qui rappelle le sujet."),
        t("2. Rappeler en une phrase la demande initiale et sa date."),
        t("3. Dire précisément ce qui est attendu, et pour quand."),
        t("4. Ton courtois, sans reproche ; proposer son aide si quelque chose bloque."),
        t("5. Préparer un brouillon : ne jamais l'envoyer sans qu'on le demande."),
      ].join("\n"),
    },
  ];
}
